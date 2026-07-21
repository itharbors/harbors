import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createApplicationEventParser,
  createApplicationRuntimeClient,
  fetchApplicationBootstrap,
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
