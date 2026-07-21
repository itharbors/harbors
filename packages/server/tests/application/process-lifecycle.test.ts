import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { registerServerShutdown } from '../../src/process-lifecycle';

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

    expect(source).toContain('registerServerShutdown(stop)');
  });
});
