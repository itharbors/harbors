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
      await started;

      expect(states).toEqual(['starting', 'running']);
      expect(harness.supervisor.getState()).toMatchObject({
        status: 'running', pid: 4_000, restartCount: 0, error: null, retryAfterMs: null,
      });

      const invoke = harness.supervisor.invoke('ping', ['hello']);
      harness.children[0]!.respondToLast({ pong: true });
      await expect(invoke).resolves.toEqual({ pong: true });
      expect(harness.children[0]!.lastRequest()).toMatchObject({
        method: 'invoke', payload: { target: 'method', method: 'ping', args: ['hello'] },
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
      harness.children[0]!.requestHost('runtime-command', command, 'host-1');
      await flushMicrotasks();
      expect(harness.runtimeCommands).toEqual([command]);
      expect(harness.children[0]!.sent).toContainEqual(expect.objectContaining({
        kind: 'response', requestId: 'host-1', ok: true, payload: { handled: true },
      }));
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

      await expect(pending).rejects.toMatchObject({ code: 'APPLICATION_PLUGIN_PROCESS_UNAVAILABLE' });
      expect(order).toEqual(['clear-owner']);
      expect(harness.children[0]!.terminate).not.toHaveBeenCalled();
      cleanup.resolve();
      await flushMicrotasks();

      expect(order).toEqual(['clear-owner', 'state:restarting', 'timer:250']);
      expect(harness.children[0]!.terminate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(harness.children).toHaveLength(1);

      harness.children[0]!.terminal({ kind: 'exit', final: true, code: 1, signal: null, error: null });
      await flushMicrotasks();
      expect(order).toEqual([
        'clear-owner', 'state:restarting', 'timer:250', 'state:starting', 'timer:30000',
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
      await expect(started).rejects.toMatchObject({ code: 'APPLICATION_PLUGIN_PROCESS_STOPPED' });
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
      await expect(failedRetry).rejects.toMatchObject({ code: 'APPLICATION_PLUGIN_PROCESS_UNAVAILABLE' });
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
      }, 'in-flight');
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
          }, 'host-failure');
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
      await expect(started).rejects.toMatchObject({ code: 'APPLICATION_PLUGIN_PROCESS_UNAVAILABLE' });
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
      await expect(started).rejects.toMatchObject({ code: 'APPLICATION_PLUGIN_PROCESS_UNAVAILABLE' });
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
  childOutput?: { stdout: string; stderr: string };
  preSpawnError?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const children: FakeChild[] = [];
  const runtimeCommands: RuntimeCommand[] = [];
  const clearOwner = vi.fn(options.clearOwner ?? (() => undefined));
  const host: ApplicationPluginSupervisorHost = {
    initializePayload: () => initializePayload(),
    handleRuntimeCommand: options.handleRuntimeCommand ?? (async (_plugin, command) => {
      runtimeCommands.push(command);
      return { handled: true };
    }),
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
      const child = new FakeChild(4_000 + children.length, options.childOutput);
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
        return timers.setTimeout(callback, milliseconds);
      },
      clearTimeout: timers.clearTimeout,
    },
    now: () => Date.now(),
  });
  return { supervisor, children, runtimeCommands, clearOwner };
}

class FakeChild implements ApplicationPluginChild {
  readonly sent: PluginProcessEnvelope[] = [];
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly terminate = vi.fn(() => true);
  readonly kill = vi.fn(() => true);
  generation = '';
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly allMessageListeners: Array<(message: unknown) => void> = [];
  private readonly terminalListeners = new Set<(terminal: ApplicationPluginChildTerminal) => void>();
  private readonly terminalHistory: ApplicationPluginChildTerminal[] = [];

  constructor(readonly pid: number, output = { stdout: '', stderr: '' }) {
    this.stdoutTail = output.stdout;
    this.stderrTail = output.stderr;
  }

  async send(message: unknown): Promise<void> {
    const envelope = message as PluginProcessEnvelope;
    this.generation ||= envelope.generation;
    this.sent.push(envelope);
  }

  subscribeMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    this.allMessageListeners.push(listener);
    return () => this.messageListeners.delete(listener);
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
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
