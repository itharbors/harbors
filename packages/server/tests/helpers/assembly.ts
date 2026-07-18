import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultAssemblyConfig } from '../../src/assembly/config';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export const testAssembly = createDefaultAssemblyConfig(path.resolve(currentDir, '../../../..'));
