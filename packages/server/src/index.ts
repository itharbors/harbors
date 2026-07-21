import path from 'node:path';
import { createServer } from './server';

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), '.editor.db');
const DEFAULT_KIT = process.env.CE_DEFAULT_KIT || process.env.KIT || process.env.DEFAULT_KIT;

const { start } = createServer({ dbPath: DB_PATH, defaultKit: DEFAULT_KIT });

const port = await start(PORT);
console.log(`Editor server running on http://localhost:${port}`);
console.log(`Database: ${DB_PATH}`);
if (DEFAULT_KIT) {
  console.log(`Session fallback Kit: ${DEFAULT_KIT}`);
}
