import type { KitMenuRoot, MenuTreeNode } from '../core/session';

interface MenuTriggerResponse {
  result?: unknown;
}

interface MenuOpenPanelResult {
  disposition: 'reuse' | 'open-window-group';
  panelInstanceId: string;
  panelName: string;
  windowGroupId: string | null;
  carrier: 'window-group' | 'floating';
  url: string | null;
}

interface MenuOpenCurrentUrlResult {
  type: 'open-current-url';
}

export interface MenuRuntimeInput {
  sessionId: string;
  menuMode?: 'single' | 'multi';
  menuTree: MenuTreeNode[];
  applicationMenuTree?: MenuTreeNode[];
  kitMenuTree?: MenuTreeNode[];
  kitMenuRoot?: KitMenuRoot | null;
}

export function mountMenuRuntime(input: MenuRuntimeInput): { dispose: () => void } {
  // Web mode: menu is handled by the server, no Electron sync needed
  return { dispose: () => {} };
}

export function getMenuModeFromURL(): 'single' | 'multi' {
  return new URLSearchParams(window.location.search).get('menuMode') === 'multi'
    ? 'multi'
    : 'single';
}

async function handleMenuOpenPanelResult(sessionId: string, payload: MenuOpenPanelResult): Promise<void> {
  if (payload.disposition === 'reuse' || !payload.url) {
    notifyEditorApp({ type: 'ce-open-panel-result', payload });
    return;
  }

  const popup = window.open(payload.url, `_ce_${payload.windowGroupId}`);
  if (popup) {
    notifyEditorApp({ type: 'ce-open-panel-result', payload });
    return;
  }

  const response = await fetch('/api/panel-instance/fallback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, panelInstanceId: payload.panelInstanceId }),
  });
  const fallback = await response.json();
  if (!response.ok) {
    throw new Error(fallback?.error || 'Failed to fallback panel');
  }
  notifyEditorApp({ type: 'ce-open-panel-floating', payload: fallback });
}

async function handleMenuOpenCurrentUrl(): Promise<void> {
  const url = window.location.href;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function notifyEditorApp(message: { type: string; payload: unknown }): void {
  window.postMessage(message, '*');
}

function isMenuOpenPanelResult(value: unknown): value is MenuOpenPanelResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.disposition === 'reuse' || candidate.disposition === 'open-window-group')
    && typeof candidate.panelInstanceId === 'string'
    && typeof candidate.panelName === 'string'
    && (typeof candidate.windowGroupId === 'string' || candidate.windowGroupId === null)
    && (candidate.carrier === 'window-group' || candidate.carrier === 'floating')
    && (typeof candidate.url === 'string' || candidate.url === null);
}

function isMenuOpenCurrentUrlResult(value: unknown): value is MenuOpenCurrentUrlResult {
  return Boolean(value)
    && typeof value === 'object'
    && (value as Record<string, unknown>).type === 'open-current-url';
}
