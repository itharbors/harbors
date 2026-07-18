import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SSEChannel } from './channel';

export function handleSSE(req: IncomingMessage, res: ServerResponse, channel: SSEChannel): void {
  const sessionId = extractSessionId(req.url || '/');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  channel.addClient(sessionId, res, req);
  channel.sendToClient(sessionId, res, { type: 'connected', sessionId });
}

function extractSessionId(url: string): string {
  const match = url.match(/^\/sse\/(.+)$/);
  return match ? match[1] : 'unknown';
}
