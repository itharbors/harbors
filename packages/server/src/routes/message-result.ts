import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BrowserDispatchResultInput } from '@itharbors/plugin-types';
import type { BrowserRequestBroker } from '../framework/browser-request-broker';
import { readJson } from '../http/json';
import { HttpError } from '../http/errors';
import { isNonEmptyString, isRecord } from '../http/validation';

export function createMessageResultRouter(broker: BrowserRequestBroker) {
  return async function messageResultRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    }

    const body = await readJson(req, isMessageResultInput);
    const status = broker.resolve(body.sessionId, body.requestId, body.result);
    if (status === 'wrong-session') {
      throw new HttpError(409, 'REQUEST_SESSION_MISMATCH', 'Request belongs to another session');
    }
    if (status === 'missing') {
      throw new HttpError(404, 'REQUEST_NOT_FOUND', 'Request not found');
    }
    res.statusCode = 204;
    res.end();
  };
}

function isMessageResultInput(value: unknown): value is BrowserDispatchResultInput {
  if (!isRecord(value)
    || !isNonEmptyString(value.sessionId)
    || !isNonEmptyString(value.requestId)
    || !isRecord(value.result)) {
    return false;
  }
  return value.result.ok === true
    ? Object.prototype.hasOwnProperty.call(value.result, 'value')
    : value.result.ok === false && isNonEmptyString(value.result.error);
}
