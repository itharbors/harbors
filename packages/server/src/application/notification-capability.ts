import type {
  ApplicationHostMode,
  NotificationHostCapability,
  NotificationInput,
} from '../editor/types';
import type { KitPermission } from '@itharbors/kit-core';
import { createHmac } from 'node:crypto';

const MAX_RESPONSE_BYTES = 64 * 1024;
const ALLOWED_INPUT_KEYS = new Set(['title', 'body', 'level', 'source', 'durationMs', 'persistent']);
const LEVELS = new Set(['info', 'success', 'warning', 'error']);
const trustedFetch = globalThis.fetch.bind(globalThis);
const trustedCreateHmac = createHmac;
const OWNER_PROOF_DOMAIN = 'harbors.notification-owner.v1\0';

export class HostCapabilityError extends Error {
  constructor(readonly code: 'CAPABILITY_UNSUPPORTED' | 'CAPABILITY_NOT_PERMITTED', message: string) {
    super(message);
    this.name = 'HostCapabilityError';
  }
}

export function createNotificationCapability(options: {
  hostMode: ApplicationHostMode;
  permissions: readonly KitPermission[];
  owner: string;
  ownerAuthToken?: string;
  port?: number;
  fetch?: typeof fetch;
}): NotificationHostCapability {
  if (options.hostMode !== 'desktop' || !Number.isInteger(options.port) || !options.ownerAuthToken) {
    throw new HostCapabilityError('CAPABILITY_UNSUPPORTED', 'Notification capability is unsupported by this host');
  }
  if (!options.permissions.includes('notifications')) {
    throw new HostCapabilityError('CAPABILITY_NOT_PERMITTED', 'Notification capability is not permitted');
  }
  const ownerAuthToken = options.ownerAuthToken;
  const ownerProof = trustedCreateHmac('sha256', ownerAuthToken)
    .update(OWNER_PROOF_DOMAIN).update(options.owner).digest('hex');
  const request = createRequester(options.port!, options.fetch ?? trustedFetch);
  return Object.freeze({
    create: (input: NotificationInput) => request('/v1/notifications', {
      method: 'POST',
      // The loopback host uses this server-authored identity only for desktop navigation.
      headers: {
        'content-type': 'application/json',
        'x-harbors-plugin-owner': options.owner,
        'x-harbors-owner-proof': ownerProof,
      },
      body: JSON.stringify(normalizeInput(input)),
    }).then(assertRecord),
    list: () => request('/v1/notifications').then(assertSnapshot),
    markRead: (id: string) => request(`/v1/notifications/${encodeId(id)}/read`, { method: 'POST' }).then(assertRecord),
    markAllRead: () => request('/v1/notifications/read-all', { method: 'POST' }).then(assertUnreadCount),
    remove: (id: string) => request(`/v1/notifications/${encodeId(id)}`, { method: 'DELETE' }),
  }) as NotificationHostCapability;
}

function assertRecord(value: any) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string'
    || typeof value.title !== 'string' || typeof value.body !== 'string'
    || !LEVELS.has(value.level) || !(typeof value.source === 'string' || value.source === null)
    || !(Number.isInteger(value.durationMs) || value.durationMs === null)
    || typeof value.persistent !== 'boolean' || typeof value.createdAt !== 'string'
    || typeof value.read !== 'boolean'
    || (value.pluginOwner !== undefined && typeof value.pluginOwner !== 'string')) {
    throw new Error('Notification Host returned an invalid record');
  }
  return value;
}

function assertSnapshot(value: any) {
  if (!value || !Array.isArray(value.notifications) || !Number.isInteger(value.unreadCount)) throw new Error('Notification Host returned an invalid snapshot');
  return { notifications: value.notifications.map(assertRecord), unreadCount: value.unreadCount };
}

function assertUnreadCount(value: any) {
  if (!value || !Number.isInteger(value.unreadCount)) throw new Error('Notification Host returned an invalid unread count');
  return { unreadCount: value.unreadCount };
}

function createRequester(port: number, fetchImpl: typeof fetch) {
  if (port < 1 || port > 65535) {
    throw new HostCapabilityError('CAPABILITY_UNSUPPORTED', 'Notification capability is unsupported by this host');
  }
  return async (pathname: string, init?: RequestInit): Promise<any> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    let response: Response;
    try {
      response = await fetchImpl(`http://127.0.0.1:${port}${pathname}`, { ...init, signal: controller.signal });
      if (response.status === 204) return undefined;
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error('Notification Host response is too large');
      const text = await readBoundedText(response);
      let payload: any;
      try { payload = text ? JSON.parse(text) : null; } catch { throw new Error('Notification Host returned invalid JSON'); }
      if (!response.ok) throw new Error(payload?.error?.message ?? `Notification Host returned HTTP ${response.status}`);
      return payload;
    } catch (error) {
      if (error instanceof Error && /too large|invalid JSON|invalid record|invalid snapshot|invalid unread count|Notification Host returned HTTP/u.test(error.message)) throw error;
      throw new Error('Desktop notification service is unavailable');
    } finally { clearTimeout(timer); }
  };
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Notification Host response is too large');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

function normalizeInput(input: NotificationInput): NotificationInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Notification input must be an object');
  for (const key of Object.keys(input)) if (!ALLOWED_INPUT_KEYS.has(key)) throw new TypeError(`Unknown notification field: ${key}`);
  if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.trim().length > 120) throw new TypeError('Notification title is invalid');
  if (input.body !== undefined && (typeof input.body !== 'string' || input.body.length > 2_000)) throw new TypeError('Notification body is invalid');
  if (input.source !== undefined && (typeof input.source !== 'string' || input.source.trim().length > 80)) throw new TypeError('Notification source is invalid');
  if (input.level !== undefined && !LEVELS.has(input.level)) throw new TypeError('Notification level is invalid');
  if (input.persistent !== undefined && typeof input.persistent !== 'boolean') throw new TypeError('Notification persistent is invalid');
  if (input.durationMs !== undefined && (!Number.isInteger(input.durationMs) || input.durationMs < 1_000 || input.durationMs > 60_000)) throw new TypeError('Notification durationMs is invalid');
  return { ...input, title: input.title.trim(), ...(input.source !== undefined ? { source: input.source.trim() } : {}) };
}

function encodeId(id: string): string {
  if (typeof id !== 'string' || id.trim().length === 0 || id.length > 200) throw new TypeError('Notification id is required');
  return encodeURIComponent(id);
}
