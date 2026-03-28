# Orchestrator

Express + TypeScript service that runs Tivra's build pipeline.

It accepts a prompt, emits live progress over SSE, provisions backend resources, generates code, and deploys the generated app.

## Responsibilities

- Parse user prompt into a typed SaaS spec
- Provision InsForge backend resources (DB/auth/storage/functions)
- Generate application code from templates
- Deploy generated application to hosting
- Stream pipeline events to clients

## Scripts

From this folder:

```bash
pnpm dev
pnpm build
pnpm start
```

From repository root:

```bash
pnpm --filter orchestrator dev
pnpm --filter orchestrator build
pnpm --filter orchestrator start
```

## Environment Variables

Create `apps/orchestrator/.env`:

```env
# Server
PORT=3001
CORS_ORIGIN=http://localhost:3000

# Anthropic (fallback if not provided per build request)
ANTHROPIC_API_KEY=

# InsForge defaults (fallbacks if not provided per build request)
INSFORGE_BASE_URL=
INSFORGE_ANON_KEY=
INSFORGE_ACCESS_TOKEN=
INSFORGE_PROJECT_ID=

# Code generation provider used by generator internals
OPENAI_API_KEY=
```

Notes:
- Build requests can provide request-scoped credential overrides.
- If request credentials are omitted, orchestrator falls back to `.env` values.

## API

Base URL: `http://localhost:3001`

### `GET /api/health`

Returns basic service health.

Response:

```json
{
  "status": "ok",
  "builds": 1
}
```

### `POST /api/build`

Starts a build pipeline.

Request body:

```json
{
  "prompt": "Build a project management app with teams and tasks",
  "credentials": {
    "anthropicApiKey": "...",
    "insforgeBaseUrl": "https://<project>.<region>.insforge.app",
    "insforgeAnonKey": "...",
    "insforgeAccessToken": "...",
    "insforgeProjectId": "..."
  }
}
```

- `prompt` is required (min 5 chars).
- `credentials` is optional.

Response:

```json
{
  "buildId": "uuid"
}
```

### `GET /api/build/:buildId`

Returns current build state for polling/recovery.

### `GET /api/build/:buildId/stream`

Server-Sent Events stream.

Event shape:

```json
{
  "step": "code_generated",
  "message": "Generated src/app/page.tsx",
  "data": {},
  "ts": 1710000000000
}
```

Common steps:
- `spec_parsed`
- `db_created`
- `auth_created`
- `storage_created`
- `migration_done`
- `functions_deployed`
- `code_generated`
- `app_deployed`
- `error`

## Local Development

1. Start service:

```bash
pnpm --filter orchestrator dev
```

2. Verify health:

```bash
curl http://localhost:3001/api/health
```

3. Start a build:

```bash
curl -X POST http://localhost:3001/api/build \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Build a CRM with contacts and deals"}'
```

## Implementation Notes

- Build state is in-memory and not persisted.
- Credential overrides are request-scoped and isolated per build run.
- Generated apps are written under `generated/<spec.name>` at workspace root.

## Deploy To Render

This service is ready for a native Node.js Render deployment.

### 1. Create a Web Service

- Service type: Web Service
- Runtime: Node
- Root directory: `apps/orchestrator` (or `.` if this folder is the connected repo root)
- Build command: `npm install && npm run build`
- Start command: `npm run start`
- Health check path: `/api/health`

### 2. Configure Environment Variables

Set these in Render dashboard (Environment tab):

- `CORS_ORIGIN` (for your frontend URL)
- `OPENAI_API_KEY`
- `INSFORGE_ACCESS_TOKEN`
- `INSFORGE_PROJECT_ID`
- `INSFORGE_BASE_URL`
- `INSFORGE_ANON_KEY`
- `VERCEL_TOKEN`

Optional:

- `ANTHROPIC_API_KEY`
- `STRICT_PROMPT_DEBUG` (`false` in production)

Notes:

- Do not set `PORT` manually; Render injects it.
- Keep secrets only in Render environment variables (never committed).

### 3. Pre-Launch Checklist

- Run `npm run build` locally and confirm success.
- Verify `/api/health` returns `{"status":"ok"...}`.
- Confirm CORS is set to your production frontend domain.
- Run one end-to-end `POST /api/build` smoke test using production keys.
- Review logs for any provider auth or quota errors.

### 4. Production Caveats For This Hackathon Version

- Build/session state is in-memory; a restart loses active build history.
- SSE clients are held in memory; deploys/restarts drop active streams.
- Generated app artifacts are written to local disk; Render disk is ephemeral unless a persistent disk is configured.

If you need stronger production reliability, move build state and event streams to persistent storage (Redis/Postgres) and push generated artifacts to external object storage.
