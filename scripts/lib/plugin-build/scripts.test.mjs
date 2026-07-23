import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compilePanelScripts } from './scripts.mjs';

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
