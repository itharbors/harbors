import crypto from 'node:crypto';
import http from 'node:http';

const DEFAULT_PORT = 17896;
const DEFAULT_DURATION_MS = 8000;
const MAX_BODY_BYTES = 16 * 1024;
const LEVELS = new Set(['info', 'success', 'warning', 'error']);
const ALLOWED_INPUT_KEYS = new Set([
  'title',
  'body',
  'level',
  'source',
  'durationMs',
  'persistent',
]);

export class NotificationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'NotificationError';
    this.status = status;
    this.code = code;
  }
}

export function parseNotificationPort(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_PORT;
  }
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Notification port must be an integer between 1 and 65535');
  }
  return port;
}

export function createNotificationStore({
  randomUUID = () => crypto.randomUUID(),
  now = () => new Date(),
  maxEntries = 500,
} = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError('maxEntries must be a positive integer');
  }

  const notifications = [];
  const listeners = new Set();

  function snapshot() {
    return {
      notifications: notifications.slice().reverse().map(cloneNotification),
      unreadCount: countUnread(notifications),
    };
  }

  function emit(type, details = {}) {
    const event = {
      type,
      ...details,
      snapshot: snapshot(),
    };
    for (const listener of listeners) {
      listener(cloneEvent(event));
    }
  }

  function create(input) {
    const normalized = normalizeNotificationInput(input);
    const notification = {
      id: String(randomUUID()),
      ...normalized,
      createdAt: now().toISOString(),
      read: false,
    };
    notifications.push(notification);
    if (notifications.length > maxEntries) {
      const readIndex = notifications.findIndex((entry) => entry.read);
      notifications.splice(readIndex >= 0 ? readIndex : 0, 1);
    }
    emit('created', { notification: cloneNotification(notification) });
    return cloneNotification(notification);
  }

  function markRead(id) {
    const notification = findNotification(notifications, id);
    notification.read = true;
    emit('changed', { notification: cloneNotification(notification) });
    return cloneNotification(notification);
  }

  function markAllRead() {
    for (const notification of notifications) {
      notification.read = true;
    }
    emit('changed');
    return { unreadCount: 0 };
  }

  function remove(id) {
    const index = notifications.findIndex((entry) => entry.id === id);
    if (index < 0) {
      throw notFoundError();
    }
    notifications.splice(index, 1);
    emit('removed', { id });
    return true;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('listener must be a function');
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispose() {
    listeners.clear();
    notifications.length = 0;
  }

  return {
    create,
    snapshot,
    markRead,
    markAllRead,
    remove,
    subscribe,
    dispose,
  };
}

export function createNotificationHost({
  store,
  port = DEFAULT_PORT,
  host = '127.0.0.1',
} = {}) {
  if (!store || typeof store.create !== 'function') {
    throw new TypeError('A notification store is required');
  }
  if (host !== '127.0.0.1') {
    throw new Error('Notification Host must bind to 127.0.0.1');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Notification Host port must be between 0 and 65535');
  }

  const server = http.createServer((request, response) => {
    void dispatchRequest(request, response, store).catch((error) => {
      sendError(response, error);
    });
  });
  let activePort = null;
  let startPromise = null;
  let stopPromise = null;

  async function start() {
    if (activePort !== null) return activePort;
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve, reject) => {
      const handleError = (error) => {
        server.off('listening', handleListening);
        startPromise = null;
        reject(error);
      };
      const handleListening = () => {
        server.off('error', handleError);
        const address = server.address();
        activePort = typeof address === 'object' && address ? address.port : port;
        resolve(activePort);
      };
      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(port, host);
    });
    return startPromise;
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    if (!server.listening) {
      store.dispose();
      activePort = null;
      startPromise = null;
      return;
    }
    stopPromise = new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          stopPromise = null;
          reject(error);
          return;
        }
        store.dispose();
        activePort = null;
        startPromise = null;
        resolve();
      });
    });
    return stopPromise;
  }

  return { start, stop };
}

function normalizeNotificationInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('Notification body must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw badRequest(`Unknown notification field: ${key}`);
    }
  }

  const title = normalizeRequiredString(input.title, 'title', 120);
  const body = normalizeOptionalString(input.body, 'body', 2000, '');
  const level = input.level ?? 'info';
  if (typeof level !== 'string' || !LEVELS.has(level)) {
    throw badRequest(`level must be one of: ${Array.from(LEVELS).join(', ')}`);
  }
  const source = normalizeOptionalString(input.source, 'source', 80, null, true);
  const persistent = input.persistent ?? false;
  if (typeof persistent !== 'boolean') {
    throw badRequest('persistent must be a boolean');
  }
  const durationMs = input.durationMs ?? DEFAULT_DURATION_MS;
  if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 60000) {
    throw badRequest('durationMs must be between 1000 and 60000');
  }

  return {
    title,
    body,
    level,
    source,
    durationMs: persistent ? null : durationMs,
    persistent,
  };
}

function normalizeRequiredString(value, name, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest(`${name} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw badRequest(`${name} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizeOptionalString(value, name, maxLength, fallback, trim = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    throw badRequest(`${name} must be a string`);
  }
  const normalized = trim ? value.trim() : value;
  if (normalized.length > maxLength) {
    throw badRequest(`${name} must be at most ${maxLength} characters`);
  }
  return normalized || fallback;
}

function findNotification(notifications, id) {
  const notification = notifications.find((entry) => entry.id === id);
  if (!notification) throw notFoundError();
  return notification;
}

function countUnread(notifications) {
  return notifications.reduce((count, notification) => count + (notification.read ? 0 : 1), 0);
}

function cloneNotification(notification) {
  return { ...notification };
}

function cloneEvent(event) {
  return {
    ...event,
    ...(event.notification ? { notification: cloneNotification(event.notification) } : {}),
    snapshot: {
      notifications: event.snapshot.notifications.map(cloneNotification),
      unreadCount: event.snapshot.unreadCount,
    },
  };
}

function badRequest(message) {
  return new NotificationError(400, 'INVALID_NOTIFICATION', message);
}

function notFoundError() {
  return new NotificationError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');
}

async function dispatchRequest(request, response, store) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  if (pathname === '/health') {
    assertMethod(request, 'GET');
    sendJson(response, 200, { status: 'ok' });
    return;
  }

  if (pathname === '/v1/notifications') {
    if (request.method === 'GET') {
      sendJson(response, 200, store.snapshot());
      return;
    }
    if (request.method === 'POST') {
      const input = await readJsonBody(request);
      sendJson(response, 201, store.create(input));
      return;
    }
    throw methodNotAllowed();
  }

  if (pathname === '/v1/notifications/read-all') {
    assertMethod(request, 'POST');
    sendJson(response, 200, store.markAllRead());
    return;
  }

  const readMatch = pathname.match(/^\/v1\/notifications\/([^/]+)\/read$/u);
  if (readMatch) {
    assertMethod(request, 'POST');
    sendJson(response, 200, store.markRead(decodePathId(readMatch[1])));
    return;
  }

  const itemMatch = pathname.match(/^\/v1\/notifications\/([^/]+)$/u);
  if (itemMatch) {
    assertMethod(request, 'DELETE');
    store.remove(decodePathId(itemMatch[1]));
    response.statusCode = 204;
    response.end();
    return;
  }

  throw new NotificationError(404, 'NOT_FOUND', 'Not found');
}

function assertMethod(request, expected) {
  if (request.method !== expected) throw methodNotAllowed();
}

function methodNotAllowed() {
  return new NotificationError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
}

function decodePathId(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw badRequest('Notification id is invalid');
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) {
    throw new NotificationError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 16 KiB');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new NotificationError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

function sendJson(response, status, value) {
  const payload = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(payload));
  response.end(payload);
}

function sendError(response, error) {
  if (response.headersSent) {
    response.end();
    return;
  }
  const notificationError = error instanceof NotificationError
    ? error
    : new NotificationError(500, 'INTERNAL_ERROR', 'Internal server error');
  sendJson(response, notificationError.status, {
    error: {
      code: notificationError.code,
      message: notificationError.message,
    },
  });
}
