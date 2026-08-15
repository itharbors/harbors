import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthManager } from '../auth';
import { getDeviceId, isLocalRequest } from '../auth';
import { HttpError } from '../http/errors';
import { sendJson } from '../http/json';

export function createAuthRouter(auth: AuthManager) {
  return async function authRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method || 'GET';

    // GET /api/auth/status?deviceId=xxx
    if (path === '/api/auth/status' && method === 'GET') {
      const deviceId = url.searchParams.get('deviceId') || getDeviceId(req);
      if (!deviceId) {
        throw new HttpError(400, 'DEVICE_ID_REQUIRED', 'Device ID is required');
      }
      const status = auth.getStatus(deviceId, req);
      sendJson(res, 200, status);
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
      const device = auth.approve(deviceId);
      sendJson(res, 200, device);
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
