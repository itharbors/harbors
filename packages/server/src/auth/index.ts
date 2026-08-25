import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import Database from 'better-sqlite3';
import { DeviceStore, type AuthorizedDevice, DEFAULT_TTL_MS } from './device-store';
import { PendingAuthorizationStore, type PendingAuthorization } from './pending-store';
import { UserStore, type PublicUser } from './user-store';

export interface AuthManagerOptions {
  dbPath: string;
}

export interface DeviceAuthStatus {
  status: 'authorized' | 'pending' | 'unauthorized';
  deviceId: string;
  expiresAt?: number;
  user?: PublicUser;
}

export class AuthManager {
  private readonly db: Database.Database;
  readonly devices: DeviceStore;
  readonly pending: PendingAuthorizationStore;
  readonly users: UserStore;

  constructor(options: AuthManagerOptions) {
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.users = new UserStore(this.db);
    this.devices = new DeviceStore(this.db);
    this.pending = new PendingAuthorizationStore();
  }

  /**
   * Get the authorization status for a device.
   * If the device is not authorized, it is added to the pending list.
   */
  getStatus(deviceId: string, req: IncomingMessage, displayName?: string): DeviceAuthStatus {
    if (this.devices.isAuthorized(deviceId)) {
      this.devices.touch(deviceId);
      const device = this.devices.get(deviceId);
      return {
        status: 'authorized',
        deviceId,
        expiresAt: device?.expiresAt,
        user: device ? this.users.get(device.userId) : undefined,
      };
    }

    this.pending.add(deviceId, {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? '',
      displayName,
    });

    return { status: 'pending', deviceId };
  }

  approve(deviceId: string, options: { userId?: string; displayName?: string; ttlMs?: number } = {}): AuthorizedDevice {
    const pending = this.pending.get(deviceId);
    const user = options.userId
      ? this.users.get(options.userId)
      : this.users.create(options.displayName || pending?.displayName || `设备 ${deviceId.slice(0, 8)}`);
    if (!user) throw new Error('User not found');
    this.pending.remove(deviceId);
    return this.devices.authorize(deviceId, user.userId, options.ttlMs ?? DEFAULT_TTL_MS);
  }

  reject(deviceId: string): void {
    this.pending.remove(deviceId);
  }

  revoke(deviceId: string): void {
    this.devices.revoke(deviceId);
  }

  refresh(deviceId: string, ttlMs: number = DEFAULT_TTL_MS): AuthorizedDevice | undefined {
    if (!this.devices.get(deviceId)) return undefined;
    const device = this.devices.get(deviceId);
    if (!device) return undefined;
    return this.devices.authorize(deviceId, device.userId, ttlMs);
  }

  listPending(): PendingAuthorization[] {
    return this.pending.list();
  }

  listAuthorized(): Array<AuthorizedDevice & { user?: PublicUser }> {
    return this.devices.list().map((device) => ({
      ...device,
      user: this.users.get(device.userId),
    }));
  }

  close(): void {
    this.devices.close();
    this.users.close();
    this.db.close();
  }
}

export function getClientIp(req: IncomingMessage): string {
  const immediateAddress = req.socket.remoteAddress ?? '';
  if (!isLoopbackAddress(immediateAddress)) return immediateAddress;
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded === undefined) return immediateAddress;
  if (typeof forwarded !== 'string' || forwarded.includes(',') || isIP(forwarded.trim()) === 0) return '';
  return forwarded.trim();
}

export type RequestActor =
  | { kind: 'local-admin' }
  | { kind: 'user'; userId: string; deviceId: string }
  | { kind: 'anonymous' };

export function resolveRequestActor(req: IncomingMessage, auth?: AuthManager): RequestActor {
  if (isLocalRequest(req)) return { kind: 'local-admin' };
  if (!auth) return { kind: 'local-admin' };
  const deviceId = getDeviceId(req);
  if (!deviceId || !auth.devices.isAuthorized(deviceId)) return { kind: 'anonymous' };
  const device = auth.devices.get(deviceId);
  return device ? { kind: 'user', userId: device.userId, deviceId } : { kind: 'anonymous' };
}

export type { PublicUser } from './user-store';

export function isLocalRequest(req: IncomingMessage): boolean {
  const ip = getClientIp(req);
  return isLoopbackAddress(ip);
}

function isLoopbackAddress(ip: string): boolean {
  if (!ip) return false;
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  return isIP(ip) === 4 && ip.startsWith('127.');
}

export function isLocalHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const version = isIP(host);
  if (version === 4) return host.startsWith('127.');
  if (version === 6) return host === '::1';
  return false;
}

export function getDeviceId(req: IncomingMessage): string | undefined {
  const header = req.headers['x-device-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  // Fallback to query parameter for requests that cannot set custom headers (e.g. EventSource).
  const url = new URL(req.url || '/', 'http://localhost');
  const queryDeviceId = url.searchParams.get('deviceId');
  if (queryDeviceId && queryDeviceId.length > 0) return queryDeviceId;
  // Fallback to cookie for requests from iframes (panels) that don't have the fetch wrapper.
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader === 'string') {
    const match = cookieHeader.match(/(?:^|;\s*)deviceId=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return undefined;
}
