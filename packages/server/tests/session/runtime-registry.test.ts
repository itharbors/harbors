import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../../src/session/manager';
import { SessionStore } from '../../src/session/store';
import { SessionRuntimeRegistry } from '../../src/session/runtime-registry';
import type { Editor } from '../../src/editor/types';

function createDisposableEditor(sessionId: string): Editor {
  return {
    sessionId,
    isUsable: () => true,
    dispose: vi.fn(async () => undefined),
  } as unknown as Editor;
}

describe('SessionRuntimeRegistry', () => {
  let store: SessionStore;
  let manager: SessionManager;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    manager = new SessionManager(store);
  });

  afterEach(() => {
    store.close();
  });

  it('deduplicates concurrent runtime creation and destroys runtime plus session', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const createRuntime = vi.fn(async (session: { sessionId: string }) => {
      await gate;
      return createDisposableEditor(session.sessionId);
    });
    const registry = new SessionRuntimeRegistry(manager, createRuntime);

    const firstPending = registry.getOrCreate('same-session', { workspacePath: '/workspace' });
    const secondPending = registry.getOrCreate('same-session', { workspacePath: '/ignored' });
    release();
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(first.editor).toBe(second.editor);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(first.session.workspacePath).toBe('/workspace');

    await expect(registry.destroy('same-session')).resolves.toBe(true);
    expect(first.editor.dispose).toHaveBeenCalledTimes(1);
    expect(manager.get('same-session')).toBeUndefined();
    expect(registry.get('same-session')).toBeUndefined();
    await expect(registry.destroy('same-session')).resolves.toBe(false);
  });

  it('removes a newly created session when runtime creation fails', async () => {
    const registry = new SessionRuntimeRegistry(manager, async () => {
      throw new Error('runtime creation failed');
    });

    await expect(registry.getOrCreate('failed-session', {})).rejects.toThrow('runtime creation failed');

    expect(registry.get('failed-session')).toBeUndefined();
    expect(manager.get('failed-session')).toBeUndefined();
  });

  it('disposes every runtime even when one disposal fails', async () => {
    const editors = new Map<string, Editor>();
    const registry = new SessionRuntimeRegistry(manager, async (session: { sessionId: string }) => {
      const editor = createDisposableEditor(session.sessionId);
      editors.set(session.sessionId, editor);
      return editor;
    });
    await registry.getOrCreate('first', {});
    await registry.getOrCreate('second', {});
    vi.mocked(editors.get('first')!.dispose).mockRejectedValueOnce(new Error('first cleanup failed'));

    await expect(registry.disposeAll()).rejects.toBeInstanceOf(AggregateError);

    expect(editors.get('first')!.dispose).toHaveBeenCalledTimes(1);
    expect(editors.get('second')!.dispose).toHaveBeenCalledTimes(1);
    expect(registry.editors.size).toBe(0);
    expect(manager.get('first')).toBeDefined();
    expect(manager.get('second')).toBeDefined();
  });
});
