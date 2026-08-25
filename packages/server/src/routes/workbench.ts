import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthManager, RequestActor } from '../auth';
import type { SessionManager } from '../session/manager';
import { HttpError } from '../http/errors';
import { readJson, sendJson } from '../http/json';

type ResolveActor = (req: IncomingMessage) => RequestActor;

export function createWorkbenchRouter(
  manager: SessionManager,
  auth: AuthManager | undefined,
  resolveActor: ResolveActor,
) {
  return async function workbenchRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const actor = resolveActor(req);
    if (actor.kind === 'anonymous') throw new HttpError(403, 'DEVICE_NOT_AUTHORIZED', 'Device is not authorized');

    if (url.pathname === '/api/workbench/context' && req.method === 'GET') {
      const users = auth?.users.list() ?? [];
      const currentUser = actor.kind === 'user' ? auth?.users.get(actor.userId) ?? null : null;
      const sessions = actor.kind === 'user' ? manager.list(actor.userId) : manager.list();
      sendJson(res, 200, {
        actor: actor.kind,
        currentUser,
        users: actor.kind === 'local-admin' ? users : currentUser ? [currentUser] : [],
        sessions: sessions.filter((session) => session.ownerUserId !== null).map(toSummary),
        ownerlessSessions: actor.kind === 'local-admin' ? manager.list(null).map(toSummary) : [],
      });
      return;
    }

    if (url.pathname === '/api/workbench/user' && req.method === 'POST') {
      if (actor.kind !== 'local-admin') throw new HttpError(403, 'LOCAL_ONLY', 'Local host access required');
      if (!auth) throw new HttpError(503, 'AUTH_UNAVAILABLE', 'User storage is unavailable');
      const body = await readJson(req, isDisplayNameInput);
      sendJson(res, 201, auth.users.create(body.displayName));
      return;
    }

    const userMatch = url.pathname.match(/^\/api\/workbench\/user\/([^/]+)$/u);
    if (userMatch && req.method === 'PATCH') {
      if (actor.kind !== 'local-admin') throw new HttpError(403, 'LOCAL_ONLY', 'Local host access required');
      if (!auth) throw new HttpError(503, 'AUTH_UNAVAILABLE', 'User storage is unavailable');
      const body = await readJson(req, isDisplayNameInput);
      const user = auth.users.update(decodeURIComponent(userMatch[1]), body.displayName);
      if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
      sendJson(res, 200, user);
      return;
    }

    if (url.pathname === '/api/workbench/session' && req.method === 'POST') {
      const body = await readJson(req, isCreateSessionInput, { emptyValue: {} });
      const ownerUserId = actor.kind === 'user' ? actor.userId : body.userId;
      if (!ownerUserId || !auth?.users.get(ownerUserId)) {
        throw new HttpError(400, 'USER_REQUIRED', 'A valid user is required');
      }
      const session = manager.getOrCreate(randomUUID(), '', ownerUserId);
      sendJson(res, 201, toSummary(session));
      return;
    }

    const claim = url.pathname.match(/^\/api\/workbench\/session\/([^/]+)\/claim$/u);
    if (claim && req.method === 'POST') {
      if (actor.kind !== 'local-admin') throw new HttpError(403, 'LOCAL_ONLY', 'Local host access required');
      const body = await readJson(req, isUserInput);
      if (!auth?.users.get(body.userId)) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
      const sessionId = decodeURIComponent(claim[1]);
      const existing = manager.get(sessionId);
      if (!existing) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
      if (existing.ownerUserId !== null) throw new HttpError(409, 'SESSION_ALREADY_OWNED', 'Session already has an owner');
      if (!manager.claim(sessionId, body.userId)) throw new HttpError(409, 'SESSION_CLAIM_CONFLICT', 'Session claim conflicted');
      sendJson(res, 200, toSummary(manager.get(sessionId)!));
      return;
    }

    throw new HttpError(404, 'NOT_FOUND', 'Not found');
  };
}

function toSummary(session: { sessionId: string; ownerUserId: string | null; createdAt: number; lastAccessAt: number }) {
  return {
    sessionId: session.sessionId,
    ownerUserId: session.ownerUserId,
    createdAt: session.createdAt,
    lastAccessAt: session.lastAccessAt,
  };
}

function isDisplayNameInput(value: unknown): value is { displayName: string } {
  return !!value && typeof value === 'object' && typeof (value as { displayName?: unknown }).displayName === 'string'
    && (value as { displayName: string }).displayName.trim().length > 0
    && (value as { displayName: string }).displayName.trim().length <= 80;
}

function isUserInput(value: unknown): value is { userId: string } {
  return !!value && typeof value === 'object' && typeof (value as { userId?: unknown }).userId === 'string'
    && (value as { userId: string }).userId.length > 0;
}

function isCreateSessionInput(value: unknown): value is { userId?: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && ((value as { userId?: unknown }).userId === undefined || typeof (value as { userId?: unknown }).userId === 'string');
}
