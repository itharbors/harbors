import { describe, expect, it } from 'vitest';
import { AuthManager, isLocalRequest } from '../../src/auth';
import type { IncomingMessage } from 'node:http';

describe('Auth storage', () => {
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
