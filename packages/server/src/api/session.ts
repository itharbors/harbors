import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionManager } from '../session/manager';
import type { Session } from '../session/manager';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http/errors';
import { readJson, sendJson } from '../http/json';
import type { RequestActor } from '../auth';
import type { SessionAccessPolicy } from '../session/access-policy';

export { readBody } from '../http/json';

export interface SessionCreateOptions {
  kit?: string;
  kitName?: string;
  kitPath?: string;
  locale?: string;
  deferred?: boolean;
}

interface SessionCreateRequest extends SessionCreateOptions {
  sessionId?: string;
  workspacePath?: string;
}

export function createSessionRouter(
  manager: SessionManager,
  onSessionCreated?: (session: Session, options: SessionCreateOptions) => void | Promise<void>,
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
      const options = await readJson(req, isSessionCreateRequest, { emptyValue: {} });
      const { sessionId, workspacePath } = options;
      const actor = access?.resolveActor(req);
      if (actor?.kind === 'anonymous') throw new HttpError(403, 'DEVICE_NOT_AUTHORIZED', 'Device is not authorized');
      if (actor?.kind === 'user' && sessionId) {
        const existing = manager.get(sessionId);
        if (!existing || existing.ownerUserId !== actor.userId) {
          throw new HttpError(403, 'SESSION_FORBIDDEN', 'Remote clients cannot create or claim arbitrary Session IDs');
        }
      }
      const id = sessionId || randomUUID();
      const existedBefore = manager.get(id) !== undefined;
      const session = manager.getOrCreate(id, workspacePath || '', actor?.kind === 'user' ? actor.userId : null);
      try {
        if (!options.deferred) await onSessionCreated?.(session, options);
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
    input.deferred,
  ].every((field) => field === undefined || typeof field === 'string' || typeof field === 'boolean');
}
