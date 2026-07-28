import assert from 'node:assert/strict';
import test from 'node:test';

import { createKitRuntimeCoordinator } from './kit-runtime-coordinator.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('serializes activation and uninstall through one FIFO runtime boundary', async () => {
  const firstGate = deferred();
  const events = [];
  const coordinator = createKitRuntimeCoordinator({
    async applyActivation(selection) {
      events.push(`activation:start:${selection.version}`);
      await firstGate.promise;
      events.push(`activation:end:${selection.version}`);
      return { kind: 'activation', ...selection };
    },
    async applyUninstall(id) {
      events.push(`uninstall:${id}`);
      return { kind: 'uninstall', id };
    },
  });

  const activation = coordinator.applyActivation({ id: '@example/kit-demo', version: '2.0.0' });
  const uninstall = coordinator.applyUninstall('@example/other');
  await Promise.resolve();
  assert.deepEqual(events, ['activation:start:2.0.0']);
  firstGate.resolve();

  assert.deepEqual(await activation, {
    kind: 'activation', id: '@example/kit-demo', version: '2.0.0',
  });
  assert.deepEqual(await uninstall, { kind: 'uninstall', id: '@example/other' });
  assert.deepEqual(events, [
    'activation:start:2.0.0',
    'activation:end:2.0.0',
    'uninstall:@example/other',
  ]);
});

test('does not poison later runtime transactions after one operation fails', async () => {
  let attempts = 0;
  const coordinator = createKitRuntimeCoordinator({
    async applyActivation() {
      attempts += 1;
      if (attempts === 1) throw new Error('runtime replacement failed');
      return { runtimeReloaded: true };
    },
    async applyUninstall() {},
  });

  await assert.rejects(
    coordinator.applyActivation({ id: '@example/kit-demo', version: '2.0.0' }),
    /runtime replacement failed/,
  );
  assert.deepEqual(
    await coordinator.applyActivation({ id: '@example/kit-demo', version: '1.0.0' }),
    { runtimeReloaded: true },
  );
});

test('drains accepted work and rejects new work once disposal begins', async () => {
  const gate = deferred();
  const coordinator = createKitRuntimeCoordinator({
    applyActivation: () => gate.promise,
    async applyUninstall() {},
  });
  const accepted = coordinator.applyActivation({ id: '@example/kit-demo', version: '1.0.0' });
  const draining = coordinator.dispose();

  await assert.rejects(
    coordinator.applyUninstall('@example/kit-demo'),
    /shutting down/i,
  );
  gate.resolve({ runtimeReloaded: true });
  await accepted;
  await draining;
  await coordinator.drain();
});
