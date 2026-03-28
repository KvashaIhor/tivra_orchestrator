import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { BuildState, AgentEvent, EmitFn, BuildRequestSchema, BuildCredentialOverrides } from './types/spec';
import { parsePromptToSpec } from './agents/specParser';
import { provisionBackend } from './agents/backendProvisioner';
import { generateCode } from './agents/codeGenerator';
import { deployApp } from './agents/deployer';
import { log } from './utils/log';
import { runWithBuildCredentials } from './runtime/buildCredentials';

const app = express();
app.use(express.json());

// Request logging middleware
app.use((req, _res, next) => {
  log.info(`${req.method} ${req.url}`);
  next();
});

// Allow demo-ui (Next.js dev on :3000) to call this server
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN ?? 'http://localhost:3000');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ---------------------------------------------------------------------------
// In-memory build store (fine for a hackathon)
// ---------------------------------------------------------------------------

const builds = new Map<string, BuildState>();
const sseClients = new Map<string, Response[]>();

function sanitizeUserMessage(message: string): string {
  return message
    .replace(/\b[Cc]laude\b/g, 'the model')
    .replace(/\bANTHROPIC_API_KEY\b/g, 'AI_API_KEY');
}

function sanitizeEventMessage(event: AgentEvent): AgentEvent {
  return {
    ...event,
    message: sanitizeUserMessage(event.message),
  };
}

function broadcast(buildId: string, event: AgentEvent): void {
  const clients = sseClients.get(buildId) ?? [];
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    client.write(data);
    if (event.step === 'app_deployed' || event.step === 'error') {
      client.end();
    }
  }
}

// ---------------------------------------------------------------------------
// POST /api/build  — start pipeline
// ---------------------------------------------------------------------------

app.post('/api/build', async (req: Request, res: Response) => {
  const parsed = BuildRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid payload: prompt is required (min 5 chars)' });
    return;
  }

  const prompt = parsed.data.prompt.trim();
  const credentials = Object.fromEntries(
    Object.entries(parsed.data.credentials ?? {}).filter(([, value]) => typeof value === 'string' && value.trim().length > 0),
  ) as BuildCredentialOverrides;

  const buildId = crypto.randomUUID();
  const state: BuildState = { id: buildId, status: 'pending', events: [] };
  builds.set(buildId, state);

  log.info(`Build started [${buildId}] prompt="${prompt.slice(0, 80)}"`);
  res.json({ buildId });

  // Run pipeline async
  runPipeline(buildId, prompt, credentials).catch((err) => {
    const rawMsg = String(err?.message ?? err);
    const msg = sanitizeUserMessage(rawMsg);
    log.error(`Pipeline failed [${buildId}]`, { error: msg });
    const event: AgentEvent = {
      step: 'error',
      message: msg,
      ts: Date.now(),
    };
    state.status = 'error';
    state.error = event.message;
    state.events.push(event);
    broadcast(buildId, event);
  });
});

// ---------------------------------------------------------------------------
// GET /api/build/:buildId/stream  — SSE
// ---------------------------------------------------------------------------

app.get('/api/build/:buildId/stream', (req: Request, res: Response) => {
  const { buildId } = req.params;
  const state = builds.get(buildId);

  if (!state) {
    res.status(404).json({ error: 'Build not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay events already emitted
  for (const event of state.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  if (state.status === 'done' || state.status === 'error') {
    res.end();
    return;
  }

  const clients = sseClients.get(buildId) ?? [];
  clients.push(res);
  sseClients.set(buildId, clients);

  req.on('close', () => {
    const remaining = (sseClients.get(buildId) ?? []).filter((c) => c !== res);
    sseClients.set(buildId, remaining);
  });
});

// ---------------------------------------------------------------------------
// GET /api/health  — smoke-test endpoint
// ---------------------------------------------------------------------------

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', builds: builds.size });
});

// ---------------------------------------------------------------------------
// GET /api/build/:buildId  — poll state
// ---------------------------------------------------------------------------

app.get('/api/build/:buildId', (req: Request, res: Response) => {
  const state = builds.get(req.params.buildId);
  if (!state) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(state);
});

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

async function runPipeline(
  buildId: string,
  prompt: string,
  credentials: BuildCredentialOverrides,
): Promise<void> {
  const state = builds.get(buildId)!;
  state.status = 'running';

  const emit: EmitFn = (event) => {
    const userEvent = sanitizeEventMessage(event);
    log.step(`[${buildId}] [${userEvent.step}] ${userEvent.message}`);
    state.events.push(userEvent);
    broadcast(buildId, userEvent);
  };

  await runWithBuildCredentials(credentials, async () => {
    // 1. Parse spec
    emit({ step: 'spec_parsed', message: 'Parsing your idea into a spec…', ts: Date.now() });
    const spec = await parsePromptToSpec(prompt);
    state.spec = spec;
    emit({
      step: 'spec_parsed',
      message: `Spec ready: "${spec.name}" (${spec.template})`,
      data: { spec },
      ts: Date.now(),
    });

    // 2. Provision backend
    const backendConfig = await provisionBackend(spec, emit);
    state.backendConfig = backendConfig;

    // 3. Generate code
    await generateCode(spec, backendConfig, emit);

    // 4. Deploy
    const deployedUrl = await deployApp(spec, emit);
    state.deployedUrl = deployedUrl;

    // Notify UI immediately when deployment succeeds.
    emit({
      step: 'app_deployed',
      message: `Your app is live at ${deployedUrl}`,
      data: { url: deployedUrl },
      ts: Date.now(),
    });

    state.status = 'done';
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`Tivra Orchestrator listening on http://localhost:${PORT}`);
});
