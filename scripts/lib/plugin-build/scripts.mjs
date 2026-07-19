import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureDir } from './fs.mjs';

function compileUnit({ rootDir, sourceDir, outDir, tsconfigPath, allowDom = false }) {
  const entryFile = path.join(sourceDir, 'index.ts');
  ensureDir(outDir);
  const jsOutFile = path.join(outDir, 'index.js');
  execFileSync(
    'npx',
    [
      'tsc',
      entryFile,
      '--outDir',
      outDir,
      '--rootDir',
      sourceDir,
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--target',
      'ES2022',
      '--esModuleInterop',
      '--skipLibCheck',
      '--strict',
      'false',
      '--types',
      allowDom ? '' : 'node',
      ...(allowDom ? ['--lib', 'ES2022,DOM'] : ['--lib', 'ES2022']),
    ].filter(Boolean),
    {
      cwd: rootDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(tsconfigPath ? { TS_NODE_PROJECT: tsconfigPath } : {}),
      },
    },
  );
  return jsOutFile;
}

function typecheckPanel({ rootDir, sourceDir, tsconfigPath }) {
  const entryFile = path.join(sourceDir, 'index.ts');
  execFileSync(
    'npx',
    [
      'tsc',
      entryFile,
      '--noEmit',
      '--rootDir',
      sourceDir,
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--target',
      'ES2022',
      '--esModuleInterop',
      '--skipLibCheck',
      '--strict',
      'false',
      '--lib',
      'ES2022,DOM',
    ],
    {
      cwd: rootDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(tsconfigPath ? { TS_NODE_PROJECT: tsconfigPath } : {}),
      },
    },
  );
}

function bundlePanel({ rootDir, sourceDir, outDir, outputFile }) {
  ensureDir(outDir);
  const entryFile = path.join(sourceDir, 'index.ts');
  const jsOutFile = outputFile ?? path.join(outDir, 'index.js');
  execFileSync(
    'npx',
    [
      'esbuild',
      entryFile,
      '--bundle',
      '--format=esm',
      '--platform=browser',
      '--target=es2022',
      `--outfile=${jsOutFile}`,
      '--log-level=warning',
    ],
    { cwd: rootDir, stdio: 'inherit' },
  );
  return jsOutFile;
}

export function compileMainScript(plugin) {
  if (!plugin.main) return null;
  return compileUnit({
    rootDir: plugin.rootDir,
    sourceDir: plugin.main.sourceDir,
    outDir: plugin.main.distDir,
    tsconfigPath: plugin.tsconfigPath,
  });
}

export function compilePanelScripts(plugin) {
  const outputs = [];
  for (const panel of plugin.panels) {
    typecheckPanel({
      rootDir: plugin.rootDir,
      sourceDir: panel.sourceDir,
      tsconfigPath: plugin.tsconfigPath,
    });
    outputs.push(bundlePanel({
      rootDir: plugin.rootDir,
      sourceDir: panel.sourceDir,
      outDir: panel.distDir,
      outputFile: panel.jsOutputFile,
    }));
  }
  return outputs;
}
