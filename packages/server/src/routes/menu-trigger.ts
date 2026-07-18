import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Editor } from '../editor/types';
import { sendJson } from './utils';
import { readJson } from '../http/json';
import { HttpError } from '../http/errors';
import { isNonEmptyString, isRecord } from '../http/validation';

export function createMenuTriggerRouter(editorMap: Map<string, Editor>) {
  return async function menuTriggerRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    }

    const body = await readJson(req, isMenuTriggerInput);

    const editor = editorMap.get(body.sessionId);
    if (!editor) {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }

    try {
      const result = await editor.menu.trigger(body.menuId);
      sendJson(res, 200, { result: withOpenPanelUrl(editor, result) });
    } catch (err) {
      if (err instanceof Error && /^Menu item ".+" not found$/.test(err.message)) {
        throw new HttpError(404, 'MENU_ITEM_NOT_FOUND', 'Menu item not found');
      }
      throw err;
    }
  };
}

function withOpenPanelUrl(editor: Editor, result: unknown): unknown {
  if (!isOpenPanelResult(result)) return result;
  return {
    ...result,
    url: result.windowGroupId
      ? `/api/window-entry/secondary?sessionId=${encodeURIComponent(editor.sessionId)}&windowGroupId=${encodeURIComponent(result.windowGroupId)}`
      : null,
  };
}

function isOpenPanelResult(value: unknown): value is {
  disposition: 'reuse' | 'open-window-group';
  panelInstanceId: string;
  panelName: string;
  windowGroupId: string | null;
  carrier: 'window-group' | 'floating';
} {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.disposition === 'reuse' || candidate.disposition === 'open-window-group')
    && typeof candidate.panelInstanceId === 'string'
    && typeof candidate.panelName === 'string'
    && (typeof candidate.windowGroupId === 'string' || candidate.windowGroupId === null)
    && (candidate.carrier === 'window-group' || candidate.carrier === 'floating');
}

function isMenuTriggerInput(value: unknown): value is { sessionId: string; menuId: string } {
  return isRecord(value)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.menuId);
}
