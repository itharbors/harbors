import { spawn } from 'node:child_process';

const CLIENT_PREFIX = /^packages[/\\]client[/\\]/;

const passthroughArgs = process.argv
  .slice(2)
  .filter((arg) => arg !== '--passWithNoTests' && !arg.startsWith('--passWithNoTests='))
  .map((arg) => arg.replace(CLIENT_PREFIX, ''));

const vitest = process.platform === 'win32' ? 'vitest.cmd' : 'vitest';
const child = spawn(vitest, ['run', ...passthroughArgs, '--passWithNoTests=false'], {
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
