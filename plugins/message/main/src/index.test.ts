import assert from 'node:assert/strict';
import test from 'node:test';
import { attach, detach, load } from './index.js';

type BroadcastHandler = (...args: unknown[]) => void;
type RequestHandler = (...args: unknown[]) => unknown;

function registerMessageHandlers(callPlugin: (...args: unknown[]) => unknown): {
  requests: Array<{ pluginName: string; name: string; handler: RequestHandler; methods: string[] }>;
  broadcasts: Array<{ pluginName: string; topic: string; handler: BroadcastHandler; methods: string[] }>;
} {
  const requests: Array<{ pluginName: string; name: string; handler: RequestHandler; methods: string[] }> = [];
  const broadcasts: Array<{ pluginName: string; topic: string; handler: BroadcastHandler; methods: string[] }> = [];
  load({
    plugin: { callPlugin },
    message: {
      registerRequest(
        pluginName: string,
        name: string,
        handler: RequestHandler,
        _location: string,
        methods: string[],
      ) {
        requests.push({ pluginName, name, handler, methods });
      },
      unregisterRequest() {},
      registerBroadcast(
        pluginName: string,
        topic: string,
        handler: BroadcastHandler,
        _location: string,
        methods: string[],
      ) {
        broadcasts.push({ pluginName, topic, handler, methods });
      },
      unregisterBroadcast() {},
    },
  });
  return { requests, broadcasts };
}

function registerBroadcastHandler(callPlugin: (...args: unknown[]) => unknown): BroadcastHandler {
  let handler: BroadcastHandler | undefined;
  load({
    plugin: { callPlugin },
    message: {
      registerRequest() {},
      unregisterRequest() {},
      registerBroadcast(
        _pluginName: string,
        _topic: string,
        registeredHandler: BroadcastHandler,
      ) {
        handler = registeredHandler;
      },
      unregisterBroadcast() {},
    },
  });
  attach('broadcast-error-test', {
    message: { broadcast: { changed: ['onChanged'] } },
  });
  assert.ok(handler);
  return handler;
}

async function flushRejectedPromise(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('broadcast consumes and normalizes a synchronously thrown plain object', () => {
  const originalConsoleError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };

  try {
    const handler = registerBroadcastHandler(() => {
      throw { details: { message: 'sync broadcast failed' } };
    });

    assert.doesNotThrow(() => handler({ id: 1 }));
    assert.equal(logged.length, 1);
    assert.match(logged[0].join(' '), /sync broadcast failed/u);
    assert.doesNotMatch(logged[0].join(' '), /\[object Object\]/u);
  } finally {
    console.error = originalConsoleError;
    detach('broadcast-error-test');
  }
});

test('broadcast consumes and normalizes an asynchronously rejected plain object', async () => {
  const originalConsoleError = console.error;
  const logged: unknown[][] = [];
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => { unhandled.push(reason); };
  console.error = (...args: unknown[]) => { logged.push(args); };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const handler = registerBroadcastHandler(() => Promise.reject({
      error: { message: 'async broadcast failed' },
    }));

    assert.doesNotThrow(() => handler({ id: 2 }));
    await flushRejectedPromise();

    assert.deepEqual(unhandled, []);
    assert.equal(logged.length, 1);
    assert.match(logged[0].join(' '), /async broadcast failed/u);
    assert.doesNotMatch(logged[0].join(' '), /\[object Object\]/u);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    console.error = originalConsoleError;
    detach('broadcast-error-test');
  }
});

test('request registers and dispatches an object route using its methods', () => {
  const calls: unknown[][] = [];
  const handlers = registerMessageHandlers((...args: unknown[]) => {
    calls.push(args);
    return 'settings';
  });

  try {
    attach('object-request-test', {
      message: {
        request: {
          getSettings: { methods: ['getSettings'], callers: ['settings'] },
        },
      },
    });

    assert.equal(handlers.requests.length, 1);
    assert.deepEqual(handlers.requests[0]?.methods, ['getSettings']);
    assert.equal(handlers.requests[0]?.pluginName, 'object-request-test');
    assert.equal(handlers.requests[0]?.name, 'getSettings');
    assert.equal(handlers.requests[0]?.handler({ source: 'test' }), 'settings');
    assert.deepEqual(calls, [['object-request-test', 'getSettings', { source: 'test' }]]);
  } finally {
    detach('object-request-test');
  }
});

test('broadcast registers and dispatches an object route using its methods', () => {
  const calls: unknown[][] = [];
  const handlers = registerMessageHandlers((...args: unknown[]) => {
    calls.push(args);
    return undefined;
  });

  try {
    attach('object-broadcast-test', {
      message: {
        broadcast: {
          changed: { methods: ['onChanged'], callers: ['settings'] },
        },
      },
    });

    assert.equal(handlers.broadcasts.length, 1);
    assert.deepEqual(handlers.broadcasts[0]?.methods, ['onChanged']);
    handlers.broadcasts[0]?.handler({ source: 'test' });
    assert.deepEqual(calls, [['object-broadcast-test', 'onChanged', { source: 'test' }]]);
  } finally {
    detach('object-broadcast-test');
  }
});

test('skips invalid and empty object routes while retaining array routes', () => {
  const handlers = registerMessageHandlers(() => undefined);

  try {
    attach('route-shapes-test', {
      message: {
        request: {
          invalid: { callers: ['settings'] },
          empty: { methods: [] },
          malformed: { methods: 'getSettings' },
          arrayRoute: ['getSettings'],
        },
        broadcast: {
          invalid: { callers: ['settings'] },
          empty: { methods: [] },
          arrayTopic: ['onChanged'],
        },
      },
    });

    assert.deepEqual(handlers.requests.map(({ name, methods }) => ({ name, methods })), [
      { name: 'arrayRoute', methods: ['getSettings'] },
    ]);
    assert.deepEqual(handlers.broadcasts.map(({ topic, methods }) => ({ topic, methods })), [
      { topic: 'arrayTopic', methods: ['onChanged'] },
    ]);
  } finally {
    detach('route-shapes-test');
  }
});
