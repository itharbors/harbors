import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionManager } from '../session/manager';
import type { Session } from '../session/manager';
import { HttpError } from '../http/errors';
import { readJson, sendJson } from '../http/json';
import type { RequestActor } from '../auth';
import type { SessionAccessPolicy } from '../session/access-policy';

export { readBody } from '../http/json';

export interface SessionInitializeOptions {
  kit?: string;
  kitName?: string;
  kitPath?: string;
  locale?: string;
}

interface SessionInitializeRequest extends SessionInitializeOptions {
  sessionId: string;
}

export function createSessionRouter(
  manager: SessionManager,
  onSessionInitialized?: (session: Session, options: SessionInitializeOptions) => void | Promise<void>,
  onSessionDeleted?: (sessionId: string) => boolean | Promise<boolean>,
  access?: { resolveActor(req: IncomingMessage): RequestActor; policy: SessionAccessPolicy },
) {
  return async function sessionRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method || 'GET';

    const deleteMatch = path.match(/^\/api\/session\/(.+)$/);
    if (deleteMatch && method === 'DELETE') {
      const sessionId = decodeURIComponent(deleteMatch[1]);
      if (access) access.policy.assertAccess(access.resolveActor(req), sessionId);
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
      if (access) access.policy.assertAccess(access.resolveActor(req), session.sessionId);
      sendJson(res, 200, session);
      return;
    }

    // POST /api/session
    if (path === '/api/session' && method === 'POST') {
      const options = await readJson(req, isSessionInitializeRequest);
      const { sessionId } = options;
      const actor = access?.resolveActor(req);
      if (actor?.kind === 'anonymous') throw new HttpError(403, 'DEVICE_NOT_AUTHORIZED', 'Device is not authorized');
      const session = manager.get(sessionId);
      if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
      if (access) access.policy.assertAccess(actor!, sessionId);
      await onSessionInitialized?.(session, options);
      sendJson(res, 200, manager.get(sessionId) ?? session);
      return;
    }

    // 404 for unmatched routes
    throw new HttpError(404, 'NOT_FOUND', 'Not found');
  };
}

function isSessionInitializeRequest(value: unknown): value is SessionInitializeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) return false;
  return [
    input.kit,
    input.kitName,
    input.kitPath,
    input.locale,
  ].every((field) => field === undefined || typeof field === 'string');
}
