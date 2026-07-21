import http from 'node:http';
import { selectGatewayTarget } from './routing';

const PORT = parseInt(process.env.PORT || '8080', 10);
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '3000', 10);
const CLIENT_PORT = parseInt(process.env.CLIENT_PORT || '5173', 10);
const IS_PROD = process.env.NODE_ENV === 'production';

const SERVER_HOST = 'localhost';

function proxy(req: http.IncomingMessage, res: http.ServerResponse, targetPort: number): void {
  const options: http.RequestOptions = {
    hostname: SERVER_HOST,
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => k !== 'host')
    ),
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`Proxy error to :${targetPort}:`, err.message);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end('Bad Gateway');
    }
  });

  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (selectGatewayTarget(url, IS_PROD) === 'server') {
    proxy(req, res, SERVER_PORT);
  } else {
    proxy(req, res, CLIENT_PORT);
  }
});

server.listen(PORT, () => {
  console.log(`Gateway running on http://localhost:${PORT}`);
  console.log(`  /api/*, /sse/* → :${SERVER_PORT} (server)`);
  console.log(`  /*             → :${IS_PROD ? SERVER_PORT : CLIENT_PORT} (${IS_PROD ? 'server' : 'vite'})`);
  console.log('');
  console.log(`Open: http://localhost:${PORT}`);
});
