import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { HttpError } from '../http/errors';
import { readJson } from '../http/json';
import { isNonEmptyString, isRecord } from '../http/validation';
import { sendJson } from './utils';

interface ApplicationMenuRuntime {
  triggerMenu(menuId: string): Promise<unknown>;
}

export function createApplicationMenuTriggerRouter(
  runtime: ApplicationMenuRuntime,
  options: { controlToken?: string } = {},
) {
  return async function applicationMenuTriggerRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname !== '/api/application/menu/trigger') {
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }
    if (req.method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    }
    authorizeApplicationMutation(req, options.controlToken);
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

function authorizeApplicationMutation(req: IncomingMessage, expectedToken: string | undefined): void {
  if (req.headers.origin !== undefined) {
    throw new HttpError(403, 'BROWSER_ORIGIN_FORBIDDEN', 'Browser-originated application mutations are forbidden');
  }
  const contentType = singleHeader(req.headers['content-type']);
  if (!contentType || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'CONTENT_TYPE_REQUIRED', 'Content-Type must be application/json');
  }
  const suppliedToken = singleHeader(req.headers['x-harbors-application-token']);
  if (!expectedToken || !suppliedToken || !tokensEqual(expectedToken, suppliedToken)) {
    throw new HttpError(403, 'APPLICATION_CONTROL_FORBIDDEN', 'Application control token is invalid');
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function tokensEqual(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function isApplicationMenuInput(value: unknown): value is { menuId: string } {
  return isRecord(value) && isNonEmptyString(value.menuId);
}
