import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BuildState, AgentEvent, EmitFn, BuildRequestSchema, BuildCredentialOverrides } from './types/spec';
import { parsePromptToSpec } from './agents/specParser';
import { provisionBackend } from './agents/backendProvisioner';
import { generateCode } from './agents/codeGenerator';
import { deployApp } from './agents/deployer';
import { log } from './utils/log';
import { runWithBuildCredentials } from './runtime/buildCredentials';

// ---------------------------------------------------------------------------
// Bootstrap InsForge CLI credentials from env vars (for headless server environments like Render).
// If INSFORGE_ACCESS_TOKEN is set, write it to ~/.config/insforge/credentials.json so the CLI
// can use it without prompting for browser OAuth. The CLI will auto-refresh using the refresh token
// if INSFORGE_REFRESH_TOKEN is also provided.
// ---------------------------------------------------------------------------
(function bootstrapInsforgeCredentials() {
  const accessToken = process.env.INSFORGE_ACCESS_TOKEN?.trim();
  const refreshToken = process.env.INSFORGE_REFRESH_TOKEN?.trim();
  if (!accessToken && !refreshToken) return;

  const credDir = path.join(os.homedir(), '.config', 'insforge');
  const credFile = path.join(credDir, 'credentials.json');

  try {
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(credFile)) {
      try {
        existing = JSON.parse(fs.readFileSync(credFile, 'utf8')) as Record<string, unknown>;
      } catch {
        // If existing credentials are corrupt, rewrite from env below.
        existing = {};
      }
    }

    const merged = {
      ...existing,
      ...(accessToken ? { access_token: accessToken } : {}),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };

    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(credFile, JSON.stringify(merged, null, 2), { mode: 0o600 });
    log.info('Bootstrapped/updated InsForge CLI credentials from environment');
  } catch (err) {
    log.warn('Failed to bootstrap InsForge CLI credentials', { error: String(err) });
  }
})();

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

function getMissingConfigKeys(credentials: BuildCredentialOverrides = {}): string[] {
  const required: Array<[string, string | undefined]> = [
    ['ANTHROPIC_API_KEY', credentials.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY],
    ['INSFORGE_BASE_URL', credentials.insforgeBaseUrl ?? process.env.INSFORGE_BASE_URL],
    ['INSFORGE_ANON_KEY', credentials.insforgeAnonKey ?? process.env.INSFORGE_ANON_KEY],
    ['INSFORGE_PROJECT_ID', credentials.insforgeProjectId ?? process.env.INSFORGE_PROJECT_ID],
  ];

  // CLI auth: accept either an explicit access token, a refresh token (bootstraps credentials on startup),
  // or a locally stored credentials file (dev machines with `npx @insforge/cli login`).
  const hasCliAuth =
    !!(credentials.insforgeAccessToken ?? process.env.INSFORGE_ACCESS_TOKEN)?.trim() ||
    !!(credentials.insforgeRefreshToken ?? process.env.INSFORGE_REFRESH_TOKEN)?.trim() ||
    fs.existsSync(path.join(os.homedir(), '.config', 'insforge', 'credentials.json'));

  if (!hasCliAuth) {
    required.push(['INSFORGE_ACCESS_TOKEN', undefined]);
  }

  return required
    .filter(([, value]) => typeof value !== 'string' || value.trim().length === 0)
    .map(([key]) => key);
}

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

  const missingKeys = getMissingConfigKeys(credentials);
  if (missingKeys.length > 0) {
    res.status(400).json({
      error: `You have not configured following keys: ${missingKeys.join(', ')}. Please make sure to provide your Anthropic API KEY and InsForge credentials in "PROVIDER CREDENTIALS" field.`,
      missingKeys,
    });
    return;
  }

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
// POST /api/preflight  — validate effective config before build starts
// ---------------------------------------------------------------------------

app.post('/api/preflight', (req: Request, res: Response) => {
  const parsed = BuildRequestSchema.partial({ prompt: true }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid payload' });
    return;
  }

  const credentials = Object.fromEntries(
    Object.entries(parsed.data.credentials ?? {}).filter(([, value]) => typeof value === 'string' && value.trim().length > 0),
  ) as BuildCredentialOverrides;

  const missingKeys = getMissingConfigKeys(credentials);
  if (missingKeys.length > 0) {
    res.status(400).json({
      ok: false,
      error: `Missing required configuration: ${missingKeys.join(', ')}`,
      missingKeys,
    });
    return;
  }

  res.json({ ok: true });
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
