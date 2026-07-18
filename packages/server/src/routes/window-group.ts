import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Editor } from '../editor/types';
import { sendJson } from './utils';
import { readJson } from '../http/json';
import { HttpError } from '../http/errors';
import { isNonEmptyString, isOptionalString, isRecord } from '../http/validation';

export function createWindowGroupRouter(editorMap: Map<string, Editor>) {
  return async function windowGroupRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method !== 'POST' || url.pathname !== '/api/window-group/close') {
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }

    const body = await readJson(req, isWindowGroupInput);

    const sessionId = normalizeSessionId(body);
    if (!sessionId || !isNonEmptyString(body.windowGroupId)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Missing sessionId or windowGroupId');
    }

    const editor = editorMap.get(sessionId);
    if (!editor) {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }

    editor.window.closeWindowGroup(body.windowGroupId);
    sendJson(res, 200, { ok: true });
  };
}

function isWindowGroupInput(value: unknown): value is {
  session?: string;
  sessionId?: string;
  windowGroupId: string;
} {
  return isRecord(value)
    && isOptionalString(value.session)
    && isOptionalString(value.sessionId)
    && isNonEmptyString(value.windowGroupId);
}

function normalizeSessionId(body: { session?: unknown; sessionId?: unknown }): string {
  if (isNonEmptyString(body.sessionId)) return body.sessionId;
  if (isNonEmptyString(body.session)) return body.session;
  return '';
}
