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

const app = document.querySelector('#app');

export async function startClientApp(): Promise<void> {
  if (!(app instanceof HTMLElement)) return;
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
  if (existing) return existing;

  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deferred: true }),
  });
  if (!response.ok) throw new Error(`Session reservation failed: ${response.status}`);
  const session: unknown = await response.json();
  if (!isSessionReservation(session)) throw new Error('Session reservation response is invalid');

  url.searchParams.set('session', session.sessionId);
  window.history.replaceState({}, '', url.toString());
  return session.sessionId;
}

function isSessionReservation(value: unknown): value is { sessionId: string } {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { sessionId?: unknown }).sessionId === 'string'
    && (value as { sessionId: string }).sessionId.length > 0;
}

void startClientApp();
