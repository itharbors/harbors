import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../../src/session/manager';
import { SessionStore } from '../../src/session/store';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('SessionManager', () => {
  let manager: SessionManager;
  let store: SessionStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `editor-mgr-test-${Date.now()}.db`);
    store = new SessionStore(dbPath);
    manager = new SessionManager(store);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('creates a new session when one does not exist', () => {
    const session = manager.getOrCreate('new-session', '/home/user/project', 'user-a');

    expect(session.sessionId).toBe('new-session');
    expect(session.workspacePath).toBe('/home/user/project');
    expect(session.savedFileList).toEqual([]);
    expect(session.ownerUserId).toBe('user-a');
  });

  it('returns existing session on subsequent calls', () => {
    const s1 = manager.getOrCreate('same-session', '/path1', 'user-a');
    const s2 = manager.getOrCreate('same-session', '/path2', 'user-a');

    expect(s2.workspacePath).toBe('/path1');
  });

  it('returns undefined for unknown session', () => {
    expect(manager.get('ghost')).toBeUndefined();
  });

  it('updates lastAccessAt on getOrCreate', () => {
    const s1 = manager.getOrCreate('touch-test', '/tmp', 'user-a');
    const before = s1.lastAccessAt;

    const s2 = manager.getOrCreate('touch-test', '/tmp', 'user-a');

    expect(s2.lastAccessAt).toBeGreaterThanOrEqual(before);
  });

  it('destroys a session', () => {
    manager.getOrCreate('to-delete', '/tmp', 'user-a');
    manager.destroy('to-delete');

    expect(manager.get('to-delete')).toBeUndefined();
    expect(store.get('to-delete')).toBeUndefined();
  });
});
