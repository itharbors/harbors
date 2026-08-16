import assert from 'node:assert/strict';
import test from 'node:test';
import { attach, detach, load } from './index.js';

type BroadcastHandler = (...args: unknown[]) => void;

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
