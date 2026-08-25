import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayProxyHeaders, createGatewayProxyServer } from '../src/proxy.js';
import { isLocalRequest } from '../../server/src/auth/index.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('Gateway client address boundary', () => {
  it('overwrites a client-supplied forwarded chain on a real proxy hop', async () => {
    const upstream = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        forwarded: req.headers['x-forwarded-for'],
        immediate: req.socket.remoteAddress,
        localAdmin: isLocalRequest(req),
      }));
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const gateway = createGatewayProxyServer({
      serverPort: upstreamPort,
      clientPort: upstreamPort,
      isProduction: true,
      upstreamHost: '127.0.0.1',
    });
    servers.push(gateway);
    const gatewayPort = await listen(gateway);

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/health`, {
      headers: { 'x-forwarded-for': '203.0.113.4, 127.0.0.1' },
    });
    expect(await response.json()).toEqual({
      forwarded: '127.0.0.1', immediate: '127.0.0.1', localAdmin: true,
    });
  });

  it('writes the actual remote socket address instead of a forged local value', () => {
    const headers = createGatewayProxyHeaders({
      headers: { host: 'example.test', 'x-forwarded-for': '127.0.0.1' },
      socket: { remoteAddress: '203.0.113.9' },
    } as http.IncomingMessage);
    expect(headers['x-forwarded-for']).toBe('203.0.113.9');
    expect(headers.host).toBeUndefined();
  });
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  return address.port;
}
