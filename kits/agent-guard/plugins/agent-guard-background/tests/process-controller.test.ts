import { describe, expect, it, vi } from 'vitest';

import { ControlTargetError, createProcessController } from '../main/src/process-controller.js';
import type { VerifiedControlTarget } from '../main/src/process-controller.js';

describe('process controller', () => {
  it('revalidates every identity field and refuses hosts before signaling', async () => {
    const signal = vi.fn();
    const target = task();
    const stale = createProcessController({
      getProcess: async () => ({ ...target, processStartTime: 2000 }),
      listDescendants: async () => [], signal, saveLedger: async () => undefined,
      wait: async () => undefined,
    });
    await expect(stale.pause(target)).rejects.toMatchObject({ code: 'CONTROL_TARGET_STALE' });

    const host = { ...target, role: 'host' as const };
    const unsafe = createProcessController({
      getProcess: async () => host, listDescendants: async () => [], signal,
      saveLedger: async () => undefined, wait: async () => undefined,
    });
    await expect(unsafe.pause(host as never)).rejects.toMatchObject({ code: 'CONTROL_TARGET_UNSAFE' });
    expect(signal).not.toHaveBeenCalled();
  });

  it('pauses and resumes a verified task group idempotently', async () => {
    const target = task();
    const signal = vi.fn();
    const ledgers: unknown[] = [];
    const controller = createProcessController({
      getProcess: async () => target, listDescendants: async () => [], signal,
      saveLedger: async (entries) => { ledgers.push(entries); }, wait: async () => undefined,
    });

    await controller.pause(target, 'incident-1');
    await controller.pause(target, 'incident-1');
    await controller.resume(target);
    await controller.resume(target);

    expect(signal.mock.calls).toEqual([[-41, 'SIGSTOP'], [-41, 'SIGCONT']]);
    expect(ledgers).toHaveLength(2);
  });

  it('terminates verified recursive leaves before parents and kills only surviving originals', async () => {
    const root = task({ pid: 41, ppid: 1 });
    const child = task({ pid: 42, ppid: 41, processGroupId: 42 });
    const leaf = task({ pid: 43, ppid: 42, processGroupId: 43 });
    const live = new Map([root, child, leaf].map((item) => [item.pid, item]));
    const signal = vi.fn((pid: number, name: string) => {
      if (name === 'SIGTERM' && pid !== 42) live.delete(pid);
    });
    const controller = createProcessController({
      getProcess: async (pid) => live.get(pid) ?? null,
      listDescendants: async () => [child, leaf], signal,
      saveLedger: async () => undefined, wait: async () => undefined,
    });

    await controller.terminateRecursive(root);

    expect(signal.mock.calls).toEqual([
      [43, 'SIGTERM'], [42, 'SIGTERM'], [41, 'SIGTERM'], [42, 'SIGKILL'],
    ]);
  });

  it('exposes stable error codes', () => {
    expect(new ControlTargetError('CONTROL_TARGET_STALE', 'stale').code).toBe('CONTROL_TARGET_STALE');
  });
});

function task(overrides: Partial<VerifiedControlTarget & { ppid: number }> = {}) {
  return {
    pid: 41, ppid: 1, processStartTime: 1000, executableIdentity: 'sha256:claude',
    processGroupId: 41, role: 'task' as const, ...overrides,
  };
}
