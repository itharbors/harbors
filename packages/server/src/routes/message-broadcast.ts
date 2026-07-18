import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Editor } from '../editor/types';
import { sendJson } from './utils';
import { readJson } from '../http/json';
import { HttpError } from '../http/errors';
import { isNonEmptyString, isOptionalArray, isOptionalString, isRecord } from '../http/validation';

export function createMessageBroadcastRouter(editorMap: Map<string, Editor>) {
  return async function messageBroadcastRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    }

    const url = new URL(req.url || '/', 'http://localhost');
    const body = await readJson(req, isMessageBroadcastInput);
    const sessionId = url.searchParams.get('sessionId') ?? body.sessionId;
    if (!sessionId) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Missing sessionId parameter');
    }

    const editor = editorMap.get(sessionId);
    if (!editor) {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }

    editor.message.broadcast(body.topic, ...(body.args ?? []));
    sendJson(res, 200, { ok: true });
  };
}

function isMessageBroadcastInput(value: unknown): value is {
  sessionId?: string;
  topic: string;
  args?: unknown[];
} {
  return isRecord(value)
    && isOptionalString(value.sessionId)
    && isNonEmptyString(value.topic)
    && isOptionalArray(value.args);
}
