import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthManager } from '../auth';
import { AuthorizationRequestConflictError, getDeviceId, getIdentityDeviceId, isLocalRequest } from '../auth';
import { HttpError } from '../http/errors';
import { readJson, sendJson } from '../http/json';

export function createAuthRouter(auth: AuthManager) {
  return async function authRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method || 'GET';

    // GET /api/auth/status?deviceId=xxx
    if (path === '/api/auth/status' && method === 'GET') {
      const queryDeviceId = url.searchParams.get('deviceId') ?? undefined;
      const identityDeviceId = getIdentityDeviceId(req);
      if (queryDeviceId && identityDeviceId && queryDeviceId !== identityDeviceId) {
        throw new HttpError(400, 'DEVICE_ID_MISMATCH', 'Device ID does not match the request identity');
      }
      const deviceId = validateDeviceId(identityDeviceId || queryDeviceId || getDeviceId(req));
      const status = auth.readStatus(deviceId);
      sendJson(res, 200, status);
      return;
    }

    // GET /api/auth/users
    if (path === '/api/auth/users' && method === 'GET') {
      validateDeviceId(getIdentityDeviceId(req));
      sendJson(res, 200, {
        users: auth.users.list().map(({ userId, displayName }) => ({ userId, displayName })),
      });
      return;
    }

    // POST /api/auth/request
    if (path === '/api/auth/request' && method === 'POST') {
      const deviceId = validateDeviceId(getIdentityDeviceId(req));
      const { userId } = await readJson(req, isRequestInput);
      if (auth.devices.isAuthorized(deviceId)) {
        throw new HttpError(409, 'DEVICE_ALREADY_AUTHORIZED', 'Authorized devices cannot switch users');
      }
      try {
        sendJson(res, 201, auth.requestAuthorization(deviceId, req, userId));
      } catch (error) {
        if (error instanceof AuthorizationRequestConflictError) {
          throw new HttpError(409, 'AUTH_REQUEST_USER_CONFLICT', error.message);
        }
        throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
      }
      return;
    }

    // All management routes require local access
    if (!isLocalRequest(req)) {
      throw new HttpError(403, 'LOCAL_ONLY', 'This operation is only available from the host machine');
    }

    // GET /api/auth/pending
    if (path === '/api/auth/pending' && method === 'GET') {
      sendJson(res, 200, { pending: auth.listPending() });
      return;
    }

    // POST /api/auth/approve/:deviceId
    const approveMatch = path.match(/^\/api\/auth\/approve\/(.+)$/);
    if (approveMatch && method === 'POST') {
      const deviceId = decodeURIComponent(approveMatch[1]);
      const options = await readJson(req, isApproveInput, { emptyValue: {} });
      const pending = auth.pending.get(deviceId);
      if (!pending) throw new HttpError(404, 'AUTH_REQUEST_NOT_FOUND', 'Authorization request not found');
      let device;
      try {
        if (pending.requestedUserId) {
          if (options.displayName !== undefined || (options.userId !== undefined && options.userId !== pending.requestedUserId)) {
            throw new HttpError(409, 'REQUESTED_USER_MISMATCH', 'Authorization must use the requested user');
          }
          device = auth.approveRequested(deviceId);
        } else {
          device = auth.approve(deviceId, options);
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
      }
      sendJson(res, 200, { ...device, user: auth.users.get(device.userId) });
      return;
    }

    // POST /api/auth/reject/:deviceId
    const rejectMatch = path.match(/^\/api\/auth\/reject\/(.+)$/);
    if (rejectMatch && method === 'POST') {
      const deviceId = decodeURIComponent(rejectMatch[1]);
      auth.reject(deviceId);
      res.statusCode = 204;
      res.end();
      return;
    }

    // GET /api/auth/authorized
    if (path === '/api/auth/authorized' && method === 'GET') {
      sendJson(res, 200, { authorized: auth.listAuthorized() });
      return;
    }

    // DELETE /api/auth/authorized/:deviceId
    const revokeMatch = path.match(/^\/api\/auth\/authorized\/(.+)$/);
    if (revokeMatch && method === 'DELETE') {
      const deviceId = decodeURIComponent(revokeMatch[1]);
      auth.revoke(deviceId);
      res.statusCode = 204;
      res.end();
      return;
    }

    // POST /api/auth/refresh/:deviceId
    const refreshMatch = path.match(/^\/api\/auth\/refresh\/(.+)$/);
    if (refreshMatch && method === 'POST') {
      const deviceId = decodeURIComponent(refreshMatch[1]);
      const device = auth.refresh(deviceId);
      if (!device) {
        throw new HttpError(404, 'DEVICE_NOT_FOUND', 'Device not found');
      }
      sendJson(res, 200, device);
      return;
    }

    throw new HttpError(404, 'NOT_FOUND', 'Not found');
  };
}

function validateDeviceId(deviceId: string | undefined): string {
  if (!deviceId || deviceId.length > 128) {
    throw new HttpError(400, 'DEVICE_ID_REQUIRED', 'A valid Device ID is required');
  }
  return deviceId;
}

function isRequestInput(value: unknown): value is { userId: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { userId?: unknown }).userId === 'string'
    && (value as { userId: string }).userId.length > 0
    && (value as { userId: string }).userId.length <= 128;
}

function isApproveInput(value: unknown): value is { userId?: string; displayName?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (input.userId === undefined || typeof input.userId === 'string')
    && (input.displayName === undefined || typeof input.displayName === 'string');
}
