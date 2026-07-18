import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Editor } from '../editor/types';
import { sendJson } from './utils';
import { readJson } from '../http/json';
import { HttpError } from '../http/errors';
import { isNonEmptyString, isOptionalString, isRecord } from '../http/validation';

export function createPanelInstanceRouter(editorMap: Map<string, Editor>) {
  return async function panelInstanceRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method !== 'POST') {
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }

    const body = await readJson(req, isPanelInstanceInput);

    const sessionId = normalizeSessionId(body);
    if (!sessionId || !isNonEmptyString(body.panelInstanceId)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Missing sessionId or panelInstanceId');
    }

    const editor = editorMap.get(sessionId);
    if (!editor) {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }

    if (url.pathname === '/api/panel-instance/fallback') {
      try {
        editor.window.markPanelInstanceFloating(body.panelInstanceId);
        const instance = editor.window
          .getSnapshot()
          .panelInstances.find((item) => item.id === body.panelInstanceId);
        sendJson(res, 200, instance ?? null);
      } catch (err) {
        throw new HttpError(404, 'PANEL_INSTANCE_NOT_FOUND', err instanceof Error ? err.message : String(err));
      }
      return;
    }

    if (url.pathname === '/api/panel-instance/state') {
      if (body.state !== 'open' && body.state !== 'minimized') {
        throw new HttpError(400, 'INVALID_REQUEST', 'Missing or invalid panel instance state');
      }

      try {
        editor.window.setPanelInstanceState(body.panelInstanceId, body.state);
        const instance = editor.window
          .getSnapshot()
          .panelInstances.find((item) => item.id === body.panelInstanceId);
        sendJson(res, 200, instance ?? null);
      } catch (err) {
        throw new HttpError(404, 'PANEL_INSTANCE_NOT_FOUND', err instanceof Error ? err.message : String(err));
      }
      return;
    }

    if (url.pathname === '/api/panel-instance/close') {
      editor.window.closePanelInstance(body.panelInstanceId);
      sendJson(res, 200, { ok: true });
      return;
    }

    throw new HttpError(404, 'NOT_FOUND', 'Not found');
  };
}

function isPanelInstanceInput(value: unknown): value is {
  session?: string;
  sessionId?: string;
  panelInstanceId: string;
  state?: unknown;
} {
  return isRecord(value)
    && isOptionalString(value.session)
    && isOptionalString(value.sessionId)
    && isNonEmptyString(value.panelInstanceId);
}

function normalizeSessionId(body: { session?: unknown; sessionId?: unknown }): string {
  if (isNonEmptyString(body.sessionId)) return body.sessionId;
  if (isNonEmptyString(body.session)) return body.session;
  return '';
}
