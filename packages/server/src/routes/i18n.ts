import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Editor } from '../editor/types';
import { sendJson } from './utils';
import { readJson } from '../http/json';
import { HttpError } from '../http/errors';
import { isNonEmptyString, isRecord } from '../http/validation';

export function createI18nRouter(editorMap: Map<string, Editor>) {
  return async function i18nRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    const editor = sessionId ? editorMap.get(sessionId) : undefined;

    if (!editor) {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }

    if (req.method === 'GET') {
      sendJson(res, 200, editor.i18n.getVisibleSnapshot());
      return;
    }

    if (req.method === 'POST') {
      const body = await readJson(req, isLocaleInput);
      try {
        await editor.i18n.setLocale(body.locale);
      } catch (err) {
        throw new HttpError(400, 'LOCALE_NOT_AVAILABLE', err instanceof Error ? err.message : String(err));
      }
      sendJson(res, 200, editor.i18n.getVisibleSnapshot());
      return;
    }

    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  };
}

function isLocaleInput(value: unknown): value is { locale: string } {
  return isRecord(value) && isNonEmptyString(value.locale);
}
