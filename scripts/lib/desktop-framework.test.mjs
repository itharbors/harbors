import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFrameworkProcessController,
  parseDesktopFrameworkEnvironment,
  runDesktopFrameworkProcess,
} from './desktop-framework.mjs';

function validEnvironment(application = '/Applications/ITHARBORS.app') {
  return {
    HARBORS_RUNTIME_ROOT: `${application}/Contents/Resources/runtime`,
    HARBORS_CLIENT_ASSETS_ROOT: `${application}/Contents/Resources/runtime/client`,
    HARBORS_DB_PATH: '/Users/me/Library/Application Support/ITHARBORS/framework.db',
    HARBORS_INSTALLED_KITS: JSON.stringify([
      '/Users/me/Library/Application Support/ITHARBORS/kit-store/kits/demo/1.0.0',
    ]),
    HARBORS_NOTIFICATION_PORT: '17896',
    HARBORS_APPLICATION_TOKEN: 'application-secret',
  };
}

test('requires absolute packaged paths and loopback configuration', () => {
  const valid = validEnvironment();
  const parsed = parseDesktopFrameworkEnvironment(valid);

  assert.deepEqual(parsed, {
    runtimeRoot: '/Applications/ITHARBORS.app/Contents/Resources/runtime',
    clientAssetsRoot: '/Applications/ITHARBORS.app/Contents/Resources/runtime/client',
    dbPath: '/Users/me/Library/Application Support/ITHARBORS/framework.db',
    installedKitDirs: [
      '/Users/me/Library/Application Support/ITHARBORS/kit-store/kits/demo/1.0.0',
    ],
    notificationPort: 17896,
    applicationControlToken: 'application-secret',
    host: '127.0.0.1',
    port: 0,
  });
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.installedKitDirs), true);

  for (const [field, value] of [
    ['HARBORS_RUNTIME_ROOT', '../runtime'],
    ['HARBORS_CLIENT_ASSETS_ROOT', 'client'],
    ['HARBORS_DB_PATH', './framework.db'],
  ]) {
    assert.throws(
      () => parseDesktopFrameworkEnvironment({ ...valid, [field]: value }),
      new RegExp(`${field}.*absolute`, 'iu'),
    );
  }
});

test('rejects malformed installed Kits, notification ports, and application tokens', () => {
  const valid = validEnvironment();
  for (const installedKits of [
    'not-json',
    '{}',
    '["relative/kit"]',
    '[""]',
  ]) {
    assert.throws(() => parseDesktopFrameworkEnvironment({
      ...valid,
      HARBORS_INSTALLED_KITS: installedKits,
    }), /HARBORS_INSTALLED_KITS.*JSON array.*absolute/iu);
  }
  for (const notificationPort of ['0', '65536', '1.5', 'not-a-port', '']) {
    assert.throws(() => parseDesktopFrameworkEnvironment({
      ...valid,
      HARBORS_NOTIFICATION_PORT: notificationPort,
    }), /HARBORS_NOTIFICATION_PORT.*1.*65535/iu);
  }
  assert.throws(() => parseDesktopFrameworkEnvironment({
    ...valid,
    HARBORS_APPLICATION_TOKEN: '',
  }), /HARBORS_APPLICATION_TOKEN.*non-empty/iu);
});

test('emits one ready message and drains one shutdown', async () => {
  const messages = [];
  let starts = 0;
  let stops = 0;
  const processController = createFrameworkProcessController({
    send: (message) => messages.push(message),
    start: async () => {
      starts += 1;
      return 43123;
    },
    stop: async () => {
      stops += 1;
    },
  });

  assert.deepEqual(await Promise.all([
    processController.start(),
    processController.start(),
  ]), [43123, 43123]);
  await Promise.all([processController.stop(), processController.stop()]);

  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.deepEqual(messages, [{ type: 'ready', port: 43123 }]);
});

test('drains shutdown without emitting ready when startup fails', async () => {
  const messages = [];
  let stops = 0;
  const failure = new Error('listen failed');
  const processController = createFrameworkProcessController({
    send: (message) => messages.push(message),
    start: async () => {
      throw failure;
    },
    stop: async () => {
      stops += 1;
    },
  });

  await assert.rejects(processController.start(), failure);
  await processController.stop();
  assert.equal(stops, 1);
  assert.deepEqual(messages, []);
});

test('cleans failed entry startup, reports fatal, and detaches its IPC shutdown listener', async () => {
  const messages = [];
  const failure = new Error('listen failed');
  let stops = 0;
  let shutdownSubscriptions = 0;
  let shutdownUnsubscriptions = 0;
  let exits = 0;

  const result = await runDesktopFrameworkProcess({
    env: validEnvironment(),
    createAssembly: (runtimeRoot, options) => ({ runtimeRoot, options }),
    createServer: () => ({
      start: async () => { throw failure; },
      stop: async () => { stops += 1; },
    }),
    send: (message) => messages.push(message),
    subscribeShutdown: () => {
      shutdownSubscriptions += 1;
      return () => { shutdownUnsubscriptions += 1; };
    },
    exit: () => { exits += 1; },
  });

  assert.equal(result, undefined);
  assert.equal(stops, 1);
  assert.equal(shutdownSubscriptions, 1);
  assert.equal(shutdownUnsubscriptions, 1);
  assert.equal(exits, 1);
  assert.deepEqual(messages, [{ type: 'fatal', message: 'listen failed' }]);
});
