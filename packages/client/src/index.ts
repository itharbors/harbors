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
  getStoredSessionId,
  isLocalHostname,
  setStoredSessionId,
} from './core/storage';
import {
  renderAuthorizationLoadError,
  renderAuthorizationUserPicker,
  renderWaitingForAuthorization,
  type AuthorizationUser,
} from './components/auth-waiting';
import type { WorkbenchContext } from '@itharbors/plugin-types';
import type { KitPickerResumeState } from './components/kit-picker';

const app = document.querySelector('#app');

const deviceId = getDeviceId();
setupFetchWithDeviceId(deviceId);

export async function startClientApp(
  resumeState?: KitPickerResumeState,
  host: Element | null = app,
  remoteAccess = !isLocalHostname(),
  authorizationPollDelayMs = 2000,
): Promise<void> {
  if (!(host instanceof HTMLElement)) return;

  // Remote access: check device authorization before proceeding.
  if (remoteAccess) {
    const authorized = await waitForAuthorization(host, authorizationPollDelayMs);
    if (!authorized) return;
  }

  renderKitPickerLoading(host);
  try {
    const entry = selectHostEntry(new URL(window.location.href));
    const response = await fetch('/api/kits', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Kit catalog request failed: ${response.status}`);
    const catalog: unknown = await response.json();
    if (!isKitCatalogResponse(catalog)) throw new Error('Kit catalog response is invalid');

    const context = await fetchWorkbenchContext();
    if (entry === 'editor') {
      if (selectEditorSession(context)) {
        host.innerHTML = '<editor-app></editor-app>';
        return;
      }
    }
    const sessionId = selectUrlSession(context);
    renderKitPicker(host, catalog.kits, {
      context,
      selectedSessionId: sessionId,
      resumeState,
      onSessionSelected: persistSelectedSession,
      onSessionCleared: clearSelectedSession,
      onContextChanged: (nextState) => void startClientApp(nextState, host, remoteAccess, authorizationPollDelayMs),
    });
  } catch {
    renderKitPickerError(host, () => void startClientApp(resumeState, host, remoteAccess, authorizationPollDelayMs));
  }
}

export function selectEditorSession(context: WorkbenchContext): string | null {
  const url = new URL(window.location.href);
  const sessionId = url.searchParams.get('session')
    || url.searchParams.get('sessionId')
    || getStoredSessionId();
  if (sessionId && context.sessions.some((session) => session.sessionId === sessionId)) {
    persistSelectedSession(sessionId);
    return sessionId;
  }
  clearStoredSessionId();
  url.pathname = '/';
  for (const parameter of ['kit', 'page', 'session', 'sessionId']) url.searchParams.delete(parameter);
  window.history.replaceState({}, '', url.toString());
  return null;
}

export function selectUrlSession(context: WorkbenchContext): string | null {
  const url = new URL(window.location.href);
  const existing = url.searchParams.get('session') || url.searchParams.get('sessionId');
  const visible = existing && context.sessions.some((session) => session.sessionId === existing);
  if (!visible) {
    clearStoredSessionId();
    url.searchParams.delete('session');
    url.searchParams.delete('sessionId');
    window.history.replaceState({}, '', url.toString());
    return null;
  }
  persistSelectedSession(existing);
  return existing;
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

export async function waitForAuthorization(host: HTMLElement, pollDelayMs = 2000): Promise<boolean> {
  while (true) {
    let status: AuthorizationStatus;
    try {
      status = await fetchAuthStatus();
    } catch {
      await waitForAuthorizationRetry(host);
      continue;
    }
    if (status.status === 'authorized') return true;
    if (status.status === 'pending' && status.requestedUser) {
      renderWaitingForAuthorization(host, status.requestedUser);
      const result = await waitForPendingDecision(pollDelayMs);
      if (result === 'authorized') return true;
      if (result === 'retry') await waitForAuthorizationRetry(host);
      continue;
    }

    let users: AuthorizationUser[];
    try {
      users = await fetchAuthorizationUsers();
    } catch {
      await waitForAuthorizationRetry(host);
      continue;
    }
    await selectAndRequestAuthorization(host, users);
  }
}

interface AuthorizationStatus {
  status: 'authorized' | 'pending' | 'unauthorized';
  requestedUser?: AuthorizationUser;
}

async function fetchAuthStatus(): Promise<AuthorizationStatus> {
  const response = await fetch('/api/auth/status', {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Auth status request failed: ${response.status}`);
  const data = await response.json() as AuthorizationStatus;
  if (data.status === 'authorized' || data.status === 'pending') return data;
  return { status: 'unauthorized' };
}

async function fetchAuthorizationUsers(): Promise<AuthorizationUser[]> {
  const response = await fetch('/api/auth/users', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Authorization users request failed: ${response.status}`);
  const data = await response.json() as { users?: AuthorizationUser[] };
  return Array.isArray(data.users) ? data.users : [];
}

function selectAndRequestAuthorization(host: HTMLElement, users: AuthorizationUser[]): Promise<void> {
  return new Promise((resolve) => {
    renderAuthorizationUserPicker(host, users, async (user) => {
      const response = await fetch('/api/auth/request', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ userId: user.userId }),
      });
      if (!response.ok) throw new Error(`Authorization request failed: ${response.status}`);
      const data = await response.json() as AuthorizationStatus;
      renderWaitingForAuthorization(host, data.requestedUser ?? user);
      resolve();
    }, resolve);
  });
}

async function waitForPendingDecision(pollDelayMs: number): Promise<'authorized' | 'rejected' | 'retry'> {
  while (true) {
    await delay(pollDelayMs);
    try {
      const status = await fetchAuthStatus();
      if (status.status === 'authorized') return 'authorized';
      if (status.status === 'unauthorized') return 'rejected';
    } catch {
      return 'retry';
    }
  }
}

function waitForAuthorizationRetry(host: HTMLElement): Promise<void> {
  return new Promise((resolve) => renderAuthorizationLoadError(host, resolve));
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
