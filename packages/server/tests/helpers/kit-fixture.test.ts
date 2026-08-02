import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createKitFixture } from '../../src/framework/__tests__/kit-fixture';
import { testAssembly } from './assembly';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const productKitsRoot = fs.realpathSync(path.join(repositoryRoot, 'kits'));

describe('Framework-owned Kit fixtures', () => {
  it('dispose removes the fixture directory and is idempotent', async () => {
    const fixture = createKitFixture({ name: '@example/kit-disposable' });
    expect(fs.statSync(fixture.directory).isDirectory()).toBe(true);

    await fixture.dispose();
    await fixture.dispose();

    expect(fs.existsSync(fixture.directory)).toBe(false);
  });

  it('stay outside product Kits and contain every declared runtime artifact', () => {
    for (const source of testAssembly.kitSources) {
      const kitDirectory = fs.realpathSync(source.directory);
      const relative = path.relative(productKitsRoot, kitDirectory);
      expect(relative === '..' || relative.startsWith(`..${path.sep}`)).toBe(true);

      const kitPackage = JSON.parse(fs.readFileSync(path.join(kitDirectory, 'package.json'), 'utf8'));
      for (const pluginName of kitPackage['ce-editor'].kit.plugin ?? []) {
        const pluginDirectory = path.join(
          kitDirectory,
          'plugins',
          pluginName.replace(/^@[^/]+\//u, ''),
        );
        const pluginPackage = JSON.parse(fs.readFileSync(path.join(pluginDirectory, 'package.json'), 'utf8'));
        expect(fs.statSync(path.resolve(pluginDirectory, pluginPackage.main)).isFile()).toBe(true);
        for (const panel of Object.values(pluginPackage['ce-editor']?.contribute?.panel ?? {})) {
          expect(fs.statSync(path.resolve(pluginDirectory, (panel as { entry: string }).entry)).isFile()).toBe(true);
        }
      }
    }
  });
});
