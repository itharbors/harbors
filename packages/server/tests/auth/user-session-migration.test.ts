import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthManager, isLocalRequest } from '../../src/auth';
import { SessionStore } from '../../src/session/store';
import type { IncomingMessage } from 'node:http';

describe('User and Session schema migration', () => {
  const files: string[] = [];
  afterEach(() => {
    for (const file of files.splice(0)) {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
    }
  });

  it('preserves old device and ownerless Session rows across repeated startup', () => {
    const dbPath = path.join(os.tmpdir(), `harbors-legacy-${Date.now()}-${Math.random()}.db`);
    files.push(dbPath);
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE authorized_devices (
        deviceId TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL
      );
      INSERT INTO authorized_devices VALUES ('old-device', 10, 9999999999999, 20);
      CREATE TABLE sessions (
        sessionId TEXT PRIMARY KEY, workspacePath TEXT NOT NULL, savedFileList TEXT NOT NULL,
        createdAt INTEGER NOT NULL, lastAccessAt INTEGER NOT NULL
      );
      INSERT INTO sessions VALUES ('old-session', '/kept', '["a.ts"]', 30, 40);
    `);
    db.close();

    for (let run = 0; run < 2; run += 1) {
      const auth = new AuthManager({ dbPath });
      const sessions = new SessionStore(dbPath);
      expect(auth.devices.get('old-device')).toMatchObject({
        deviceId: 'old-device', userId: 'legacy-device-old-device', createdAt: 10, lastSeenAt: 20,
      });
      expect(auth.users.get('legacy-device-old-device')?.displayName).toBe('设备 old-devi');
      expect(sessions.get('old-session')).toMatchObject({
        sessionId: 'old-session', workspacePath: '/kept', savedFileList: '["a.ts"]', ownerUserId: null,
      });
      sessions.close();
      auth.close();
    }
  });

  it('uses the real socket address and ignores a forged forwarded loopback header', () => {
    const req = {
      headers: { 'x-forwarded-for': '127.0.0.1' },
      socket: { remoteAddress: '203.0.113.9' },
    } as unknown as IncomingMessage;
    expect(isLocalRequest(req)).toBe(false);
  });

  it('uses a Gateway-overwritten original address only across a loopback proxy hop', () => {
    const request = (remoteAddress: string, forwarded?: string) => ({
      headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
      socket: { remoteAddress },
    }) as unknown as IncomingMessage;

    expect(isLocalRequest(request('127.0.0.1', '127.0.0.1'))).toBe(true);
    expect(isLocalRequest(request('127.0.0.1', '203.0.113.7'))).toBe(false);
    expect(isLocalRequest(request('203.0.113.7', '127.0.0.1'))).toBe(false);
    expect(isLocalRequest(request('127.0.0.1', '127.0.0.1, 203.0.113.7'))).toBe(false);
    expect(isLocalRequest(request('127.0.0.1'))).toBe(true);
  });

  it('keeps :memory: user create, approve, status, and list on one database', () => {
    const auth = new AuthManager({ dbPath: ':memory:' });
    const req = {
      headers: { 'user-agent': 'test' }, socket: { remoteAddress: '203.0.113.9' }, url: '/',
    } as unknown as IncomingMessage;
    expect(auth.getStatus('new-device', req, '张三')).toMatchObject({ status: 'pending' });
    expect(auth.listPending()[0].displayName).toBe('张三');
    const device = auth.approve('new-device');
    expect(auth.getStatus('new-device', req).user).toMatchObject({ userId: device.userId, displayName: '张三' });
    expect(auth.listAuthorized()).toEqual([
      expect.objectContaining({
        deviceId: 'new-device', userId: device.userId,
        user: expect.objectContaining({ userId: device.userId, displayName: '张三' }),
      }),
    ]);
    auth.revoke('new-device');
    expect(auth.users.get(device.userId)?.displayName).toBe('张三');
    auth.close();
  });
});
