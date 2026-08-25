import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';

import { createIsolatedPluginPathRoots, startWebHost } from './web-host-runner.mjs';

test('keeps every isolated Plugin path strictly below applicationData', () => {
  const roots = createIsolatedPluginPathRoots('/tmp/web-host-isolation');
  assert.deepEqual(roots, {
    applicationData: '/tmp/web-host-isolation/application-data',
    data: '/tmp/web-host-isolation/application-data/plugins/data',
    cache: '/tmp/web-host-isolation/application-data/plugins/cache',
    temp: '/tmp/web-host-isolation/application-data/plugins/temp',
  });
  for (const directory of [roots.data, roots.cache, roots.temp]) {
    assert.equal(path.relative(roots.applicationData, directory).startsWith('..'), false);
  }
});

function fixtureChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  for (const stream of [child.stdout, child.stderr]) {
    stream.destroyed = false;
    stream.destroy = () => { stream.destroyed = true; };
  }
  child.exitCode = undefined;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    child.exitCode = null;
    child.emit('exit', null, signal);
    child.emit('close', null, signal);
    return true;
  };
  return child;
}

test('starts a fully isolated Web Host contract and cleans every fixture child', async () => {
  const children = [];
  const calls = [];
  const removed = [];
  let healthCalls = 0;

  const handle = await startWebHost({
    repositoryRoot: '/repo',
    kitSources: [{ directory: '/repo/kits/alpha', source: 'builtin' }],
    defaultKit: '@example/kit-alpha',
    allocatePorts: async () => ({ gateway: 40101, server: 40102, client: 40103, notification: 40104 }),
    makeTempDirectory: async () => '/tmp/web-host-fixture',
    removeDirectory: async (directory) => removed.push(directory),
    environment: { HOME: 'caller-home', USERPROFILE: 'caller-user' },
    spawnProcess: (command, args, options) => {
      const child = fixtureChild();
      children.push({ command, args, options, child });
      calls.push({ command, args, options });
      return child;
    },
    fetchImpl: async (url) => {
      assert.equal(url, 'http://127.0.0.1:40101/api/health');
      healthCalls += 1;
      if (healthCalls === 1) throw new Error('not ready');
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    },
    readyTimeoutMs: 100,
    pollIntervalMs: 1,
  });

  assert.equal(handle.baseUrl, 'http://127.0.0.1:40101');
  assert.deepEqual(handle.ports, { gateway: 40101, server: 40102, client: 40103, notification: 40104 });
  assert.deepEqual((await handle.health()).body, { status: 'ok' });
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[0].options.env.HARBORS_KIT_SOURCES), [
    { directory: '/repo/kits/alpha', source: 'builtin' },
  ]);
  assert.equal(calls[0].options.env.CE_DEFAULT_KIT, '@example/kit-alpha');
  assert.equal(calls[0].options.env.PORT, '40101');
  assert.equal(calls[1].options.env.PORT, '40102');
  assert.equal(calls[2].options.env.CLIENT_PORT, '40103');
  assert.equal(calls[0].options.env.HOME, 'caller-home');
  assert.equal(calls[0].options.env.USERPROFILE, 'caller-user');
  assert.equal(calls[0].options.env.HARBORS_CREDENTIAL_MODE, 'off');
  assert.match(calls[1].options.env.DB_PATH, /web-host-fixture/u);

  await handle.stop();
  assert.deepEqual(children.map(({ child }) => child.killSignals), [['SIGTERM'], ['SIGTERM'], ['SIGTERM']]);
  assert.deepEqual(removed, ['/tmp/web-host-fixture']);
});

test('cleans the temporary root when a Web Host child exits before health is ready', async () => {
  const removed = [];
  await assert.rejects(
    startWebHost({
      repositoryRoot: '/repo',
      kitSources: [{ directory: '/repo/kits/alpha', source: 'builtin' }],
      defaultKit: '@example/kit-alpha',
      allocatePorts: async () => ({ gateway: 40201, server: 40202, client: 40203, notification: 40204 }),
      makeTempDirectory: async () => '/tmp/web-host-failure',
      removeDirectory: async (directory) => removed.push(directory),
      spawnProcess: () => {
        const child = fixtureChild();
        queueMicrotask(() => {
          child.exitCode = 1;
          child.emit('exit', 1, null);
          child.emit('close', 1, null);
        });
        return child;
      },
      fetchImpl: async () => { throw new Error('connection refused'); },
      readyTimeoutMs: 100,
      pollIntervalMs: 1,
    }),
    /exited before ready/u,
  );
  assert.deepEqual(removed, ['/tmp/web-host-failure']);
});

test('kills the process group when a watcher leader exits before its stdio descendants', async () => {
  const children = [];
  const signals = [];
  const aliveGroups = new Set([501, 502, 503]);
  const removed = [];
  const handle = await startWebHost({
    repositoryRoot: '/repo',
    kitSources: [{ directory: '/repo/kits/alpha', source: 'builtin' }],
    defaultKit: '@example/kit-alpha',
    allocatePorts: async () => ({ gateway: 40301, server: 40302, client: 40303, notification: 40304 }),
    makeTempDirectory: async () => '/tmp/web-host-descendants',
    removeDirectory: async (directory) => removed.push(directory),
    spawnProcess: (_command, _args, options) => {
      const child = fixtureChild();
      child.pid = 501 + children.length;
      children.push(child);
      child.spawnOptions = options;
      return child;
    },
    signalProcess: (pgid, signal) => {
      signals.push({ pgid, signal });
      if (signal === 'SIGKILL') aliveGroups.delete(pgid);
    },
    isProcessGroupAlive: (pgid) => aliveGroups.has(pgid),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) }),
    readyTimeoutMs: 100,
    stopTimeoutMs: 5,
  });

  children[0].exitCode = 0;
  children[0].emit('exit', 0, null);
  await handle.stop();
  await handle.stop();

  assert.deepEqual(signals, [
    { pgid: 503, signal: 'SIGTERM' },
    { pgid: 502, signal: 'SIGTERM' },
    { pgid: 501, signal: 'SIGTERM' },
    { pgid: 503, signal: 'SIGKILL' },
    { pgid: 502, signal: 'SIGKILL' },
    { pgid: 501, signal: 'SIGKILL' },
  ]);
  assert.ok(children.every((child) => child.stdout.destroyed && child.stderr.destroyed));
  assert.deepEqual(removed, ['/tmp/web-host-descendants']);
});
