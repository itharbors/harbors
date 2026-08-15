import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { DeviceStore, type AuthorizedDevice, DEFAULT_TTL_MS } from './device-store';
import { PendingAuthorizationStore, type PendingAuthorization } from './pending-store';

export interface AuthManagerOptions {
  dbPath: string;
}

export interface DeviceAuthStatus {
  status: 'authorized' | 'pending' | 'unauthorized';
  deviceId: string;
  expiresAt?: number;
}

export class AuthManager {
  readonly devices: DeviceStore;
  readonly pending: PendingAuthorizationStore;

  constructor(options: AuthManagerOptions) {
    this.devices = new DeviceStore(options.dbPath);
    this.pending = new PendingAuthorizationStore();
  }

  /**
   * Get the authorization status for a device.
   * If the device is not authorized, it is added to the pending list.
   */
  getStatus(deviceId: string, req: IncomingMessage): DeviceAuthStatus {
    if (this.devices.isAuthorized(deviceId)) {
      this.devices.touch(deviceId);
      const device = this.devices.get(deviceId);
      return {
        status: 'authorized',
        deviceId,
        expiresAt: device?.expiresAt,
      };
    }

    this.pending.add(deviceId, {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? '',
    });

    return { status: 'pending', deviceId };
  }

  approve(deviceId: string, ttlMs: number = DEFAULT_TTL_MS): AuthorizedDevice {
    this.pending.remove(deviceId);
    return this.devices.authorize(deviceId, ttlMs);
  }

  reject(deviceId: string): void {
    this.pending.remove(deviceId);
  }

  revoke(deviceId: string): void {
    this.devices.revoke(deviceId);
  }

  refresh(deviceId: string, ttlMs: number = DEFAULT_TTL_MS): AuthorizedDevice | undefined {
    if (!this.devices.get(deviceId)) return undefined;
    return this.devices.authorize(deviceId, ttlMs);
  }

  listPending(): PendingAuthorization[] {
    return this.pending.list();
  }

  listAuthorized(): AuthorizedDevice[] {
    return this.devices.list();
  }

  close(): void {
    this.devices.close();
  }
}

export function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  const address = req.socket.remoteAddress ?? '';
  return address;
}

export function isLocalRequest(req: IncomingMessage): boolean {
  const ip = getClientIp(req);
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  const version = isIP(ip);
  if (version === 4) return ip.startsWith('127.');
  if (version === 6) return ip === '::1';
  return false;
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
  return undefined;
}
