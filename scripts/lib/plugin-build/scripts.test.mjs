import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  copyPanelAssets,
  compilePanelScripts,
  discoverPlugin,
} from '@itharbors/kit-cli';

test('panel compilation bundles bare package imports for direct browser loading', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-panel-build-'));
  try {
    const sourceDir = path.join(rootDir, 'panel.demo/src');
    const distDir = path.join(rootDir, 'panel.demo/dist');
    const dependencyDir = path.join(rootDir, 'node_modules/@fixture/contracts');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(dependencyDir, { recursive: true });
    fs.writeFileSync(path.join(dependencyDir, 'package.json'), JSON.stringify({
      name: '@fixture/contracts',
      type: 'module',
      exports: { '.': { types: './index.d.ts', import: './index.js' } },
    }));
    fs.writeFileSync(path.join(dependencyDir, 'index.d.ts'), 'export declare const TOKEN: string;\n');
    fs.writeFileSync(path.join(dependencyDir, 'index.js'), 'export const TOKEN = "bundled-token";\n');
    fs.writeFileSync(path.join(sourceDir, 'index.ts'), [
      "import { TOKEN } from '@fixture/contracts';",
      'document.body.dataset.token = TOKEN;',
      '',
    ].join('\n'));

    compilePanelScripts({
      rootDir: process.cwd(),
      tsconfigPath: path.join(rootDir, 'tsconfig.json'),
      panels: [{ sourceDir, distDir }],
    });

    const output = fs.readFileSync(path.join(distDir, 'index.js'), 'utf8');
    assert.doesNotMatch(output, /(?:from\s+['"]@fixture\/contracts|require\(['"]@fixture\/contracts)/);
    assert.match(output, /bundled-token/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('panel compilation typechecks and bundles imported TSX modules', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-panel-tsx-build-'));
  try {
    const sourceDir = path.join(rootDir, 'panel.demo/src');
    const distDir = path.join(rootDir, 'panel.demo/dist');
    const reactDir = path.join(rootDir, 'node_modules/react');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(reactDir, { recursive: true });
    fs.writeFileSync(path.join(reactDir, 'package.json'), JSON.stringify({
      name: 'react',
      type: 'module',
      exports: { './jsx-runtime': './jsx-runtime.js' },
    }));
    fs.writeFileSync(path.join(reactDir, 'jsx-runtime.js'), [
      'export const Fragment = Symbol("fragment");',
      'export const jsx = (type, props) => ({ type, props });',
      'export const jsxs = jsx;',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(reactDir, 'jsx-runtime.d.ts'), [
      'export declare const Fragment: symbol;',
      'export declare function jsx(type: unknown, props: unknown): unknown;',
      'export declare const jsxs: typeof jsx;',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(sourceDir, 'component.tsx'), [
      'declare global { namespace JSX { interface IntrinsicElements { span: Record<string, unknown> } } }',
      'export const view = <span data-view="tsx">TraceWeave</span>;',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(sourceDir, 'index.ts'), [
      "import { view } from './component.js';",
      'document.body.dataset.view = String(view);',
      '',
    ].join('\n'));

    compilePanelScripts({
      rootDir: process.cwd(),
      tsconfigPath: path.join(rootDir, 'tsconfig.json'),
      panels: [{ sourceDir, distDir }],
    });

    const output = fs.readFileSync(path.join(distDir, 'index.js'), 'utf8');
    assert.match(output, /TraceWeave/);
    assert.doesNotMatch(output, /component\.js/);
    assert.doesNotMatch(output, /React\.createElement/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('panel asset copying excludes bundled TypeScript sources recursively', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-panel-assets-'));
  try {
    const sourceDir = path.join(rootDir, 'panel.demo/src');
    const distDir = path.join(rootDir, 'panel.demo/dist');
    fs.mkdirSync(path.join(sourceDir, 'components'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'index.html'), '<main></main>\n');
    fs.writeFileSync(path.join(sourceDir, 'index.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(sourceDir, 'app.tsx'), 'export const App = () => null;\n');
    fs.writeFileSync(path.join(sourceDir, 'components/helper.ts'), 'export const helper = true;\n');
    fs.writeFileSync(path.join(sourceDir, 'icon.svg'), '<svg></svg>\n');

    copyPanelAssets({ panels: [{ sourceDir, distDir }] });

    assert.equal(fs.existsSync(path.join(distDir, 'index.html')), true);
    assert.equal(fs.existsSync(path.join(distDir, 'icon.svg')), true);
    assert.equal(fs.existsSync(path.join(distDir, 'index.ts')), false);
    assert.equal(fs.existsSync(path.join(distDir, 'app.tsx')), false);
    assert.equal(fs.existsSync(path.join(distDir, 'components/helper.ts')), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('plugin discovery rejects a symlinked declared output path', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-plugin-symlink-'));
  try {
    const externalDir = path.join(rootDir, 'external');
    const pluginDir = path.join(rootDir, 'plugin');
    fs.mkdirSync(externalDir, { recursive: true });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.symlinkSync(externalDir, path.join(pluginDir, 'main'), 'dir');
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
      name: '@fixture/symlinked-plugin',
      main: './main/dist/index.js',
      'ce-editor': {},
    }));

    assert.throws(() => discoverPlugin(pluginDir), /symbolic links/i);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
