import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { prepareDesktopRuntime } from './lib/desktop-prepare.mjs';
import { discoverRepositoryBuiltinKits } from './lib/repository-kits.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const outputRoot = path.join(repositoryRoot, 'dist', 'desktop-runtime');
const descriptors = await discoverRepositoryBuiltinKits({ repositoryRoot });
const result = await prepareDesktopRuntime({ repositoryRoot, outputRoot, descriptors });

console.log(`Desktop runtime staged at ${result.outputRoot}`);
console.log(`Desktop builtin Kits: ${result.builtinKitIds.length}`);
