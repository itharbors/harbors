import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));
const requireFromKit = createRequire(path.join(kitRoot, 'package.json'));

describe('TraceWeave Kit manifest', () => {
  it('resolves its private contracts package inside the TraceWeave Kit', () => {
    const pkg = readJson(path.join(kitRoot, 'package.json'));
    const contractsRoot = resolvePackageRoot('@itharbors/traceweave-contracts');
    const relativeOwner = path.relative(fs.realpathSync(kitRoot), contractsRoot);

    expect(relativeOwner).not.toBe('');
    expect(relativeOwner.startsWith(`..${path.sep}`)).toBe(false);
    expect(path.isAbsolute(relativeOwner)).toBe(false);
    expect(pkg.workspaces).toEqual(['packages/*', 'plugins/*']);
    expect(pkg.dependencies['@itharbors/traceweave-contracts']).toBe('file:packages/contracts');
    for (const pluginName of ['traceweave-core', 'traceweave-view']) {
      const plugin = readJson(path.join(kitRoot, 'plugins', pluginName, 'package.json'));
      expect(plugin.dependencies['@itharbors/traceweave-contracts']).toBe(
        'file:../../packages/contracts',
      );
    }
  });

  it('loads one full-workspace trace Panel backed by one Session plugin', () => {
    const pkg = readJson(path.join(kitRoot, 'package.json'));
    const manifest = readJson(path.join(kitRoot, 'kit.json'));
    const layout = readJson(path.join(kitRoot, 'layout.json'));
    const view = readJson(path.join(kitRoot, 'plugins/traceweave-view/package.json'));

    expect(pkg.name).toBe('@itharbors/kit-traceweave');
    expect(pkg['ce-editor'].kit.menuRoot).toEqual({ id: 'traceweave', label: 'TraceWeave' });
    expect(pkg['ce-editor'].kit.plugin).toEqual([
      '@itharbors/traceweave-core',
      '@itharbors/traceweave-view',
    ]);
    expect(layout.windows).toEqual([{
      id: 'traceweave-main',
      kind: 'main',
      type: 'panel-area',
      layout: {
        type: 'leaf',
        panel: '@itharbors/traceweave-view.trace',
        panelType: 'simple',
      },
    }]);
    expect(layout.activePanel).toBe('@itharbors/traceweave-view.trace');
    expect(manifest.permissions).toEqual(['filesystem']);
    expect(manifest.target).toEqual({ platform: 'any', arch: 'any' });
    expect(pkg.dependencies).toEqual({
      '@itharbors/traceweave-contracts': 'file:packages/contracts',
    });
    expect(pkg.devDependencies).toMatchObject({ react: '^19.2.8', 'react-dom': '^19.2.8' });
    expect(view.dependencies).toEqual({
      '@itharbors/traceweave-contracts': 'file:../../packages/contracts',
    });
    expect(view.devDependencies).toMatchObject({ react: '^19.2.8', 'react-dom': '^19.2.8' });
  });
});

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolvePackageRoot(packageName: string): string {
  const packageJson = requireFromKit.resolve.paths(packageName)
    ?.map((directory) => path.join(directory, packageName, 'package.json'))
    .find((candidate) => fs.existsSync(candidate));
  if (!packageJson) throw new Error(`Cannot resolve ${packageName} from ${kitRoot}`);
  return fs.realpathSync(path.dirname(packageJson));
}
