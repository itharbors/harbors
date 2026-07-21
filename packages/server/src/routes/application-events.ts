import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApplicationBootstrap, ApplicationEvent } from '../application/types';
import { HttpError } from '../http/errors';

interface ApplicationEventSource {
  getBootstrap(): ApplicationBootstrap;
  subscribe(listener: (event: ApplicationEvent) => void): () => void;
}

export function createApplicationEventsRouter(runtime: ApplicationEventSource) {
  return function applicationEventsRouter(req: IncomingMessage, res: ServerResponse): void {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname !== '/sse/application') {
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }
    if (req.method !== 'GET') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    writeEvent(res, {
      type: 'application-bootstrap',
      bootstrap: runtime.getBootstrap(),
    });

    let closed = false;
    let unsubscribe: () => void = () => undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
    };
    unsubscribe = runtime.subscribe((event) => {
      writeEvent(res, event);
      if (event.bootstrap.phase === 'stopped') {
        close();
        res.end();
      }
    });
    if (closed) unsubscribe();
    req.once('close', close);
    res.once('close', close);
  };
}

function writeEvent(res: ServerResponse, event: ApplicationEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
