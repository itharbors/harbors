const DEVICE_ID_KEY = 'harbors.deviceId';
const SESSION_ID_KEY = 'harbors.sessionId';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures (private mode, quota, etc.)
  }
}

export function getDeviceId(): string {
  let deviceId = read(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    write(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

export function getStoredSessionId(): string | null {
  return read(SESSION_ID_KEY);
}

export function setStoredSessionId(sessionId: string): void {
  write(SESSION_ID_KEY, sessionId);
}

export function isLocalHostname(): boolean {
  const hostname = window.location.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname.startsWith('127.')) return true;
  if (hostname === '::1') return true;
  return false;
}
