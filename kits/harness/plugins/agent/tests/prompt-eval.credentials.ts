import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  CredentialStore,
  CredentialVault,
  createNativeKeyringAdapter,
  type KeyringAdapter,
} from '../../../../../packages/server/dist/testing.js';

export async function openEvalCredentialVault(
  evalRoot: string,
  keyringOverride?: KeyringAdapter,
): Promise<CredentialVault> {
  try {
    const rootInfo = await lstat(evalRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('INVALID_EVAL_ROOT');
    const canonicalRoot = await realpath(evalRoot);
    const databasePath = path.join(canonicalRoot, 'harbors.db');
    const databaseInfo = await lstat(databasePath);
    if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink() || await realpath(databasePath) !== databasePath) throw new Error('INVALID_EVAL_DATABASE');
    const store = new CredentialStore(databasePath);
    let vault: CredentialVault | undefined;
    try {
      const keyring = keyringOverride ?? await createNativeKeyringAdapter({ mode: 'on' });
      vault = new CredentialVault({ mode: 'on', store, keyring });
      await vault.recover();
      return vault;
    } catch (error) {
      if (vault) await vault.close().catch(() => undefined);
      else store.close();
      throw error;
    }
  } catch {
    throw new Error('EVAL_PROVIDER_UNAVAILABLE');
  }
}

export async function cleanupEvalResources(resources: {
  baseline?: { stop(): void };
  candidate?: { stop(): void };
  harness?: { dispose(): Promise<void> };
  credentialVault?: { close(): Promise<void> };
}): Promise<boolean> {
  let succeeded = true;
  for (const adapter of [resources.baseline, resources.candidate]) {
    try { adapter?.stop(); } catch { succeeded = false; }
  }
  try { await resources.harness?.dispose(); } catch { succeeded = false; }
  try { await resources.credentialVault?.close(); } catch { succeeded = false; }
  return succeeded;
}
