import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SessionStore } from '../../src/session/store';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('SessionStore', () => {
  let store: SessionStore;
  let dbPath: string;

  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `editor-session-test-${Date.now()}.db`);
    store = new SessionStore(dbPath);
  });

  afterAll(() => {
    store.close();
    fs.unlinkSync(dbPath);
  });

  it('returns undefined for missing session', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('upserts and retrieves a session', () => {
    store.upsert({
      sessionId: 'abc123',
      workspacePath: '/home/user/project',
      savedFileList: JSON.stringify(['/src/index.ts']),
      createdAt: 1000,
      lastAccessAt: 2000,
    });

    const row = store.get('abc123');
    expect(row).toBeDefined();
    expect(row!.sessionId).toBe('abc123');
    expect(row!.workspacePath).toBe('/home/user/project');
    expect(JSON.parse(row!.savedFileList)).toEqual(['/src/index.ts']);
  });

  it('updates an existing session', () => {
    store.upsert({
      sessionId: 'abc123',
      workspacePath: '/home/user/project2',
      savedFileList: JSON.stringify(['/src/main.ts', '/src/lib.ts']),
      createdAt: 1000,
      lastAccessAt: 3000,
    });

    const row = store.get('abc123');
    expect(row!.workspacePath).toBe('/home/user/project2');
    expect(row!.lastAccessAt).toBe(3000);
  });

  it('deletes a session', () => {
    store.delete('abc123');
    expect(store.get('abc123')).toBeUndefined();
  });
});