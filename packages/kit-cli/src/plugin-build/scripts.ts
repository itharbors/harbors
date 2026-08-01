import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import { buildSync } from 'esbuild';

import { ensureDir } from './fs.js';
import type { PluginProject } from './types.js';

const require = createRequire(import.meta.url);
const typescriptCli = require.resolve('typescript/bin/tsc');

function runTypeScript(rootDir: string, args: string[]): void {
  // The compiler is the package-owned TypeScript dependency. A caller cannot select
  // an executable or inject environment overrides through this API.
  execFileSync(process.execPath, [typescriptCli, ...args], { cwd: rootDir, stdio: 'inherit' });
}

function compileUnit({ rootDir, sourceDir, outDir, allowDom = false }: {
  rootDir: string;
  sourceDir: string;
  outDir: string;
  allowDom?: boolean;
}): string {
  const entryFile = path.join(sourceDir, 'index.ts');
  ensureDir(outDir);
  const jsOutFile = path.join(outDir, 'index.js');
  runTypeScript(rootDir, [
    entryFile,
    '--outDir', outDir,
    '--rootDir', sourceDir,
    '--module', 'nodenext',
    '--moduleResolution', 'nodenext',
    '--target', 'ES2022',
    '--esModuleInterop',
    '--skipLibCheck',
    '--strict', 'false',
    ...(allowDom ? ['--lib', 'ES2022,DOM'] : ['--types', 'node', '--lib', 'ES2022']),
  ]);
  return jsOutFile;
}

function typecheckPanel(rootDir: string, sourceDir: string): void {
  runTypeScript(rootDir, [
    path.join(sourceDir, 'index.ts'),
    '--noEmit',
    '--rootDir', sourceDir,
    '--module', 'nodenext',
    '--moduleResolution', 'nodenext',
    '--target', 'ES2022',
    '--esModuleInterop',
    '--skipLibCheck',
    '--strict', 'false',
    '--jsx', 'react-jsx',
    '--lib', 'ES2022,DOM',
  ]);
}

function bundlePanel(rootDir: string, sourceDir: string, outDir: string, outputFile?: string): string {
  ensureDir(outDir);
  const jsOutFile = outputFile ?? path.join(outDir, 'index.js');
  buildSync({
    absWorkingDir: rootDir,
    entryPoints: [path.join(sourceDir, 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    outfile: jsOutFile,
    logLevel: 'warning',
  });
  return jsOutFile;
}

export function compileMainScript(plugin: PluginProject): string | null {
  if (!plugin.main) return null;
  return compileUnit({
    rootDir: plugin.rootDir,
    sourceDir: plugin.main.sourceDir,
    outDir: plugin.main.distDir,
  });
}

export function compilePanelScripts(plugin: Pick<PluginProject, 'rootDir' | 'panels'>): string[] {
  const outputs: string[] = [];
  for (const panel of plugin.panels) {
    typecheckPanel(plugin.rootDir, panel.sourceDir);
    outputs.push(bundlePanel(plugin.rootDir, panel.sourceDir, panel.distDir, panel.jsOutputFile));
  }
  return outputs;
}
