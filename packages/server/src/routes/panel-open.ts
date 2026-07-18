import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Editor } from '../editor/types';
import { sendJson } from './utils';
import { readJson } from '../http/json';
import { HttpError } from '../http/errors';
import { isNonEmptyString, isOptionalString, isRecord } from '../http/validation';

export function createPanelOpenRouter(editorMap: Map<string, Editor>) {
  return async function panelOpenRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method !== 'POST' || url.pathname !== '/api/panel/open') {
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }

    const body = await readJson(req, isPanelOpenInput);

    const sessionId = normalizeSessionId(body);
    if (!sessionId || !isNonEmptyString(body.panelName)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Missing sessionId or panelName');
    }

    const editor = editorMap.get(sessionId);
    if (!editor) {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }

    try {
      const opened = editor.window.openPanel(body.panelName);
      const panelUrl = opened.windowGroupId
        ? `/api/window-entry/secondary?sessionId=${encodeURIComponent(editor.sessionId)}&windowGroupId=${encodeURIComponent(opened.windowGroupId)}`
        : null;
      sendJson(res, 200, { ...opened, url: panelUrl });
    } catch (err) {
      throw new HttpError(404, 'PANEL_NOT_FOUND', err instanceof Error ? err.message : String(err));
    }
  };
}

function isPanelOpenInput(value: unknown): value is {
  session?: string;
  sessionId?: string;
  panelName: string;
} {
  return isRecord(value)
    && isOptionalString(value.session)
    && isOptionalString(value.sessionId)
    && isNonEmptyString(value.panelName);
}

function normalizeSessionId(body: { session?: unknown; sessionId?: unknown }): string {
  if (isNonEmptyString(body.sessionId)) return body.sessionId;
  if (isNonEmptyString(body.session)) return body.session;
  return '';
}
