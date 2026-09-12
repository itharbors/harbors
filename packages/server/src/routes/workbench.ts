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
        sessions: sessions.map(toSummary),
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

    if (userMatch && req.method === 'DELETE') {
      if (actor.kind !== 'local-admin') throw new HttpError(403, 'LOCAL_ONLY', 'Local host access required');
      if (!auth) throw new HttpError(503, 'AUTH_UNAVAILABLE', 'User storage is unavailable');
      const userId = decodeURIComponent(userMatch[1]);
      if (!auth.users.get(userId)) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
      const hasSessions = manager.list(userId).length > 0;
      if (hasSessions) {
        throw new HttpError(409, 'USER_IN_USE', 'Remove this user\'s Sessions first');
      }
      for (const device of auth.devices.list()) {
        if (device.userId === userId) auth.devices.revoke(device.deviceId);
      }
      for (const request of auth.pending.list()) {
        if (request.requestedUserId === userId) auth.pending.remove(request.deviceId);
      }
      auth.users.delete(userId);
      res.statusCode = 204;
      res.end();
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

    throw new HttpError(404, 'NOT_FOUND', 'Not found');
  };
}

function toSummary(session: { sessionId: string; ownerUserId: string; createdAt: number; lastAccessAt: number }) {
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

function isCreateSessionInput(value: unknown): value is { userId?: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && ((value as { userId?: unknown }).userId === undefined || typeof (value as { userId?: unknown }).userId === 'string');
}
