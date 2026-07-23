import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createApplicationEventParser,
  createApplicationRuntimeClient,
  fetchApplicationBootstrap,
  validateInstalledKitRuntime,
  triggerApplicationMenu,
} from './application-runtime-client.mjs';

test('fetches bootstrap and triggers application menus without a session id', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/application/bootstrap')) {
      return new Response(JSON.stringify({ phase: 'ready', menu: { tree: [], warnings: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ result: { status: 'installed' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const bootstrap = await fetchApplicationBootstrap('http://localhost:8080/editor', fetchImpl);
  const result = await triggerApplicationMenu(
    'http://localhost:8080/editor',
    'install-skill',
    'launch-secret',
    fetchImpl,
  );

  assert.equal(bootstrap.phase, 'ready');
  assert.deepEqual(result, { status: 'installed' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { menuId: 'install-skill' });
  assert.equal(calls[1].init.headers['x-harbors-application-token'], 'launch-secret');
  assert.equal('sessionId' in JSON.parse(calls[1].init.body), false);
});

test('parses application SSE events split across arbitrary chunks', () => {
  const events = [];
  const parser = createApplicationEventParser((event) => events.push(event));

  parser.push('data: {"type":"application-');
  parser.push('bootstrap","bootstrap":{"phase":"ready"}}\n');
  parser.push('\ndata: {"type":"application-bootstrap","bootstrap":{"phase":"degraded"}}\n\n');

  assert.deepEqual(events.map((event) => event.bootstrap.phase), ['ready', 'degraded']);
});

test('reconnects a closed application event stream until explicitly stopped', async () => {
  const connections = [];
  const timers = [];
  const phases = [];
  const client = createApplicationRuntimeClient({
    baseUrl: 'http://localhost:8080',
    onBootstrap: (bootstrap) => phases.push(bootstrap.phase),
    connect(url, handlers) {
      const connection = { url, handlers, closeCalled: false };
      connections.push(connection);
      return { close: () => { connection.closeCalled = true; } };
    },
    schedule(callback) {
      timers.push(callback);
      return timers.length;
    },
    cancelSchedule() {},
  });

  client.startEvents();
  connections[0].handlers.onData('data: {"type":"application-bootstrap","bootstrap":{"phase":"ready"}}\n\n');
  connections[0].handlers.onEnd();
  timers.shift()();

  assert.equal(connections.length, 2);
  assert.deepEqual(phases, ['ready']);

  client.close();
  connections[1].handlers.onEnd();
  assert.equal(timers.length, 0);
  assert.equal(connections[1].closeCalled, true);
});

test('validates an installed Kit through startup state and an actual disposable session load', async () => {
  const calls = [];
  const bootstrap = {
    phase: 'ready',
    diagnostics: [],
    plugins: [{ name: '@example/startup', kits: ['@example/kit-demo'], status: 'running' }],
  };
  await validateInstalledKitRuntime(
    'http://localhost:8080/editor',
    bootstrap,
    '@example/kit-demo',
    {
      sessionId: 'activation-check',
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return init.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ sessionId: 'activation-check' }), { status: 201 });
      },
    },
  );

  assert.deepEqual(calls.map((call) => [call.url, call.init.method]), [
    ['http://localhost:8080/api/session', 'POST'],
    ['http://localhost:8080/api/session/activation-check', 'DELETE'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    sessionId: 'activation-check',
    kit: '@example/kit-demo',
  });
});

test('rejects a failed startup plugin before opening a disposable session', async () => {
  let fetches = 0;
  await assert.rejects(validateInstalledKitRuntime(
    'http://localhost:8080',
    {
      phase: 'degraded',
      diagnostics: [],
      plugins: [{
        name: '@example/startup',
        kits: ['@example/kit-demo'],
        status: 'failed',
        error: 'native import failed',
      }],
    },
    '@example/kit-demo',
    { fetchImpl: async () => { fetches += 1; } },
  ), /native import failed/);
  assert.equal(fetches, 0);
});

test('rejects a Kit-attributed startup conflict before opening a disposable session', async () => {
  let fetches = 0;
  await assert.rejects(validateInstalledKitRuntime(
    'http://localhost:8080',
    {
      phase: 'degraded',
      diagnostics: [{
        code: 'PLUGIN_PATH_CONFLICT',
        kit: '@example/kit-demo',
        plugin: '@example/startup',
        message: 'startup plugin resolves to different paths',
      }],
      plugins: [],
    },
    '@example/kit-demo',
    { fetchImpl: async () => { fetches += 1; } },
  ), /different paths/);
  assert.equal(fetches, 0);
});
