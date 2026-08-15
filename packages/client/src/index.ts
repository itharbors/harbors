import './styles/tokens.css';

import './layout/split-pane';
import './layout/divider';
import './layout/panel';
import './layout/panel-group';
import './layout/tabs';

import './components/editor-app';
import './components/window-group-app';
import {
  renderKitPicker,
  renderKitPickerError,
  renderKitPickerLoading,
} from './components/kit-picker';
import { isKitCatalogResponse, selectHostEntry } from './core/host-entry';
import {
  getDeviceId,
  getStoredSessionId,
  isLocalHostname,
  setStoredSessionId,
} from './core/storage';
import { renderWaitingForAuthorization } from './components/auth-waiting';

const app = document.querySelector('#app');

const deviceId = getDeviceId();
setupFetchWithDeviceId(deviceId);

export async function startClientApp(): Promise<void> {
  if (!(app instanceof HTMLElement)) return;

  // Remote access: check device authorization before proceeding.
  if (!isLocalHostname()) {
    const authorized = await waitForAuthorization();
    if (!authorized) return;
  }

  renderKitPickerLoading(app);
  try {
    const entry = selectHostEntry(new URL(window.location.href));
    const sessionId = entry === 'picker' ? await reservePickerSession() : '';
    const response = await fetch('/api/kits', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Kit catalog request failed: ${response.status}`);
    const catalog: unknown = await response.json();
    if (!isKitCatalogResponse(catalog)) throw new Error('Kit catalog response is invalid');

    if (entry === 'editor') {
      app.innerHTML = '<editor-app></editor-app>';
      return;
    }
    renderKitPicker(app, catalog.kits, sessionId);
  } catch {
    renderKitPickerError(app, () => void startClientApp());
  }
}

async function reservePickerSession(): Promise<string> {
  const url = new URL(window.location.href);
  const existing = url.searchParams.get('session') || url.searchParams.get('sessionId');
  if (existing) {
    setStoredSessionId(existing);
    return existing;
  }

  // Reuse the persisted session ID if available.
  const stored = getStoredSessionId();
  if (stored) {
    url.searchParams.set('session', stored);
    window.history.replaceState({}, '', url.toString());
    return stored;
  }

  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deferred: true }),
  });
  if (!response.ok) throw new Error(`Session reservation failed: ${response.status}`);
  const session: unknown = await response.json();
  if (!isSessionReservation(session)) throw new Error('Session reservation response is invalid');

  setStoredSessionId(session.sessionId);
  url.searchParams.set('session', session.sessionId);
  window.history.replaceState({}, '', url.toString());
  return session.sessionId;
}

async function waitForAuthorization(): Promise<boolean> {
  const stop = renderWaitingForAuthorization(app as HTMLElement);
  try {
    while (true) {
      const status = await fetchAuthStatus();
      if (status === 'authorized') return true;
      await delay(2000);
    }
  } catch {
    stop();
    return false;
  } finally {
    stop();
  }
}

async function fetchAuthStatus(): Promise<'authorized' | 'pending' | 'unauthorized'> {
  const response = await fetch(`/api/auth/status?deviceId=${encodeURIComponent(deviceId)}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Auth status request failed: ${response.status}`);
  const data = await response.json() as { status?: string };
  if (data.status === 'authorized') return 'authorized';
  if (data.status === 'pending') return 'pending';
  return 'unauthorized';
}

function isSessionReservation(value: unknown): value is { sessionId: string } {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { sessionId?: unknown }).sessionId === 'string'
    && (value as { sessionId: string }).sessionId.length > 0;
}

function setupFetchWithDeviceId(id: string): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (!headers.has('X-Device-Id')) {
      headers.set('X-Device-Id', id);
    }
    return originalFetch(input, { ...init, headers });
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

void startClientApp();
