import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildDesktop } from './lib/desktop-build.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const outputRoot = path.join(repositoryRoot, 'dist', 'desktop-runtime');
const result = await buildDesktop({ repositoryRoot, outputRoot });

console.log(`Desktop runtime staged at ${result.outputRoot}`);
console.log(`Desktop runtime files: ${result.inventory.length}`);
