import { createGatewayProxyServer } from './proxy';
import {
  resolveGatewayCredentialMode,
  resolveGatewayUpstreamHost,
} from './security';

const PORT = parseInt(process.env.PORT || '48380', 10);
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '48381', 10);
const CLIENT_PORT = parseInt(process.env.CLIENT_PORT || '48382', 10);
const IS_PROD = process.env.NODE_ENV === 'production';
const HOST = process.env.HARBORS_BIND_HOST;

resolveGatewayCredentialMode(process.env);

const UPSTREAM_HOST = resolveGatewayUpstreamHost(HOST);

const server = createGatewayProxyServer({
  serverPort: SERVER_PORT,
  clientPort: CLIENT_PORT,
  isProduction: IS_PROD,
  upstreamHost: UPSTREAM_HOST,
});

server.listen(PORT, HOST, () => {
  console.log(`Gateway running on http://localhost:${PORT}`);
  console.log(`  /api/*, /sse/* → :${SERVER_PORT} (server)`);
  console.log(`  /*             → :${IS_PROD ? SERVER_PORT : CLIENT_PORT} (${IS_PROD ? 'server' : 'vite'})`);
  console.log('');
  console.log(`Open: http://localhost:${PORT}`);
});
