import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildPlugin, discoverPlugin } from '../src/index.js';

const require = createRequire(import.meta.url);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function createPlugin(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-cjs-plugin-'));
  temporaryDirectories.push(root);
  for (const [relativePath, fileContent] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, fileContent);
  }
  return root;
}

describe('compileMainScript with .cjs output', () => {
  it('bundles a .cjs main with relative helpers and keeps panels as ESM', async () => {
    const root = await createPlugin({
      'package.json': JSON.stringify({
        name: '@fixture/cjs-plugin',
        version: '1.0.0',
        type: 'module',
        main: './main/dist/index.cjs',
        'ce-editor': {
          contribute: {
            panel: {
              main: { entry: './panel.main/dist/index.html' },
            },
          },
        },
      }),
      'main/src/index.ts': `import { greet } from './helper.js';
export function run(): string {
  return greet();
}
export default run;
`,
      'main/src/helper.ts': `export function greet(): string {
  return "hello from helper";
}
`,
      'node_modules/@types/node/index.d.ts': 'export {};\n',
      'panel.main/src/index.ts': `export function render(): string {
  return "panel";
}
`,
      'panel.main/src/index.html': '<!doctype html><html><body></body></html>',
      'panel.main/src/index.css': 'body { margin: 0; }',
    });

    const plugin = discoverPlugin(root);
    buildPlugin(plugin);

    const cjsOutput = path.join(root, 'main', 'dist', 'index.cjs');
    const cjsSource = await readFile(cjsOutput, 'utf8');

    // The .cjs output must exist at the exact declared path.
    expect(cjsOutput).toBe(plugin.main?.outputFile);

    // The relative helper must be bundled into the single .cjs file.
    expect(cjsSource).toContain('hello from helper');
    expect(cjsSource).not.toMatch(/require\(['"]\.\/helper['"]\)/);

    // The .cjs module must be loadable with require() and export the run function.
    const loaded = require(cjsOutput);
    expect(typeof loaded.run).toBe('function');
    expect(loaded.run()).toBe('hello from helper');
    expect(loaded.default).toBe(loaded.run);

    // Panel script must remain ESM, not be converted to CommonJS.
    const panelJs = await readFile(path.join(root, 'panel.main', 'dist', 'index.js'), 'utf8');
    expect(panelJs).toMatch(/export\s/);
    expect(panelJs).not.toMatch(/module\.exports/);
  });

  it('fails before bundling when the main script has a type error', async () => {
    const root = await createPlugin({
      'package.json': JSON.stringify({
        name: '@fixture/cjs-plugin-type-error',
        version: '1.0.0',
        type: 'module',
        main: './main/dist/index.cjs',
      }),
      'main/src/index.ts': `export function run(): string {
  return 42;
}
`,
      'node_modules/@types/node/index.d.ts': 'export {};\n',
    });

    const plugin = discoverPlugin(root);
    expect(() => buildPlugin(plugin)).toThrow();
    await expect(readFile(path.join(root, 'main', 'dist', 'index.cjs'))).rejects.toThrow();
  });
});
