import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApplicationBootstrap } from '../application/types';
import { HttpError } from '../http/errors';
import { sendJson } from './utils';

interface ApplicationBootstrapSource {
  getBootstrap(): ApplicationBootstrap;
}

export function createApplicationBootstrapRouter(runtime: ApplicationBootstrapSource) {
  return function applicationBootstrapRouter(req: IncomingMessage, res: ServerResponse): void {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname !== '/api/application/bootstrap') {
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }
    if (req.method !== 'GET') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    }
    sendJson(res, 200, runtime.getBootstrap());
  };
}
