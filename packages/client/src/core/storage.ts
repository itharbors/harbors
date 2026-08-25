const DEVICE_ID_KEY = 'harbors.deviceId';
const SESSION_ID_KEY = 'harbors.sessionId';
const DISPLAY_NAME_KEY = 'harbors.displayName';

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
    deviceId = generateUUID();
    write(DEVICE_ID_KEY, deviceId);
  }
  setDeviceIdCookie(deviceId);
  return deviceId;
}

function setDeviceIdCookie(deviceId: string): void {
  try {
    document.cookie = `deviceId=${encodeURIComponent(deviceId)}; path=/; max-age=${60 * 60 * 24 * 365}`;
  } catch {
    // Ignore cookie failures
  }
}

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts where crypto.randomUUID is unavailable.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/gu, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function getStoredSessionId(): string | null {
  return read(SESSION_ID_KEY);
}

export function setStoredSessionId(sessionId: string): void {
  write(SESSION_ID_KEY, sessionId);
}

export function clearStoredSessionId(): void {
  try { window.localStorage.removeItem(SESSION_ID_KEY); } catch { /* ignore */ }
}

export function getRequestedDisplayName(): string {
  return read(DISPLAY_NAME_KEY) ?? '';
}

export function setRequestedDisplayName(displayName: string): void {
  write(DISPLAY_NAME_KEY, displayName.trim());
}

export function isLocalHostname(): boolean {
  const hostname = window.location.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname.startsWith('127.')) return true;
  if (hostname === '::1') return true;
  return false;
}
