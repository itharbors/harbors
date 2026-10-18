import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CredentialStore, type KeyringAdapter } from '../../../../../packages/server/dist/testing.js';
import { cleanupEvalResources, openEvalCredentialVault } from './prompt-eval.credentials.ts';

test('eval Vault binds the normal Kit and Model Service scope without exposing stored values', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-eval-vault-'));
  const databasePath = path.join(root, 'harbors.db');
  await writeFile(databasePath, '');
  const values = new Map<string, string>();
  const keyring: KeyringAdapter = {
    async get(account) { return values.get(account) ?? null; },
    async set(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); },
  };
  const pendingStore = new CredentialStore(databasePath);
  const pending = pendingStore.createPending({
    scope: 'a'.repeat(64),
    id: '11111111-1111-4111-8111-111111111111',
    label: 'pending fixture',
    metadata: {},
    secretVersion: '22222222-2222-4222-8222-222222222222',
  });
  pendingStore.close();
  values.set(pending.secretReference, 'pending-fixture-only');
  const vault = await openEvalCredentialVault(root, keyring);
  try {
    assert.equal(values.has(pending.secretReference), false);
    const scoped = vault.bind('eval-user', 'harness', 'model-service');
    await scoped.put({ label: 'eval fixture', metadata: { protocol: 'openai' }, secret: 'fixture-only' });
    assert.equal((await scoped.list()).length, 1);
    assert.deepEqual(await scoped.capability(), { mode: 'on', status: 'available' });
  } finally {
    await vault.close();
  }
});

test('eval Vault requires an existing regular harbors.db inside the explicit root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-eval-vault-missing-'));
  await assert.rejects(openEvalCredentialVault(root, { get: async () => null, set: async () => undefined, delete: async () => undefined }), /EVAL_PROVIDER_UNAVAILABLE/);
  const notDirectory = path.join(root, 'not-directory');
  await writeFile(notDirectory, '');
  await assert.rejects(openEvalCredentialVault(notDirectory, { get: async () => null, set: async () => undefined, delete: async () => undefined }), /EVAL_PROVIDER_UNAVAILABLE/);
});

test('eval cleanup attempts every resource and reports any lifecycle failure', async () => {
  const calls: string[] = [];
  const succeeded = await cleanupEvalResources({
    baseline: { stop() { calls.push('baseline'); throw new Error('private baseline failure'); } },
    candidate: { stop() { calls.push('candidate'); } },
    harness: { async dispose() { calls.push('harness'); throw new Error('private harness failure'); } },
    credentialVault: { async close() { calls.push('vault'); throw new Error('private vault failure'); } },
  });
  assert.equal(succeeded, false);
  assert.deepEqual(calls, ['baseline', 'candidate', 'harness', 'vault']);
  assert.equal(await cleanupEvalResources({}), true);
});
