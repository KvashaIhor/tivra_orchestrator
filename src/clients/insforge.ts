/**
 * Insforge — CLI wrapper for provisioning operations.
 *
 * Insforge is a BaaS platform (similar to Supabase). Each project has a fixed
 * base URL and anon key. There is no provisioning REST API — all infrastructure
 * operations (table creation, storage buckets) are performed via the
 * @insforge/cli tool executed as a child process.
 *
 * The REST API (base URL + anon key) is used by the GENERATED application
 * via @insforge/sdk, not by this orchestrator. The orchestrator only needs the
 * CLI for provisioning and reads INSFORGE_BASE_URL / INSFORGE_ANON_KEY from
 * env to hand them to the generated app.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { log } from '../utils/log';
import { LiveTableSchema } from '../types/spec';
import { getBuildCredentials } from '../runtime/buildCredentials';

const execFileAsync = promisify(execFile);

// Workspace root — where `npx @insforge/cli link` was run and .insforge lives.
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../../');
const CLI_CREDENTIALS_PATH = path.join(os.homedir(), '.config', 'insforge', 'credentials.json');

/** Build env vars that allow @insforge/cli to run non-interactively. */
function buildCliEnv(): NodeJS.ProcessEnv {
  const { insforgeAccessToken, insforgeProjectId } = getBuildCredentials();
  const explicitAccessToken = insforgeAccessToken?.trim();
  const envAccessToken = process.env.INSFORGE_ACCESS_TOKEN?.trim();
  const hasRefreshToken = !!process.env.INSFORGE_REFRESH_TOKEN?.trim();
  const hasStoredCredentials = fs.existsSync(CLI_CREDENTIALS_PATH);
  const accessToken = explicitAccessToken || (!hasRefreshToken && !hasStoredCredentials ? envAccessToken : undefined);
  const projectId = insforgeProjectId ?? process.env.INSFORGE_PROJECT_ID;

  return {
    ...process.env,
    ...(accessToken
      ? { INSFORGE_ACCESS_TOKEN: accessToken }
      : {}),
    ...(projectId
      ? { INSFORGE_PROJECT_ID: projectId }
      : {}),
  };
}

/** Run an @insforge/cli command and return its stdout. */
async function cli(args: string[], timeoutMs = 30_000): Promise<string> {
  const cmd = `npx @insforge/cli ${args.join(' ')}`;
  log.cli(`→ ${cmd}`);
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execFileAsync(
      'npx',
      ['--yes', '@insforge/cli', ...args],
      { env: buildCliEnv(), timeout: timeoutMs, cwd: WORKSPACE_ROOT },
    ));
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string; stdout?: string };
    log.error(`CLI failed: ${cmd}`, {
      stderr: e.stderr ?? '',
      stdout: e.stdout ?? '',
      message: e.message ?? String(err),
    });
    throw err;
  }
  if (stderr && stderr.trim()) {
    // Filter out harmless npm config warnings
    const real = stderr.split('\n').filter((l) => !l.startsWith('npm warn')).join('\n').trim();
    if (real) log.warn(`CLI stderr: ${real}`);
  }
  log.cli(`← ok (${stdout.length} bytes)`);
  return stdout;
}

// ---------------------------------------------------------------------------
// Provisioning operations
// ---------------------------------------------------------------------------

/**
 * Run a SQL statement through the Insforge CLI.
 * Used for CREATE TABLE / ALTER TABLE during backend provisioning.
 */
export async function runDbQuery(sql: string): Promise<unknown> {
  log.info(`runDbQuery: ${sql.slice(0, 120)}${sql.length > 120 ? '…' : ''}`);
  const out = await cli(['db', 'query', sql, '--json'], 60_000);
  try {
    const parsed = JSON.parse(out);
    log.ok('runDbQuery success');
    return parsed;
  } catch {
    log.warn('runDbQuery: response was not JSON', { raw: out.slice(0, 300) });
    return { raw: out };
  }
}

/**
 * Fetch live table schemas for provided table names using information_schema.
 */
export async function getLiveTableSchemas(tableNames: string[]): Promise<LiveTableSchema[]> {
  if (tableNames.length === 0) return [];

  const escaped = tableNames.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ');
  const sql = [
    'SELECT table_name, column_name, data_type, is_nullable',
    'FROM information_schema.columns',
    "WHERE table_schema = 'public'",
    `  AND table_name IN (${escaped})`,
    'ORDER BY table_name, ordinal_position;',
  ].join(' ');

  const result = await runDbQuery(sql) as {
    rows?: Array<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>;
  };

  const byTable = new Map<string, LiveTableSchema>();
  for (const row of result.rows ?? []) {
    const tableName = row.table_name;
    if (!byTable.has(tableName)) {
      byTable.set(tableName, { tableName, columns: [] });
    }
    byTable.get(tableName)!.columns.push({
      name: row.column_name,
      dataType: row.data_type,
      isNullable: row.is_nullable === 'YES',
    });
  }

  return Array.from(byTable.values());
}

/**
 * Create a storage bucket via the Insforge CLI.
 * Buckets are public by default to allow direct URL access from the generated app.
 */
export async function createStorageBucket(
  name: string,
  isPublic = true,
): Promise<void> {
  log.info(`createStorageBucket: name=${name} public=${isPublic}`);
  const args = ['storage', 'create-bucket', name];
  if (!isPublic) args.push('--private');
  try {
    await cli(args);
    log.ok(`Storage bucket "${name}" created`);
  } catch (err: unknown) {
    // Bucket already exists from a previous run — treat as success
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ALREADY_EXISTS')) {
      log.ok(`Storage bucket "${name}" already exists — skipping`);
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Config accessors — read from environment, throw clearly if missing
// ---------------------------------------------------------------------------

/** Base URL of the Insforge project (e.g. https://my-app.us-east.insforge.app). */
export function getBaseUrl(): string {
  const { insforgeBaseUrl } = getBuildCredentials();
  const url = insforgeBaseUrl ?? process.env.INSFORGE_BASE_URL;
  if (!url) {
    throw new Error(
      'INSFORGE_BASE_URL is not set. Copy it from your Insforge dashboard, add it to apps/orchestrator/.env, or provide it in the build request.',
    );
  }
  return url;
}

/** Anon key for @insforge/sdk client initialisation in the generated app. */
export function getAnonKey(): string {
  const { insforgeAnonKey } = getBuildCredentials();
  const key = insforgeAnonKey ?? process.env.INSFORGE_ANON_KEY;
  if (!key) {
    throw new Error(
      'INSFORGE_ANON_KEY is not set. Copy it from your Insforge dashboard, add it to apps/orchestrator/.env, or provide it in the build request.',
    );
  }
  return key;
}
