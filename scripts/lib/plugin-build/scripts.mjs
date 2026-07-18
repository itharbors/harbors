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
    outputs.push(compileUnit({
      rootDir: plugin.rootDir,
      sourceDir: panel.sourceDir,
      outDir: panel.distDir,
      tsconfigPath: plugin.tsconfigPath,
      allowDom: true,
    }));
  }
  return outputs;
}
