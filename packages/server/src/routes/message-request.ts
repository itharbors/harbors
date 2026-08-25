import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Editor } from '../editor/types';
import { sendJson } from './utils';
import { readJson } from '../http/json';
import { HttpError } from '../http/errors';
import { isNonEmptyString, isOptionalArray, isOptionalString, isRecord } from '../http/validation';
import type { PanelRequestCapability } from './panel-request-capability';

const MESSAGE_REQUEST_FAILED = 'MESSAGE_REQUEST_FAILED';
export const PANEL_CAPABILITY_INVALID = 'PANEL_CAPABILITY_INVALID';
const MAX_EXPOSED_ERROR_MESSAGE_LENGTH = 1024;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

function readOwnString(error: unknown, property: string): string | null {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, property);
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function normalizeMessageRequestError(error: unknown): HttpError {
  const rawMessage = readOwnString(error, 'message');
  const message = rawMessage && rawMessage.trim()
    ? rawMessage.slice(0, MAX_EXPOSED_ERROR_MESSAGE_LENGTH)
    : 'Message request failed';
  const rawCode = readOwnString(error, 'code');
  const code = rawCode && SAFE_ERROR_CODE.test(rawCode) ? rawCode : MESSAGE_REQUEST_FAILED;
  const status = code === 'APPLICATION_PLUGIN_UNAVAILABLE' ? 503 : 500;
  return new HttpError(status, code, message);
}

export function createMessageRequestRouter(
  editorMap: Map<string, Editor>,
  options: { panelRequestCapability?: PanelRequestCapability; assertSessionAccess?: (req: IncomingMessage, sessionId: string) => void } = {},
) {
  return async function messageRequestRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    }

    const url = new URL(req.url || '/', 'http://localhost');
    const body = await readJson(req, isMessageRequestInput);
    const sessionId = url.searchParams.get('sessionId') ?? body.sessionId;
    if (!sessionId) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Missing sessionId parameter');
    }
    options.assertSessionAccess?.(req, sessionId);

    const editor = editorMap.get(sessionId);
    if (!editor) {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }

    if (!editor.message.queryRequest(body.plugin, body.name)) {
      throw new HttpError(404, 'MESSAGE_ROUTE_NOT_FOUND', 'Message route not found');
    }
    const panelCapability = body.panelCapability;
    const hasPanelCapability = panelCapability !== undefined;
    const panelClaims = hasPanelCapability && options.panelRequestCapability
      ? options.panelRequestCapability.verify(panelCapability, sessionId)
      : undefined;
    if (hasPanelCapability && !panelClaims) {
      throw new HttpError(403, PANEL_CAPABILITY_INVALID, 'Panel capability is invalid or expired');
    }
    let result: unknown;
    try {
      if (panelClaims) {
        if (!editor.message.requestFrom) {
          throw new Error('Trusted panel message request dispatch is not configured');
        }
        result = await editor.message.requestFrom(
          panelClaims.ownerPlugin,
          body.plugin,
          body.name,
          ...(body.args ?? []),
        );
      } else {
        result = await editor.message.request(body.plugin, body.name, ...(body.args ?? []));
      }
    } catch (error) {
      throw normalizeMessageRequestError(error);
    }
    sendJson(res, 200, { result });
  };
}

function isMessageRequestInput(value: unknown): value is {
  sessionId?: string;
  plugin: string;
  name: string;
  args?: unknown[];
  panelCapability?: string;
} {
  return isRecord(value)
    && isOptionalString(value.sessionId)
    && isNonEmptyString(value.plugin)
    && isNonEmptyString(value.name)
    && isOptionalArray(value.args)
    && isOptionalString(value.panelCapability);
}
