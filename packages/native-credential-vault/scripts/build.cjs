'use strict';

const { existsSync, mkdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
mkdirSync(path.join(packageRoot, 'build'), { recursive: true });

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  process.stdout.write('Native credential binding unsupported on this target; build skipped.\n');
  process.exit(0);
}

const result = spawnSync('node-gyp', ['rebuild'], {
  cwd: packageRoot,
  shell: false,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(path.join(packageRoot, 'build', 'Release', 'harbors_native_credential_vault.node'))) {
  throw new Error('Native credential binding build did not produce the expected artifact');
}
