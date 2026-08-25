import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../../src/session/store';
import { SessionManager } from '../../src/session/manager';
import { SessionRuntimeRegistry } from '../../src/session/runtime-registry';
import { SessionAccessPolicy } from '../../src/session/access-policy';
import type { Editor } from '../../src/editor/types';

describe('SessionAccessPolicy', () => {
  const stores: SessionStore[] = [];
  afterEach(() => stores.splice(0).forEach((store) => store.close()));

  it('protects base and compound runtime IDs by the persistent owner', async () => {
    const store = new SessionStore(':memory:');
    stores.push(store);
    const manager = new SessionManager(store);
    manager.getOrCreate('owned', '', 'user-a');
    const registry = new SessionRuntimeRegistry(manager, (session) => ({
      sessionId: session.sessionId, dispose: vi.fn(),
    }) as unknown as Editor);
    await registry.getOrCreate('owned', { runtimeKit: 'kit-a' });
    const policy = new SessionAccessPolicy(manager, registry);

    expect(policy.canAccessSession({ kind: 'user', userId: 'user-a', deviceId: 'a' }, 'owned')).toBe(true);
    expect(() => policy.assertAccess(
      { kind: 'user', userId: 'user-b', deviceId: 'b' }, 'owned::kit-a',
    )).toThrow(/another user/);
    expect(() => policy.assertAccess({ kind: 'anonymous' }, 'owned')).toThrow(/another user/);
    expect(() => policy.assertAccess({ kind: 'local-admin' }, 'owned::kit-a')).not.toThrow();
  });
});
