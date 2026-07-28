import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiveKitManager } from './live-kit-manager.mjs';

function setup({ builtinKitIds = [] } = {}) {
  const calls = [];
  const manager = {
    async list() { calls.push(['list']); return { kits: [] }; },
    async refresh() { calls.push(['refresh']); return { source: 'network' }; },
    async install(value) {
      calls.push(['install', structuredClone(value)]);
      return { status: 'installed', ...value, autoUpdate: false };
    },
  };
  const coordinator = {
    async applyActivation(value) {
      calls.push(['applyActivation', structuredClone(value)]);
      return { id: value.id, version: value.version, runtimeReloaded: true };
    },
    async applyUninstall(id) {
      calls.push(['applyUninstall', id]);
      return { id, removedVersions: ['1.0.0'], runtimeReloaded: true };
    },
  };
  return {
    calls,
    live: createLiveKitManager({ manager, coordinator, builtinKitIds }),
  };
}

test('installs then automatically activates the exact selected version without restart', async () => {
  const { calls, live } = setup();
  const input = { id: '@example/kit-demo', version: '2.0.0', channel: 'stable' };

  assert.deepEqual(await live.install(input), {
    status: 'installed',
    ...input,
    autoUpdate: false,
    pending: false,
    requiresRestart: false,
    runtimeReloaded: true,
  });
  assert.deepEqual(calls, [
    ['install', input],
    ['applyActivation', { id: input.id, version: input.version, retryBad: false }],
  ]);
});

test('routes activation, rollback, and uninstall through the runtime coordinator', async () => {
  const { calls, live } = setup();

  assert.deepEqual(await live.activate({
    id: '@example/kit-demo', version: '1.0.0', retryBad: true,
  }), {
    id: '@example/kit-demo',
    version: '1.0.0',
    pending: false,
    requiresRestart: false,
    runtimeReloaded: true,
  });
  await live.rollback('@example/kit-demo');
  assert.deepEqual(await live.uninstall('@example/kit-demo'), {
    id: '@example/kit-demo',
    removedVersions: ['1.0.0'],
    requiresRestart: false,
    runtimeReloaded: true,
  });
  assert.deepEqual(calls, [
    ['applyActivation', {
      id: '@example/kit-demo', version: '1.0.0', retryBad: true,
    }],
    ['applyActivation', { id: '@example/kit-demo', rollback: true }],
    ['applyUninstall', '@example/kit-demo'],
  ]);
});

test('delegates read operations and rejects builtin or malformed uninstall identities', async () => {
  const { calls, live } = setup({ builtinKitIds: ['@itharbors/kit-csv'] });
  assert.deepEqual(await live.list(), { kits: [] });
  assert.deepEqual(await live.refresh(), { source: 'network' });
  await assert.rejects(live.uninstall('@itharbors/kit-csv'), /built into Harbors/i);
  await assert.rejects(live.uninstall('../kits/csv'), /lowercase scoped/i);
  assert.deepEqual(calls, [['list'], ['refresh']]);
});

test('does not hide a runtime replacement failure behind a restart response', async () => {
  const manager = {
    async list() {}, async refresh() {}, async install(value) { return value; },
  };
  const coordinator = {
    async applyActivation() { throw new Error('previous runtime restored'); },
    async applyUninstall() {},
  };
  const live = createLiveKitManager({ manager, coordinator });

  await assert.rejects(
    live.activate({ id: '@example/kit-demo', version: '2.0.0' }),
    /previous runtime restored/,
  );
});
