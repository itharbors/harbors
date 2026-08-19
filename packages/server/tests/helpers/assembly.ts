import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultAssemblyConfig } from '../../src/assembly/config';
import { createKitFixture } from '../../src/framework/__tests__/kit-fixture';
import { afterAll } from 'vitest';
import type { KitConfigDeclaration } from '@itharbors/kit-core';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const projectRoot = path.resolve(currentDir, '../../../..');
const testKitConfig: KitConfigDeclaration = {
  schemaVersion: 1,
  defaultsLayer: 'default',
  writeLayer: 'global',
  layers: [
    { name: 'default', priority: 0, storage: null },
    { name: 'global', priority: 10, storage: { driver: 'sqlite', root: 'application-data', path: 'config.sqlite' } },
  ],
};

export const testKitFixture = createKitFixture({ config: testKitConfig });

export const testAssembly = createDefaultAssemblyConfig(projectRoot, {
  kitSources: [{ directory: testKitFixture.directory, source: 'builtin' }],
  defaultKit: testKitFixture.name,
});

afterAll(async () => {
  await testKitFixture.dispose();
});
