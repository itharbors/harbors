import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));

describe('TraceWeave Kit manifest', () => {
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
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toMatchObject({ react: '^19.2.8', 'react-dom': '^19.2.8' });
    expect(view.dependencies).toEqual({ '@itharbors/traceweave-contracts': '0.0.1' });
    expect(view.devDependencies).toMatchObject({ react: '^19.2.8', 'react-dom': '^19.2.8' });
  });
});

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
