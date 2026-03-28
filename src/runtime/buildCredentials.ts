import { AsyncLocalStorage } from 'async_hooks';
import { BuildCredentialOverrides } from '../types/spec';

const credentialStore = new AsyncLocalStorage<BuildCredentialOverrides>();

export function getBuildCredentials(): BuildCredentialOverrides {
  return credentialStore.getStore() ?? {};
}

export async function runWithBuildCredentials<T>(
  credentials: BuildCredentialOverrides,
  fn: () => Promise<T>,
): Promise<T> {
  return credentialStore.run(credentials, fn);
}
