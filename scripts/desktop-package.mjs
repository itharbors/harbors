import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDesktopPackage } from './lib/desktop-package-build.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [mode, ...extra] = process.argv.slice(2);

if (extra.length > 0 || !['dir', 'dist'].includes(mode)) {
  throw new Error('Usage: node scripts/desktop-package.mjs <dir|dist>');
}

await runDesktopPackage({ cwd: repositoryRoot, mode });
