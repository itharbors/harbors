import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { registerServerShutdown, startServerUntilShutdown } from '../../src/process-lifecycle';

describe('server process lifecycle', () => {
  it('runs graceful server cleanup once when termination signals race', async () => {
    const processEvents = new EventEmitter();
    const stop = vi.fn(async () => undefined);
    const onError = vi.fn();
    const unregister = registerServerShutdown(stop, processEvents, onError);

    processEvents.emit('SIGTERM');
    processEvents.emit('SIGINT');
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());

    expect(onError).not.toHaveBeenCalled();
    unregister();
    expect(processEvents.listenerCount('SIGTERM')).toBe(0);
    expect(processEvents.listenerCount('SIGINT')).toBe(0);
  });

  it('wires the production entry to the server stop lifecycle', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/index.ts'), 'utf8');

    expect(source).toContain('startServerUntilShutdown(() => start(PORT), stop)');
  });

  it('waits for shutdown cleanup when startup is cancelled by a signal', async () => {
    const processEvents = new EventEmitter();
    let rejectStart: ((error: Error) => void) | undefined;
    let releaseStop: (() => void) | undefined;
    const start = vi.fn(() => new Promise<number>((_resolve, reject) => {
      rejectStart = reject;
    }));
    const stop = vi.fn(() => new Promise<void>((resolve) => {
      releaseStop = resolve;
    }));
    let settled = false;
    const running = startServerUntilShutdown(start, stop, processEvents, vi.fn())
      .finally(() => { settled = true; });

    processEvents.emit('SIGTERM');
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    rejectStart?.(new Error('Editor server is stopping'));
    await Promise.resolve();

    expect(settled).toBe(false);
    releaseStop?.();
    await expect(running).resolves.toBeUndefined();
  });

  it('does not hide genuine startup failures', async () => {
    await expect(startServerUntilShutdown(
      async () => { throw new Error('bind failed'); },
      vi.fn(async () => undefined),
      new EventEmitter(),
      vi.fn(),
    )).rejects.toThrow('bind failed');
  });
});
