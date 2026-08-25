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
  clearStoredSessionId,
  getDeviceId,
  getRequestedDisplayName,
  getStoredSessionId,
  isLocalHostname,
  setStoredSessionId,
} from './core/storage';
import { renderWaitingForAuthorization } from './components/auth-waiting';
import type { WorkbenchContext } from '@itharbors/plugin-types';

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
    const response = await fetch('/api/kits', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Kit catalog request failed: ${response.status}`);
    const catalog: unknown = await response.json();
    if (!isKitCatalogResponse(catalog)) throw new Error('Kit catalog response is invalid');

    if (entry === 'editor') {
      app.innerHTML = '<editor-app></editor-app>';
      return;
    }
    const context = await fetchWorkbenchContext();
    const sessionId = selectStoredSession(context);
    renderKitPicker(app, catalog.kits, {
      context,
      selectedSessionId: sessionId,
      onSessionSelected: persistSelectedSession,
      onSessionCleared: clearSelectedSession,
      onContextChanged: () => void startClientApp(),
    });
  } catch {
    renderKitPickerError(app, () => void startClientApp());
  }
}

function selectStoredSession(context: WorkbenchContext): string | null {
  const url = new URL(window.location.href);
  const existing = url.searchParams.get('session') || url.searchParams.get('sessionId');
  const candidate = existing || getStoredSessionId();
  const visible = candidate && context.sessions.some((session) => session.sessionId === candidate);
  if (!visible) {
    clearStoredSessionId();
    url.searchParams.delete('session');
    url.searchParams.delete('sessionId');
    window.history.replaceState({}, '', url.toString());
    return null;
  }
  persistSelectedSession(candidate);
  return candidate;
}

function persistSelectedSession(sessionId: string): void {
  setStoredSessionId(sessionId);
  const url = new URL(window.location.href);
  url.searchParams.set('session', sessionId);
  url.searchParams.delete('sessionId');
  window.history.replaceState({}, '', url.toString());
}

function clearSelectedSession(): void {
  clearStoredSessionId();
  const url = new URL(window.location.href);
  url.searchParams.delete('session');
  url.searchParams.delete('sessionId');
  window.history.replaceState({}, '', url.toString());
}

async function fetchWorkbenchContext(): Promise<WorkbenchContext> {
  const response = await fetch('/api/workbench/context', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Workbench context request failed: ${response.status}`);
  return response.json() as Promise<WorkbenchContext>;
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
  const displayName = getRequestedDisplayName();
  const response = await fetch(`/api/auth/status?deviceId=${encodeURIComponent(deviceId)}&displayName=${encodeURIComponent(displayName)}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Auth status request failed: ${response.status}`);
  const data = await response.json() as { status?: string };
  if (data.status === 'authorized') return 'authorized';
  if (data.status === 'pending') return 'pending';
  return 'unauthorized';
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
