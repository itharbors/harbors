import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  createPackagedFrameworkSpec,
  startDesktopFrameworkProcess,
} from './desktop-framework-process.mjs';

function createChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.sent = [];
  child.kills = [];
  child.send = (message) => { child.sent.push(message); return true; };
  child.kill = (signal) => { child.kills.push(signal); return true; };
  return child;
}

function launch(child, overrides = {}) {
  const timers = [];
  const result = startDesktopFrameworkProcess({
    command: '/Applications/ITHARBORS.app/Contents/MacOS/ITHARBORS',
    args: ['/Applications/ITHARBORS.app/Contents/Resources/app.asar/dist/framework.mjs'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    ...overrides,
  }, {
    spawn: () => child,
    schedule: (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancelSchedule: (timer) => { timer.cancelled = true; },
  });
  return { ...result, timers };
}

test('uses Electron run-as-node and IPC instead of a development command', () => {
  const spec = createPackagedFrameworkSpec({
    executable: '/Applications/ITHARBORS.app/Contents/MacOS/ITHARBORS',
    frameworkEntry: '/Applications/ITHARBORS.app/Contents/Resources/app.asar/dist/framework.mjs',
    env: { HARBORS_RUNTIME_ROOT: '/Applications/ITHARBORS.app/Contents/Resources/runtime' },
  });

  assert.equal(spec.command, '/Applications/ITHARBORS.app/Contents/MacOS/ITHARBORS');
  assert.deepEqual(spec.args, ['/Applications/ITHARBORS.app/Contents/Resources/app.asar/dist/framework.mjs']);
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1');
  assert.deepEqual(spec.stdio, ['ignore', 'inherit', 'inherit', 'ipc']);
  assert.doesNotMatch(JSON.stringify(spec), /npm|vite|tsx/iu);
});

test('accepts one valid ready message and creates a loopback URL', async () => {
  const child = createChild();
  const supervisor = launch(child);
  child.emit('message', { type: 'ready', port: 43123 });

  const started = await supervisor.ready;
  assert.equal(started.child, child);
  assert.equal(started.startUrl, 'http://127.0.0.1:43123/');
  assert.equal(supervisor.timers[0].cancelled, true);
});

test('rejects fatal, early-exit, and timeout startup races', async (t) => {
  await t.test('fatal message', async () => {
    const child = createChild();
    const supervisor = launch(child);
    child.emit('message', { type: 'fatal', message: 'bind failed' });
    await assert.rejects(supervisor.ready, /bind failed/);
  });

  await t.test('early exit', async () => {
    const child = createChild();
    const supervisor = launch(child);
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await assert.rejects(supervisor.ready, /exited before ready/i);
  });

  await t.test('timeout kills only a still-running child', async () => {
    const child = createChild();
    const supervisor = launch(child);
    supervisor.timers[0].callback();
    await assert.rejects(supervisor.ready, /timed out/i);
    assert.deepEqual(child.kills, ['SIGKILL']);
  });
});

test('stops idempotently through IPC before escalating after ten seconds', async () => {
  const child = createChild();
  const supervisor = launch(child);
  child.emit('message', { type: 'ready', port: 43123 });
  await supervisor.ready;

  const first = supervisor.stop();
  const second = supervisor.stop();
  assert.equal(first, second);
  assert.deepEqual(child.sent, [{ type: 'shutdown' }]);
  assert.equal(supervisor.timers[1].delay, 10_000);
  assert.deepEqual(child.kills, []);

  supervisor.timers[1].callback();
  assert.deepEqual(child.kills, ['SIGKILL']);
  child.signalCode = 'SIGKILL';
  child.emit('exit', null, 'SIGKILL');
  await first;
});
