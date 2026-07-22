import { spawn } from 'node:child_process';
import { createNpmSpawnSpec } from './lib/npm-spawn.mjs';

const npm = createNpmSpawnSpec([
  'exec',
  'electron',
  '--',
  'scripts/electron.mjs',
  ...process.argv.slice(2),
]);
const child = spawn(npm.command, npm.args, {
  ...npm.spawnOptions,
  env: { ...process.env, HARBORS_RUNTIME_PROFILE: 'development' },
  stdio: 'inherit',
});
child.on('error', (error) => {
  console.error('Failed to start Electron:', error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
