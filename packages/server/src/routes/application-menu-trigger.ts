import type { IncomingMessage, ServerResponse } from 'node:http';

import { HttpError } from '../http/errors';
import { readJson } from '../http/json';
import { isNonEmptyString, isRecord } from '../http/validation';
import { sendJson } from './utils';

interface ApplicationMenuRuntime {
  triggerMenu(menuId: string): Promise<unknown>;
}

export function createApplicationMenuTriggerRouter(runtime: ApplicationMenuRuntime) {
  return async function applicationMenuTriggerRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname !== '/api/application/menu/trigger') {
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }
    if (req.method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    }
    const body = await readJson(req, isApplicationMenuInput);
    try {
      const result = await runtime.triggerMenu(body.menuId);
      sendJson(res, 200, { result });
    } catch (error) {
      if (error instanceof Error && /^Menu item ".+" not found$/.test(error.message)) {
        throw new HttpError(404, 'MENU_ITEM_NOT_FOUND', 'Menu item not found');
      }
      if (error instanceof Error && /^Application Runtime is /.test(error.message)) {
        throw new HttpError(503, 'APPLICATION_RUNTIME_UNAVAILABLE', error.message);
      }
      throw error;
    }
  };
}

function isApplicationMenuInput(value: unknown): value is { menuId: string } {
  return isRecord(value) && isNonEmptyString(value.menuId);
}
