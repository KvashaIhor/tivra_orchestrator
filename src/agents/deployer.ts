import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { SaaSSpec, EmitFn } from '../types/spec';
import { log } from '../utils/log';
import { getBaseUrl, getAnonKey } from '../clients/insforge';
import { getBuildCredentials } from '../runtime/buildCredentials';

const execFileAsync = promisify(execFile);

const GENERATED_DIR = path.resolve(__dirname, '../../../../generated');
// Workspace root — where .insforge lives (same as insforge client)
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../../');

/** Build env vars that allow @insforge/cli to run non-interactively. */
function buildCliEnv(): NodeJS.ProcessEnv {
  const { insforgeAccessToken, insforgeProjectId } = getBuildCredentials();
  const accessToken = insforgeAccessToken ?? process.env.INSFORGE_ACCESS_TOKEN;
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

export async function deployApp(spec: SaaSSpec, emit: EmitFn): Promise<string> {
  const appDir = path.join(GENERATED_DIR, spec.name);
  const baseUrl = getBaseUrl();
  const anonKey = getAnonKey();

  log.info(`deployApp start — dir=${appDir}`);
  emit({ step: 'app_deployed', message: 'Starting InsForge deployment…', ts: Date.now() });

  // Pass NEXT_PUBLIC_ env vars so the generated app can reach the backend
  const envVars: Record<string, string> = {
    NEXT_PUBLIC_INSFORGE_URL: baseUrl,
    NEXT_PUBLIC_INSFORGE_ANON_KEY: anonKey,
  };

  log.info(`Deploying with env: NEXT_PUBLIC_INSFORGE_URL=${baseUrl}`);

  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execFileAsync(
      'npx',
      [
        '--yes', '@insforge/cli',
        'deployments', 'deploy', appDir,
        '--env', JSON.stringify(envVars),
        '--json',
      ],
      { env: buildCliEnv(), timeout: 5 * 60 * 1000, cwd: WORKSPACE_ROOT },
    ));
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string; stdout?: string };
    // Filter npm noise from stderr for cleaner error reporting
    const cleanStderr = (e.stderr ?? '').split('\n').filter((l) => !l.startsWith('npm warn')).join('\n').trim();
    log.error('InsForge deploy failed', {
      stderr: cleanStderr,
      stdout: e.stdout ?? '',
      message: e.message ?? String(err),
    });
    throw new Error(`Deployment failed: ${cleanStderr || e.message || String(err)}`);
  }

  if (stderr) {
    const cleanStderr = stderr.split('\n').filter((l) => !l.startsWith('npm warn')).join('\n').trim();
    if (cleanStderr) log.warn(`Deploy stderr:\n${cleanStderr}`);
  }

  log.info(`Deploy stdout:\n${stdout.trim()}`);

  // CLI returns JSON with --json flag: { url, id, status }
  let url: string | undefined;
  try {
    const result = JSON.parse(stdout.trim());
    url = result?.url ?? result?.deploymentUrl;
    log.info('Deploy JSON result', result);
  } catch {
    // Fallback: scan for https:// URL in output
    const lines = stdout.trim().split('\n');
    url = lines.find((l) => l.includes('https://'));
  }

  if (!url || !url.startsWith('https://')) {
    log.error('Deploy did not return a URL', { stdout });
    throw new Error(`Deployment did not return a URL. stdout:\n${stdout}`);
  }

  log.ok(`Deployed: ${url}`);
  emit({ step: 'app_deployed', message: `Deployed: ${url}`, data: { url }, ts: Date.now() });
  return url;
}

