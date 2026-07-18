import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, type ApiErrorBody } from './errors';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface ReadBodyOptions {
  maxBytes?: number;
}

export interface ReadJsonOptions<T> extends ReadBodyOptions {
  emptyValue?: T;
}

export function readBody(
  req: IncomingMessage,
  options: ReadBodyOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        fail(new HttpError(
          413,
          'BODY_TOO_LARGE',
          `Request body exceeds ${maxBytes} bytes`,
          { maxBytes },
        ));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf-8'));
    };
    const onAborted = () => fail(new HttpError(400, 'REQUEST_ABORTED', 'Request was aborted'));
    const onError = () => fail(new HttpError(400, 'REQUEST_READ_FAILED', 'Request body could not be read'));
    const onClose = () => {
      if (!req.complete && !req.readableEnded) {
        fail(new HttpError(400, 'REQUEST_ABORTED', 'Request closed before the body completed'));
      }
    };

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
    req.once('close', onClose);
  });
}

export async function readJson<T>(
  req: IncomingMessage,
  validator: (value: unknown) => value is T,
  options: ReadJsonOptions<T> = {},
): Promise<T> {
  const body = await readBody(req, options);
  let value: unknown;
  if (body.trim().length === 0) {
    if ('emptyValue' in options) {
      value = options.emptyValue;
    } else {
      throw new HttpError(400, 'EMPTY_BODY', 'Request body is required');
    }
  } else {
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
    }
  }

  if (!validator(value)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'Request body has invalid fields');
  }
  return value;
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

export function sendHttpError(res: ServerResponse, error: HttpError): void {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
  };
  sendJson(res, error.status, body);
}
