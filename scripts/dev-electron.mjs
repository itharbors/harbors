import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npmCommand, ['exec', 'electron', '--', 'scripts/electron.mjs', ...process.argv.slice(2)], {
  env: { ...process.env, HARBORS_RUNTIME_PROFILE: 'development' },
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
