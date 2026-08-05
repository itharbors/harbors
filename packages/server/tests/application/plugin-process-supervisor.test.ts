import { setTimeout as setNativeTimeout } from 'node:timers';
import { describe, expect, it, vi } from 'vitest';
import {
  ApplicationPluginSupervisor,
  type ApplicationPluginSupervisorHost,
} from '../../src/application/plugin-process/supervisor';
import type {
  ApplicationPluginChild,
  ApplicationPluginChildTerminal,
} from '../../src/application/plugin-process/spawn';
import type { PluginProcessEnvelope } from '../../src/application/plugin-process/protocol';
import type {
  ApplicationPluginRuntimeSnapshot,
  InitializeApplicationPluginPayload,
  RuntimeCommand,
} from '../../src/application/plugin-process/runner-runtime';

const timers = {
  setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

describe('ApplicationPluginSupervisor', () => {
  it('moves from starting to running and forwards host and runner operations', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const states: string[] = [];
      harness.supervisor.subscribe((state) => states.push(state.status));

      const started = harness.supervisor.start();
      expect(states).toEqual(['starting']);
      await initialize(harness.children[0]!);
      const definition = await started;

      expect(states).toEqual(['starting', 'running']);
      expect(definition).toEqual({ lifecycle: true, methods: ['ping'] });
      expect(harness.supervisor.getDefinition()).toBe(definition);
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.methods)).toBe(true);
      expect(harness.supervisor.getState()).toMatchObject({
        status: 'running', pid: 4_000, restartCount: 0, error: null, retryAfterMs: null,
      });

      const invoke = harness.supervisor.invoke('ping', ['hello']);
      harness.children[0]!.respondToLast({ pong: true });
      await expect(invoke).resolves.toEqual({ pong: true });
      expect(harness.children[0]!.lastRequest()).toMatchObject({
        method: 'invoke', payload: { target: 'method', method: 'ping', args: ['hello'] },
      });

      const invokeHandler = harness.supervisor.invokeHandler('handler-7', ['event']);
      harness.children[0]!.respondToLast({ handled: true });
      await expect(invokeHandler).resolves.toEqual({ handled: true });
      expect(harness.children[0]!.lastRequest()).toMatchObject({
        method: 'invoke', payload: { target: 'handler', handlerId: 'handler-7', args: ['event'] },
      });

      const attach = harness.supervisor.attach('consumer', { menus: [] });
      harness.children[0]!.respondToLast(null);
      await attach;
      expect(harness.children[0]!.lastRequest()).toMatchObject({
        method: 'attach', payload: { pluginName: 'consumer', contribute: { menus: [] } },
      });

      const detach = harness.supervisor.detach('consumer');
      harness.children[0]!.respondToLast(null);
      await detach;
      expect(harness.children[0]!.lastRequest()).toMatchObject({
        method: 'detach', payload: { pluginName: 'consumer' },
      });

      const snapshot: ApplicationPluginRuntimeSnapshot = {
        pluginSnapshot: [{ name: 'fixture', path: '/fixture' }],
        menuSnapshot: { revision: 2 },
        serviceSnapshot: { clock: 'ready' },
      };
      const updated = harness.supervisor.updateRuntimeSnapshot(snapshot);
      harness.children[0]!.respondToLast(null);
      await updated;
      expect(harness.children[0]!.lastRequest()).toMatchObject({ method: 'runtime-snapshot', payload: snapshot });

      const command: RuntimeCommand = {
        target: 'plugin', operation: 'call', plugin: 'other', method: 'hello', args: [],
      };
      harness.children[0]!.requestHost('runtime-command', command, '1');
      command.args.push('mutated-after-send');
      await flushMicrotasks();
      expect(harness.runtimeCommands).toEqual([{
        target: 'plugin', operation: 'call', plugin: 'other', method: 'hello', args: [],
      }]);
      expect(harness.runtimeCommands[0]).not.toBe(command);
      expect(harness.children[0]!.sent).toContainEqual(expect.objectContaining({
        kind: 'response', requestId: '1', ok: true, payload: { handled: true },
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects initialize definition metadata unless its exact canonical shape is valid', async () => {
    vi.useFakeTimers();
    try {
      for (const invalid of [
        { lifecycle: true, methods: ['ping'], extra: true },
        { lifecycle: 'yes', methods: ['ping'] },
        { lifecycle: true, methods: ['ping', 'ping'] },
        { lifecycle: true, methods: ['zeta', 'alpha'] },
        { lifecycle: true, methods: [''] },
      ]) {
        const harness = createHarness();
        const started = harness.supervisor.start();
        await flushMicrotasks();
        harness.children[0]!.respondToLast(invalid);
        await flushMicrotasks();

        await expect(started).rejects.toMatchObject({ code: 'APPLICATION_PLUGIN_UNAVAILABLE' });
        expect(harness.supervisor.getDefinition()).toBeUndefined();
        expect(harness.supervisor.getState().status).toBe('restarting');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects pending RPC before owner cleanup and waits for cleanup and OS exit before restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const cleanup = deferred<void>();
      const order: string[] = [];
      const harness = createHarness({
        clearOwner: () => { order.push('clear-owner'); return cleanup.promise; },
        onStateChanged: (state) => order.push(`state:${state.status}`),
        onTimer: (milliseconds) => order.push(`timer:${milliseconds}`),
      });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;
      order.length = 0;

      const pending = harness.supervisor.invoke('never-returns', []);
      harness.children[0]!.terminal({ kind: 'disconnect', final: false, code: null, signal: null, error: null });

      await expect(pending).rejects.toMatchObject({ code: 'APPLICATION_PLUGIN_UNAVAILABLE' });
      expect(order).toEqual(['clear-owner']);
      expect(harness.children[0]!.terminate).not.toHaveBeenCalled();
      cleanup.resolve();
      await flushMicrotasks();

      expect(order).toEqual(['clear-owner', 'state:restarting', 'timer:2000', 'timer:250']);
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(harness.children).toHaveLength(1);

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
      await flushMicrotasks();
      expect(order).toEqual([
        'clear-owner', 'state:restarting', 'timer:2000', 'timer:250', 'state:starting', 'timer:30000',
      ]);
      expect(harness.children).toHaveLength(2);
      expect(harness.clearOwner).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses 250, 1000, and 4000 ms backoff and fuses on the fourth failure inside 60 seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const harness = createHarness();
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      for (const [index, delay] of [250, 1_000, 4_000].entries()) {
        harness.children[index]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
        await flushMicrotasks();
        expect(harness.supervisor.getState()).toMatchObject({ status: 'restarting', retryAfterMs: delay });
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(harness.children).toHaveLength(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(harness.children).toHaveLength(index + 2);
        await initialize(harness.children[index + 1]!);
      }

      harness.children[3]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
      await flushMicrotasks();
      expect(harness.supervisor.getState()).toMatchObject({
        status: 'failed', restartCount: 3, retryAfterMs: null,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.children).toHaveLength(4);
      expect(harness.clearOwner).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the restart backoff after five minutes continuously running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const harness = createHarness();
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      for (const [index, delay] of [250, 1_000].entries()) {
        harness.children[index]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(delay);
        await initialize(harness.children[index + 1]!);
      }
      expect(harness.supervisor.getState().restartCount).toBe(2);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      harness.children[2]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
      await flushMicrotasks();
      expect(harness.supervisor.getState()).toMatchObject({
        status: 'restarting', restartCount: 1, retryAfterMs: 250,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retry clears the fuse and replaces the old generation only after its child exits', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;
      const firstGeneration = harness.supervisor.getState().generation;

      const retried = harness.supervisor.retry();
      await flushMicrotasks();
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(harness.children).toHaveLength(1);
      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 0, signal: null, error: null });
      await flushMicrotasks();
      expect(harness.children).toHaveLength(2);
      expect(harness.supervisor.getState()).toMatchObject({ status: 'starting', restartCount: 0 });
      expect(harness.supervisor.getState().generation).not.toBe(firstGeneration);
      await initialize(harness.children[1]!);
      await retried;
      expect(harness.supervisor.getState()).toMatchObject({
        status: 'running', restartCount: 0, lastFailureAt: null, error: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('escalates an explicit retry once and still waits for final child exit', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      const retried = harness.supervisor.retry();
      await flushMicrotasks();
      let settled = false;
      void retried.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: null, signal: 'SIGKILL', error: null });
      await flushMicrotasks();
      expect(harness.children).toHaveLength(2);
      await initialize(harness.children[1]!);
      await expect(retried).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends unload, escalates at 10 and 12 seconds, and never restarts an intentional stop', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      const stopped = harness.supervisor.stop();
      expect(harness.supervisor.getState().status).toBe('stopping');
      expect(harness.children[0]!.lastRequest()).toMatchObject({ method: 'unload', payload: null });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(harness.children[0]!.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(harness.children[0]!.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);
      harness.children[0]!.terminal({ kind: 'exit', final: true, code: null, signal: 'SIGKILL', error: null });
      await stopped;

      expect(harness.supervisor.getState()).toMatchObject({ status: 'stopped', retryAfterMs: null });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.children).toHaveLength(1);
      expect(harness.supervisor.getState().restartCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses shutdown while initialization is still starting', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const started = harness.supervisor.start();
      void started.catch(() => undefined);

      const stopped = harness.supervisor.stop();
      expect(harness.children[0]!.lastRequest()).toMatchObject({ method: 'shutdown', payload: null });
      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 0, signal: null, error: null });
      await stopped;
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills an unexpected-failure child after two seconds and restarts only after final exit', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ exitOnKill: true });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.terminal({ kind: 'disconnect', final: false, code: null, signal: null, error: null });
      await flushMicrotasks();
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(harness.children[0]!.kill).not.toHaveBeenCalled();
      expect(harness.children).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();

      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);
      expect(harness.children).toHaveLength(2);
      expect(harness.supervisor.getState().status).toBe('starting');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['fixed', 100, 100],
    ['moved backward', 100, -10_000],
    ['jumped forward', 100, 1_000_000_000],
  ] as const)('kills after exactly two timer seconds when now() is %s', async (_case, initialNow, finalNow) => {
    vi.useFakeTimers();
    try {
      let wallClock: number = initialNow;
      const harness = createHarness({ now: () => wallClock });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.terminal({ kind: 'disconnect', final: false, code: null, signal: null, error: null });
      await flushMicrotasks();
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      wallClock = finalNow;

      await vi.advanceTimersByTimeAsync(1_999);
      expect(harness.children[0]!.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: null, signal: 'SIGKILL', error: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts an independent two-second escalation timer for a replacement generation', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ exitOnKill: true, now: () => 100 });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.terminal({ kind: 'disconnect', final: false, code: null, signal: null, error: null });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);
      expect(harness.children).toHaveLength(2);
      await initialize(harness.children[1]!);

      harness.children[1]!.terminal({ kind: 'disconnect', final: false, code: null, signal: null, error: null });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(harness.children[1]!.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.children[1]!.kill).toHaveBeenCalledTimes(1);
      expect(harness.children).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one kill deadline and retry pending when terminate throws synchronously', async () => {
    vi.useFakeTimers();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const harness = createHarness({ throwOnTerminate: true });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.terminal({ kind: 'disconnect', final: false, code: null, signal: null, error: null });
      await flushMicrotasks();
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);

      const retried = harness.supervisor.retry();
      let retrySettled = false;
      void retried.then(() => { retrySettled = true; }, () => { retrySettled = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      harness.children[0]!.terminal({ kind: 'disconnect', final: false, code: null, signal: null, error: null });
      await vi.advanceTimersByTimeAsync(999);
      expect(harness.children[0]!.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);
      expect(retrySettled).toBe(false);
      expect(unhandledRejections).toEqual([]);

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: null, signal: 'SIGKILL', error: null });
      await flushMicrotasks();
      expect(harness.children).toHaveLength(2);
      await initialize(harness.children[1]!);
      await expect(retried).resolves.toBeUndefined();
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      vi.useRealTimers();
    }
  });

  it('isolates a throwing kill once and keeps stop pending until final exit', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ throwOnKill: true });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      const stopped = harness.supervisor.stop();
      let stopSettled = false;
      void stopped.then(() => { stopSettled = true; }, () => { stopSettled = true; });
      await vi.advanceTimersByTimeAsync(12_000);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);
      expect(stopSettled).toBe(false);

      harness.children[0]!.terminal({ kind: 'disconnect', final: false, code: null, signal: null, error: null });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);
      expect(stopSettled).toBe(false);

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: null, signal: 'SIGKILL', error: null });
      await expect(stopped).resolves.toBeUndefined();
      expect(harness.supervisor.getState().status).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the prearmed kill when terminate synchronously reports final exit', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ exitOnTerminate: true });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      const retried = harness.supervisor.retry();
      await flushMicrotasks();
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(harness.children).toHaveLength(2);
      await initialize(harness.children[1]!);
      await expect(retried).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(harness.children[0]!.kill).not.toHaveBeenCalled();
      expect(harness.supervisor.getState().status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed once when the kill timer cannot arm and retry waits for final exit', async () => {
    vi.useFakeTimers();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const harness = createHarness({
        throwOnTerminationTimer: true,
        throwOnTerminate: true,
        throwOnKill: true,
      });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.terminal({ kind: 'disconnect', final: false, code: null, signal: null, error: null });
      await flushMicrotasks();
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);

      const retried = harness.supervisor.retry();
      let retrySettled = false;
      void retried.then(() => { retrySettled = true; }, () => { retrySettled = true; });
      harness.children[0]!.terminal({ kind: 'disconnect', final: false, code: null, signal: null, error: null });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);
      expect(retrySettled).toBe(false);
      expect(unhandledRejections).toEqual([]);

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: null, signal: 'SIGKILL', error: null });
      await flushMicrotasks();
      expect(harness.children).toHaveLength(2);
      await initialize(harness.children[1]!);
      await expect(retried).resolves.toBeUndefined();
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      vi.useRealTimers();
    }
  });

  it('isolates a kill-timer setup failure in the stop callback and skips kill after synchronous final exit', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ throwOnTerminationTimer: true, exitOnTerminate: true });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      const stopped = harness.supervisor.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(stopped).resolves.toBeUndefined();
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(harness.children[0]!.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(harness.children[0]!.kill).not.toHaveBeenCalled();
      expect(harness.supervisor.getState().status).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed immediately when the kill timer returns no handle', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ omitTerminationTimerHandle: true });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.terminal({ kind: 'disconnect', final: false, code: null, signal: null, error: null });
      await flushMicrotasks();
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);
      harness.children[0]!.terminal({ kind: 'exit', final: true, code: null, signal: 'SIGKILL', error: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles retry when clearing a prearmed kill timer throws on synchronous final exit', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ exitOnTerminate: true, throwOnTerminationTimerClear: true });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      const retried = harness.supervisor.retry();
      await flushMicrotasks();
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(harness.children).toHaveLength(2);
      await initialize(harness.children[1]!);
      await expect(retried).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(harness.children[0]!.kill).not.toHaveBeenCalled();
      expect(harness.supervisor.getState().status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands off stop requested from a runtime-command callback without self-waiting', async () => {
    vi.useFakeTimers();
    try {
      let supervisor!: ApplicationPluginSupervisor;
      const harness = createHarness({ handleRuntimeCommand: async () => supervisor.stop() });
      supervisor = harness.supervisor;
      const started = supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.requestHost('runtime-command', { target: 'notifications', operation: 'list' }, '1');
      await flushMicrotasks();
      expect(supervisor.getState().status).toBe('stopping');
      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 0, signal: null, error: null });
      await flushMicrotasks();
      expect(supervisor.getState().status).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands off retry requested from a runtime-command callback without self-waiting', async () => {
    vi.useFakeTimers();
    try {
      let supervisor!: ApplicationPluginSupervisor;
      const gate = deferred<void>();
      const order: string[] = [];
      const harness = createHarness({
        handleRuntimeCommand: async () => {
          order.push('command-start');
          await Promise.resolve();
          await supervisor.retry();
          order.push('retry-handed-off');
          await gate.promise;
          order.push('command-end');
          return null;
        },
        clearOwner: () => { order.push('clear-owner'); },
      });
      supervisor = harness.supervisor;
      const started = supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.requestHost('runtime-command', { target: 'notifications', operation: 'list' }, '1');
      await flushMicrotasks();
      expect(order).toEqual(['command-start', 'retry-handed-off']);
      gate.resolve();
      await flushMicrotasks();
      expect(order).toEqual(['command-start', 'retry-handed-off', 'command-end', 'clear-owner']);
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 0, signal: null, error: null });
      await flushMicrotasks();
      expect(harness.children).toHaveLength(2);
      await initialize(harness.children[1]!);
      expect(supervisor.getState().status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the real stop task to a timer descendant after its runtime callback settles', async () => {
    vi.useFakeTimers();
    try {
      let supervisor!: ApplicationPluginSupervisor;
      let descendantStop: Promise<void> | undefined;
      const descendantStarted = deferred<void>();
      const cleanup = deferred<void>();
      const harness = createHarness({
        handleRuntimeCommand: async () => {
          setNativeTimeout(() => {
            descendantStop = supervisor.stop();
            descendantStarted.resolve();
          }, 0);
          return null;
        },
        clearOwner: () => cleanup.promise,
      });
      supervisor = harness.supervisor;
      const started = supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.requestHost('runtime-command', { target: 'notifications', operation: 'list' }, '1');
      await flushMicrotasks();
      await descendantStarted.promise;
      expect(descendantStop).toBeDefined();

      let settled = false;
      void descendantStop!.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(12_000);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: null, signal: 'SIGKILL', error: null });
      await flushMicrotasks();
      expect(settled).toBe(false);
      cleanup.resolve();
      await expect(descendantStop).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates retry rejection to a timer descendant after its runtime callback settles', async () => {
    vi.useFakeTimers();
    try {
      let supervisor!: ApplicationPluginSupervisor;
      let descendantRetry: Promise<void> | undefined;
      const descendantStarted = deferred<void>();
      const harness = createHarness({
        handleRuntimeCommand: async () => {
          setNativeTimeout(() => {
            descendantRetry = supervisor.retry();
            descendantStarted.resolve();
          }, 0);
          return null;
        },
        clearOwner: () => { throw new Error('cleanup failed'); },
      });
      supervisor = harness.supervisor;
      const started = supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.requestHost('runtime-command', { target: 'notifications', operation: 'list' }, '1');
      await flushMicrotasks();
      await descendantStarted.promise;
      expect(descendantRetry).toBeDefined();

      let settled = false;
      void descendantRetry!.then(() => { settled = true; }, () => { settled = true; });
      await flushMicrotasks();
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 0, signal: null, error: null });
      await expect(descendantRetry).rejects.toMatchObject({ code: 'APPLICATION_PLUGIN_UNAVAILABLE' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates retry rejection to a queued Promise descendant after callback settlement', async () => {
    vi.useFakeTimers();
    try {
      let supervisor!: ApplicationPluginSupervisor;
      let descendantRetry: Promise<void> | undefined;
      const descendantStarted = deferred<void>();
      const harness = createHarness({
        handleRuntimeCommand: async () => {
          void Promise.resolve().then(() => {
            descendantRetry = supervisor.retry();
            descendantStarted.resolve();
          });
          return null;
        },
        clearOwner: () => { throw new Error('cleanup failed'); },
      });
      supervisor = harness.supervisor;
      const started = supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.requestHost('runtime-command', { target: 'notifications', operation: 'list' }, '1');
      await descendantStarted.promise;
      expect(descendantRetry).toBeDefined();

      let settled = false;
      void descendantRetry!.then(() => { settled = true; }, () => { settled = true; });
      await flushMicrotasks();
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 0, signal: null, error: null });
      await expect(descendantRetry).rejects.toMatchObject({ code: 'APPLICATION_PLUGIN_UNAVAILABLE' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the real stop task to a timer descendant after clearOwner settles', async () => {
    vi.useFakeTimers();
    try {
      let supervisor!: ApplicationPluginSupervisor;
      let descendantStop: Promise<void> | undefined;
      const descendantStarted = deferred<void>();
      const harness = createHarness({
        clearOwner: () => {
          setNativeTimeout(() => {
            descendantStop = supervisor.stop();
            descendantStarted.resolve();
          }, 0);
        },
      });
      supervisor = harness.supervisor;
      const started = supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.terminal({ kind: 'disconnect', final: false, code: null, signal: null, error: null });
      await flushMicrotasks();
      await descendantStarted.promise;
      expect(descendantStop).toBeDefined();

      let settled = false;
      void descendantStop!.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: null, signal: 'SIGKILL', error: null });
      await expect(descendantStop).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a stop kill deadline when a slower failure cleanup resumes later', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let wallClock = 100;
      const cleanup = deferred<void>();
      const harness = createHarness({ clearOwner: () => cleanup.promise, now: () => wallClock });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.terminal({ kind: 'disconnect', final: false, code: null, signal: null, error: null });
      const stopped = harness.supervisor.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      wallClock = -10_000;
      cleanup.resolve();
      await flushMicrotasks();
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(harness.children[0]!.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: null, signal: 'SIGKILL', error: null });
      await stopped;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an earlier failure kill deadline when stop starts afterward', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const harness = createHarness();
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.terminal({ kind: 'disconnect', final: false, code: null, signal: null, error: null });
      await flushMicrotasks();
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      const stopped = harness.supervisor.stop();
      await vi.advanceTimersByTimeAsync(999);
      expect(harness.children[0]!.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(9_000);
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: null, signal: 'SIGKILL', error: null });
      await stopped;
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands off stop requested from clearOwner without cleanup self-waiting', async () => {
    vi.useFakeTimers();
    try {
      let supervisor!: ApplicationPluginSupervisor;
      const harness = createHarness({ clearOwner: () => supervisor.stop() });
      supervisor = harness.supervisor;
      const started = supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
      await flushMicrotasks();
      expect(supervisor.getState().status).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands off retry requested from clearOwner without cleanup self-waiting', async () => {
    vi.useFakeTimers();
    try {
      let supervisor!: ApplicationPluginSupervisor;
      const harness = createHarness({ clearOwner: () => supervisor.retry() });
      supervisor = harness.supervisor;
      const started = supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
      await flushMicrotasks();
      expect(harness.children).toHaveLength(2);
      await initialize(harness.children[1]!);
      expect(supervisor.getState().status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['extra fields', { target: 'notifications', operation: 'list', extra: true }],
    ['an unknown operation', { target: 'notifications', operation: 'unknown' }],
  ])('rejects a runtime command with %s before invoking the host', async (_case, command) => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.requestHost('runtime-command', command, '1');
      await flushMicrotasks();
      expect(harness.runtimeCommands).toEqual([]);
      expect(harness.supervisor.getState().status).toBe('restarting');
      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['duplicate', ['1', '1']],
    ['backward', ['2', '1']],
  ] as const)('fails a %s runtime-command request id without invoking it twice', async (_case, requestIds) => {
    vi.useFakeTimers();
    try {
      const gate = deferred<void>();
      const harness = createHarness({ handleRuntimeCommand: async () => gate.promise });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      for (const requestId of requestIds) {
        harness.children[0]!.requestHost(
          'runtime-command', { target: 'notifications', operation: 'list' }, requestId,
        );
      }
      await flushMicrotasks();
      expect(harness.handleRuntimeCommand).toHaveBeenCalledTimes(1);
      await expect(harness.supervisor.invoke('after-sequence-fault', [])).rejects.toMatchObject({
        code: 'APPLICATION_PLUGIN_UNAVAILABLE',
      });
      gate.resolve();
      await flushMicrotasks();
      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the 257th pending runtime command without invoking the host', async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred<void>();
      const harness = createHarness({ handleRuntimeCommand: async () => gate.promise });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      for (let requestId = 1; requestId <= 257; requestId += 1) {
        harness.children[0]!.requestHost(
          'runtime-command', { target: 'notifications', operation: 'list' }, String(requestId),
        );
      }
      await flushMicrotasks();
      expect(harness.handleRuntimeCommand).toHaveBeenCalledTimes(256);
      await expect(harness.supervisor.invoke('after-capacity-fault', [])).rejects.toMatchObject({
        code: 'APPLICATION_PLUGIN_UNAVAILABLE',
      });
      gate.resolve();
      await flushMicrotasks();
      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a frozen sanitized unavailable error with plugin and retry metadata', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ childOutput: { stdout: 'secret tail', stderr: 'private stack' } });
      const error = await harness.supervisor.invoke('before-start', []).catch((input) => input);
      expect(error).toMatchObject({
        code: 'APPLICATION_PLUGIN_UNAVAILABLE', plugin: 'fixture', retryable: true,
      });
      expect(Object.isFrozen(error)).toBe(true);
      expect((error as { stack?: unknown }).stack).toBeUndefined();
      expect(JSON.stringify(error)).not.toMatch(/secret|stack/i);

      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;
      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
      await flushMicrotasks();
      await expect(harness.supervisor.invoke('during-backoff', [])).rejects.toMatchObject({
        code: 'APPLICATION_PLUGIN_UNAVAILABLE', plugin: 'fixture', retryable: true, retryAfterMs: 250,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('observes rejected thenables from state callbacks without disrupting supervision', async () => {
    vi.useFakeTimers();
    try {
      let hostThenObserved = 0;
      let listenerThenObserved = 0;
      const rejectedThenable = (observe: () => void) => ({
        then(_resolve: (value: unknown) => void, reject: (error: Error) => void) {
          observe();
          reject(new Error('observer rejected'));
        },
      });
      const harness = createHarness({
        onStateChanged: () => rejectedThenable(() => { hostThenObserved += 1; }) as never,
      });
      harness.supervisor.subscribe(
        () => rejectedThenable(() => { listenerThenObserved += 1; }) as never,
      );

      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;
      await flushMicrotasks();
      expect(hostThenObserved).toBe(2);
      expect(listenerThenObserved).toBe(2);
      expect(harness.supervisor.getState().status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rolls back a partial message subscription setup through the failure path', async () => {
    vi.useFakeTimers();
    try {
      const scheduled: number[] = [];
      const harness = createHarness({
        throwOnMessageSubscription: 2,
        onTimer: (milliseconds) => scheduled.push(milliseconds),
      });
      let started!: Promise<unknown>;
      expect(() => { started = harness.supervisor.start(); }).not.toThrow();
      await expect(started).rejects.toMatchObject({ code: 'APPLICATION_PLUGIN_UNAVAILABLE' });
      await flushMicrotasks();
      expect(harness.children[0]!.activeMessageSubscriptions).toBe(0);
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(scheduled).not.toContain(30_000);
      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is reentrant when a state observer stops from stopping', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      let nestedStop: Promise<void> | undefined;
      harness.supervisor.subscribe((state) => {
        if (state.status === 'stopping' && !nestedStop) nestedStop = harness.supervisor.stop();
      });

      const outerStop = harness.supervisor.stop();
      expect(nestedStop).toBe(outerStop);
      await outerStop;
      expect(harness.supervisor.getState().status).toBe('stopped');
      expect(harness.children).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not spawn when a state observer stops from starting', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      let stopped: Promise<void> | undefined;
      harness.supervisor.subscribe((state) => {
        if (state.status === 'starting') stopped = harness.supervisor.stop();
      });

      const started = harness.supervisor.start();
      await expect(started).rejects.toMatchObject({ code: 'APPLICATION_PLUGIN_UNAVAILABLE' });
      await stopped;
      expect(harness.children).toHaveLength(0);
      expect(harness.supervisor.getState().status).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the first backoff when failures are more than 60 seconds apart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const harness = createHarness();
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(250);
      await initialize(harness.children[1]!);
      vi.setSystemTime(60_251);
      harness.children[1]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
      await flushMicrotasks();

      expect(harness.supervisor.getState()).toMatchObject({ restartCount: 1, retryAfterMs: 250 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a failure exactly 60 seconds old when applying the fourth-failure fuse', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const harness = createHarness();
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;
      const failureTimes = [0, 20_000, 40_000, 60_000];

      for (let index = 0; index < failureTimes.length; index += 1) {
        vi.setSystemTime(failureTimes[index]!);
        harness.children[index]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
        await flushMicrotasks();
        if (index < 3) {
          await vi.advanceTimersByTimeAsync([250, 1_000, 4_000][index]!);
          await initialize(harness.children[index + 1]!);
        }
      }

      expect(harness.supervisor.getState()).toMatchObject({ status: 'failed', restartCount: 3 });
      expect(harness.children).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when owner cleanup rejects and retries cleanup only on explicit retry', async () => {
    vi.useFakeTimers();
    try {
      let cleanupAttempts = 0;
      const harness = createHarness({
        clearOwner: () => {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) throw new Error('private cleanup details');
        },
      });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
      await flushMicrotasks();
      expect(harness.supervisor.getState()).toMatchObject({
        status: 'failed', retryAfterMs: null,
        error: { code: 'APPLICATION_PLUGIN_PROCESS_FAILED', message: 'Application plugin process failed' },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.children).toHaveLength(1);

      const retried = harness.supervisor.retry();
      await flushMicrotasks();
      expect(cleanupAttempts).toBe(2);
      expect(harness.children).toHaveLength(2);
      await initialize(harness.children[1]!);
      await retried;
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a live generation when retry cleanup fails and lets the next retry clean again', async () => {
    vi.useFakeTimers();
    try {
      let cleanupAttempts = 0;
      const harness = createHarness({
        clearOwner: () => {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) throw new Error('private cleanup details');
        },
      });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      const failedRetry = harness.supervisor.retry();
      void failedRetry.catch(() => undefined);
      await flushMicrotasks();
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 0, signal: null, error: null });
      await expect(failedRetry).rejects.toMatchObject({ code: 'APPLICATION_PLUGIN_UNAVAILABLE' });
      expect(harness.supervisor.getState()).toMatchObject({ status: 'failed', retryAfterMs: null });

      const successfulRetry = harness.supervisor.retry();
      await flushMicrotasks();
      expect(cleanupAttempts).toBe(2);
      expect(harness.children).toHaveLength(2);
      await initialize(harness.children[1]!);
      await successfulRetry;
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains an in-flight runtime command before clearing its owner', async () => {
    vi.useFakeTimers();
    try {
      const command = deferred<unknown>();
      const order: string[] = [];
      const harness = createHarness({
        handleRuntimeCommand: async () => {
          order.push('command-start');
          await command.promise;
          order.push('command-end');
          return null;
        },
        clearOwner: () => { order.push('clear-owner'); },
      });
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;
      harness.children[0]!.requestHost('runtime-command', {
        target: 'notifications', operation: 'list',
      }, '1');
      await flushMicrotasks();

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
      await flushMicrotasks();
      expect(order).toEqual(['command-start']);
      command.resolve(null);
      await flushMicrotasks();
      expect(order).toEqual(['command-start', 'command-end', 'clear-owner']);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['fatal', 'protocol', 'runtime-command'] as const)(
    'treats a %s fault as a generation failure',
    async (fault) => {
      vi.useFakeTimers();
      try {
        const harness = createHarness({
          handleRuntimeCommand: fault === 'runtime-command'
            ? async () => { throw new Error('host details must stay private'); }
            : undefined,
        });
        const started = harness.supervisor.start();
        await initialize(harness.children[0]!);
        await started;

        if (fault === 'fatal') {
          harness.children[0]!.event('fatal', { message: 'plugin stack and secret' });
        } else if (fault === 'protocol') {
          harness.children[0]!.message({ protocol: 999, generation: harness.children[0]!.generation });
        } else {
          harness.children[0]!.requestHost('runtime-command', {
            target: 'notifications', operation: 'list',
          }, '1');
        }
        await flushMicrotasks();

        expect(harness.supervisor.getState()).toMatchObject({
          status: 'restarting',
          error: { code: 'APPLICATION_PLUGIN_PROCESS_FAILED', message: 'Application plugin process failed' },
        });
        expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('times out the whole load after 30 seconds without exposing child output or stack details', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        childOutput: { stdout: 'secret stdout tail', stderr: 'secret stderr stack' },
      });
      const started = harness.supervisor.start();
      void started.catch(() => undefined);

      await vi.advanceTimersByTimeAsync(29_999);
      expect(harness.supervisor.getState().status).toBe('starting');
      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();

      const state = harness.supervisor.getState();
      expect(state).toMatchObject({
        status: 'restarting',
        error: { code: 'APPLICATION_PLUGIN_PROCESS_FAILED', message: 'Application plugin process failed' },
      });
      expect(JSON.stringify(state)).not.toMatch(/secret|stack/i);
      await expect(started).rejects.toMatchObject({ code: 'APPLICATION_PLUGIN_UNAVAILABLE' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a non-final child fault once and treats the later final exit only as confirmation', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const started = harness.supervisor.start();
      await initialize(harness.children[0]!);
      await started;

      harness.children[0]!.terminal({
        kind: 'error', final: false, code: null, signal: null,
        error: { code: 'EPIPE', message: 'sanitized' },
      });
      await flushMicrotasks();
      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
      await flushMicrotasks();

      expect(harness.clearOwner).toHaveBeenCalledTimes(1);
      expect(harness.supervisor.getState()).toMatchObject({ restartCount: 1, retryAfterMs: 250 });
      await vi.advanceTimersByTimeAsync(250);
      expect(harness.children).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a pre-spawn final error directly and ignores stale generation messages', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ preSpawnError: true });
      const started = harness.supervisor.start();
      await expect(started).rejects.toMatchObject({ code: 'APPLICATION_PLUGIN_UNAVAILABLE' });
      await flushMicrotasks();
      expect(harness.supervisor.getState().status).toBe('restarting');
      expect(harness.children[0]!.terminate).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      await initialize(harness.children[1]!);
      expect(harness.supervisor.getState().status).toBe('running');
      harness.children[0]!.messageIncludingUnsubscribed({
        protocol: 1,
        generation: harness.children[0]!.generation,
        kind: 'event',
        event: 'fatal',
        payload: { message: 'stale' },
      });
      await flushMicrotasks();
      expect(harness.supervisor.getState().status).toBe('running');
      expect(harness.clearOwner).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

interface HarnessOptions {
  clearOwner?: () => Promise<void> | void;
  handleRuntimeCommand?: ApplicationPluginSupervisorHost['handleRuntimeCommand'];
  onStateChanged?: ApplicationPluginSupervisorHost['onStateChanged'];
  onTimer?: (milliseconds: number) => void;
  now?: () => number;
  childOutput?: { stdout: string; stderr: string };
  preSpawnError?: boolean;
  exitOnKill?: boolean;
  exitOnTerminate?: boolean;
  throwOnKill?: boolean;
  throwOnTerminate?: boolean;
  omitTerminationTimerHandle?: boolean;
  throwOnTerminationTimer?: boolean;
  throwOnTerminationTimerClear?: boolean;
  throwOnMessageSubscription?: number;
}

function createHarness(options: HarnessOptions = {}) {
  const children: FakeChild[] = [];
  const terminationTimerHandles = new Set<unknown>();
  const runtimeCommands: RuntimeCommand[] = [];
  const clearOwner = vi.fn(options.clearOwner ?? (() => undefined));
  const handleRuntimeCommand = vi.fn(options.handleRuntimeCommand ?? (async (_plugin, command) => {
    runtimeCommands.push(command);
    return { handled: true };
  }));
  const host: ApplicationPluginSupervisorHost = {
    initializePayload: () => initializePayload(),
    handleRuntimeCommand,
    clearOwner,
    onStateChanged: options.onStateChanged ?? (() => undefined),
  };
  const supervisor = new ApplicationPluginSupervisor({
    plugin: 'fixture',
    process: {
      runner: { executable: '/node', args: ['/runner.js'], runtimeMode: 'node' },
      cwd: '/framework',
      env: {},
    },
    host,
    spawn: () => {
      const child = new FakeChild(4_000 + children.length, options.childOutput, {
        exitOnKill: options.exitOnKill ?? false,
        exitOnTerminate: options.exitOnTerminate ?? false,
        throwOnKill: options.throwOnKill ?? false,
        throwOnTerminate: options.throwOnTerminate ?? false,
        throwOnMessageSubscription: options.throwOnMessageSubscription,
      });
      children.push(child);
      if (options.preSpawnError && children.length === 1) {
        child.terminal({
          kind: 'error', final: true, code: null, signal: null,
          error: { code: 'ENOENT', message: 'Application plugin process failed (ENOENT)' },
        });
      }
      return child;
    },
    timers: {
      setTimeout(callback, milliseconds) {
        options.onTimer?.(milliseconds);
        if (options.throwOnTerminationTimer && milliseconds === 2_000) {
          throw new Error('termination timer setup failed');
        }
        const handle = timers.setTimeout(callback, milliseconds);
        if (milliseconds === 2_000) terminationTimerHandles.add(handle);
        if (options.omitTerminationTimerHandle && milliseconds === 2_000) return undefined;
        return handle;
      },
      clearTimeout(handle) {
        if (options.throwOnTerminationTimerClear && terminationTimerHandles.delete(handle)) {
          throw new Error('termination timer clear failed');
        }
        terminationTimerHandles.delete(handle);
        timers.clearTimeout(handle);
      },
    },
    now: options.now ?? (() => Date.now()),
  });
  return { supervisor, children, runtimeCommands, clearOwner, handleRuntimeCommand };
}

class FakeChild implements ApplicationPluginChild {
  readonly sent: PluginProcessEnvelope[] = [];
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly terminate: ReturnType<typeof vi.fn>;
  readonly kill: ReturnType<typeof vi.fn>;
  generation = '';
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly allMessageListeners: Array<(message: unknown) => void> = [];
  private readonly terminalListeners = new Set<(terminal: ApplicationPluginChildTerminal) => void>();
  private readonly terminalHistory: ApplicationPluginChildTerminal[] = [];
  private messageSubscriptionCount = 0;

  constructor(
    readonly pid: number,
    output = { stdout: '', stderr: '' },
    private readonly options: {
      exitOnKill: boolean;
      exitOnTerminate: boolean;
      throwOnKill: boolean;
      throwOnTerminate: boolean;
      throwOnMessageSubscription?: number;
    } = { exitOnKill: false, exitOnTerminate: false, throwOnKill: false, throwOnTerminate: false },
  ) {
    this.stdoutTail = output.stdout;
    this.stderrTail = output.stderr;
    this.terminate = vi.fn(() => {
      if (this.options.throwOnTerminate) throw new Error('terminate failed');
      if (this.options.exitOnTerminate) {
        this.terminal({ kind: 'exit', final: true, code: null, signal: 'SIGTERM', error: null });
      }
      return true;
    });
    this.kill = vi.fn(() => {
      if (this.options.throwOnKill) throw new Error('kill failed');
      if (this.options.exitOnKill) {
        this.terminal({ kind: 'exit', final: true, code: null, signal: 'SIGKILL', error: null });
      }
      return true;
    });
  }

  async send(message: unknown): Promise<void> {
    const envelope = message as PluginProcessEnvelope;
    this.generation ||= envelope.generation;
    this.sent.push(envelope);
  }

  subscribeMessage(listener: (message: unknown) => void): () => void {
    this.messageSubscriptionCount += 1;
    if (this.messageSubscriptionCount === this.options.throwOnMessageSubscription) {
      throw new Error('message subscription failed');
    }
    this.messageListeners.add(listener);
    this.allMessageListeners.push(listener);
    return () => this.messageListeners.delete(listener);
  }

  get activeMessageSubscriptions(): number {
    return this.messageListeners.size;
  }

  subscribeExit(listener: (terminal: ApplicationPluginChildTerminal) => void): () => void {
    for (const terminal of this.terminalHistory) listener(terminal);
    if (!this.terminalHistory.some((terminal) => terminal.final)) this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  terminal(value: ApplicationPluginChildTerminal): void {
    this.terminalHistory.push(value);
    for (const listener of [...this.terminalListeners]) listener(value);
    if (value.final) this.terminalListeners.clear();
  }

  message(value: unknown): void {
    for (const listener of [...this.messageListeners]) listener(value);
  }

  messageIncludingUnsubscribed(value: unknown): void {
    for (const listener of this.allMessageListeners) listener(value);
  }

  event(event: string, payload: unknown): void {
    this.message({ protocol: 1, generation: this.generation, kind: 'event', event, payload });
  }

  requestHost(method: string, payload: unknown, requestId: string): void {
    this.message({ protocol: 1, generation: this.generation, kind: 'request', requestId, method, payload });
  }

  respondToLast(payload: unknown): void {
    const request = this.lastRequest();
    this.message({
      protocol: 1,
      generation: request.generation,
      kind: 'response',
      requestId: request.requestId,
      ok: true,
      payload,
    });
  }

  lastRequest(): Extract<PluginProcessEnvelope, { kind: 'request' }> {
    const request = [...this.sent].reverse().find((message) => message.kind === 'request');
    if (!request || request.kind !== 'request') throw new Error('No request was sent');
    return request;
  }
}

async function initialize(child: FakeChild): Promise<void> {
  await flushMicrotasks();
  expect(child.lastRequest()).toMatchObject({ method: 'initialize' });
  child.respondToLast({ lifecycle: true, methods: ['ping'] });
  await flushMicrotasks();
}

function initializePayload(): InitializeApplicationPluginPayload {
  return {
    entryPath: '/plugins/fixture/index.js',
    pluginName: 'fixture',
    runtime: {
      paths: { data: '/data', cache: '/cache', temp: '/temp', legacyData: [] },
      hostMode: 'web',
      pluginSnapshot: [{ name: 'fixture', path: '/plugins/fixture' }],
      menuSnapshot: {},
      serviceSnapshot: {},
      notificationCapability: true,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}
