import http from 'node:http';
import { selectGatewayTarget } from './routing.js';

export interface GatewayProxyOptions {
  serverPort: number;
  clientPort: number;
  isProduction: boolean;
  upstreamHost: string;
}

export function createGatewayProxyServer(options: GatewayProxyOptions): http.Server {
  return http.createServer((req, res) => {
    const target = selectGatewayTarget(req.url || '/', options.isProduction);
    proxy(req, res, target === 'server' ? options.serverPort : options.clientPort, options.upstreamHost);
  });
}

export function createGatewayProxyHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([name]) => name !== 'host' && name !== 'x-forwarded-for'),
  );
  // The Gateway is the trust boundary: never append or preserve a value
  // supplied by the browser or another untrusted client.
  headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';
  return headers;
}

function proxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetPort: number,
  upstreamHost: string,
): void {
  const proxyReq = http.request({
    hostname: upstreamHost,
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: createGatewayProxyHeaders(req),
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    console.error(`Proxy error to :${targetPort}:`, error.message);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end('Bad Gateway');
    }
  });
  req.pipe(proxyReq);
}
