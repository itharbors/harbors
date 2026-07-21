import path from 'node:path';
import { createServer } from './server';
import { registerServerShutdown } from './process-lifecycle';

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), '.editor.db');
const DEFAULT_KIT = process.env.CE_DEFAULT_KIT || process.env.KIT || process.env.DEFAULT_KIT;

const APPLICATION_HOST_MODE = process.env.HARBORS_HOST_MODE === 'desktop' ? 'desktop' : 'web';
const HOST = process.env.HARBORS_BIND_HOST;

const { start, stop } = createServer({
  dbPath: DB_PATH,
  defaultKit: DEFAULT_KIT,
  applicationHostMode: APPLICATION_HOST_MODE,
  applicationControlToken: process.env.HARBORS_APPLICATION_TOKEN,
  host: HOST,
});
registerServerShutdown(stop);

const port = await start(PORT);
console.log(`Editor server running on http://localhost:${port}`);
console.log(`Database: ${DB_PATH}`);
if (DEFAULT_KIT) {
  console.log(`Default kit: ${DEFAULT_KIT}`);
}
