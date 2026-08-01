import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultAssemblyConfig } from '../../src/assembly/config';
import { createKitFixture } from '../../src/framework/__tests__/kit-fixture';
import { afterAll } from 'vitest';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const projectRoot = path.resolve(currentDir, '../../../..');
export const testKitFixture = createKitFixture();

export const testAssembly = createDefaultAssemblyConfig(projectRoot, {
  kitSources: [{ directory: testKitFixture.directory, source: 'builtin' }],
  defaultKit: testKitFixture.name,
});

afterAll(async () => {
  await testKitFixture.dispose();
});
