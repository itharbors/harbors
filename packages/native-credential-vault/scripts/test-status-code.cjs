'use strict';

const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin' || process.arch !== 'arm64') process.exit(0);

const temporary = mkdtempSync(path.join(os.tmpdir(), 'harbors-status-code-'));
try {
  const executable = path.join(temporary, 'status-code-test');
  for (const [command, args] of [
    ['c++', ['-std=c++20', '-framework', 'Security', 'tests/status-code.test.mm', '-o', executable]],
    [executable, []],
  ]) {
    const result = spawnSync(command, args, {
      cwd: path.resolve(__dirname, '..'),
      shell: false,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
