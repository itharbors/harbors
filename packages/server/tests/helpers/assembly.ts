import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultAssemblyConfig } from '../../src/assembly/config';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const projectRoot = path.resolve(currentDir, '../../../..');

export const testAssembly = createDefaultAssemblyConfig(projectRoot, {
  kitSources: [{ directory: path.join(projectRoot, 'kits/default'), source: 'builtin' }],
});
