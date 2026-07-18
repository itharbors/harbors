import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionManager } from '../session/manager';
import type { Session } from '../session/manager';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http/errors';
import { readJson, sendJson } from '../http/json';

export { readBody } from '../http/json';

export interface SessionCreateOptions {
  kit?: string;
  kitName?: string;
  kitPath?: string;
  locale?: string;
}

interface SessionCreateRequest extends SessionCreateOptions {
  sessionId?: string;
  workspacePath?: string;
}

export function createSessionRouter(
  manager: SessionManager,
  onSessionCreated?: (session: Session, options: SessionCreateOptions) => void | Promise<void>,
  onSessionDeleted?: (sessionId: string) => boolean | Promise<boolean>,
) {
  return async function sessionRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method || 'GET';

    const deleteMatch = path.match(/^\/api\/session\/(.+)$/);
    if (deleteMatch && method === 'DELETE') {
      const sessionId = decodeURIComponent(deleteMatch[1]);
      let deleted: boolean;
      if (onSessionDeleted) {
        deleted = await onSessionDeleted(sessionId);
      } else if (manager.get(sessionId)) {
        manager.destroy(sessionId);
        deleted = true;
      } else {
        deleted = false;
      }
      if (!deleted) {
        throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    // GET /api/session/:id
    const getMatch = path.match(/^\/api\/session\/(.+)$/);
    if (getMatch && method === 'GET') {
      const session = manager.get(decodeURIComponent(getMatch[1]));
      if (!session) {
        throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
      }
      sendJson(res, 200, session);
      return;
    }

    // POST /api/session
    if (path === '/api/session' && method === 'POST') {
      const options = await readJson(req, isSessionCreateRequest, { emptyValue: {} });
      const { sessionId, workspacePath } = options;
      const id = sessionId || randomUUID();
      const existedBefore = manager.get(id) !== undefined;
      const session = manager.getOrCreate(id, workspacePath || '');
      try {
        await onSessionCreated?.(session, options);
      } catch (error) {
        if (!existedBefore) {
          manager.destroy(id);
        }
        throw error;
      }
      sendJson(res, 201, manager.get(id) ?? session);
      return;
    }

    // 404 for unmatched routes
    throw new HttpError(404, 'NOT_FOUND', 'Not found');
  };
}

function isSessionCreateRequest(value: unknown): value is SessionCreateRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return [
    input.sessionId,
    input.workspacePath,
    input.kit,
    input.kitName,
    input.kitPath,
    input.locale,
  ].every((field) => field === undefined || typeof field === 'string');
}
