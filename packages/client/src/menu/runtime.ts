import type { MenuTreeNode } from '../core/session';
import { onElectronMenuAction, openExternalUrl, syncElectronMenu } from '../electron/bridge';

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

export function mountMenuRuntime(input: { sessionId: string; menuTree: MenuTreeNode[] }): { dispose: () => void } {
  syncElectronMenu({
    sessionId: input.sessionId,
    menuTree: input.menuTree,
  });

  const dispose = onElectronMenuAction(async (payload) => {
    if (payload.sessionId !== input.sessionId) {
      return;
    }
    try {
      const response = await fetch('/api/menu/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: input.sessionId, menuId: payload.menuId }),
      });
      if (!response.ok) {
        throw new Error(`Failed to trigger menu action: ${response.status}`);
      }
      const triggerPayload = await response.json() as MenuTriggerResponse;
      if (isMenuOpenPanelResult(triggerPayload.result)) {
        await handleMenuOpenPanelResult(input.sessionId, triggerPayload.result);
      } else if (isMenuOpenCurrentUrlResult(triggerPayload.result)) {
        await handleMenuOpenCurrentUrl();
      }
    } catch (error) {
      console.error('Failed to trigger menu action', error);
    }
  });

  return { dispose };
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
  const externalOpen = openExternalUrl(url);
  if (externalOpen) {
    await externalOpen;
    return;
  }
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
