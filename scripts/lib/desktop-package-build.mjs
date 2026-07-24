import { spawn } from 'node:child_process';
import path from 'node:path';

export const DESKTOP_ELECTRON_VERSION = '31.7.7';
export const DESKTOP_ARCH = 'arm64';

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function createDesktopPackageSteps({
  cwd,
  mode,
  electronRebuildCli = path.join(cwd, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js'),
  electronBuilderCli = path.join(cwd, 'node_modules', 'electron-builder', 'cli.js'),
  nodeExecutable = process.execPath,
} = {}) {
  if (!path.isAbsolute(cwd)) throw new TypeError('cwd must be an absolute path');
  if (!['dir', 'dist'].includes(mode)) throw new TypeError('mode must be dir or dist');

  const builderArgs = [
    electronBuilderCli,
    '--config',
    'electron-builder.config.mjs',
    '--mac',
    '--arm64',
    ...(mode === 'dir' ? ['--dir'] : ['--publish', 'never']),
  ];

  return Object.freeze([
    Object.freeze({ name: 'prepare', command: npmCommand(), args: ['run', 'desktop:prepare'], cwd }),
    Object.freeze({
      name: 'electron-rebuild',
      command: nodeExecutable,
      args: [
        electronRebuildCli,
        '-f',
        '-w',
        'better-sqlite3',
        '--version',
        DESKTOP_ELECTRON_VERSION,
        '--arch',
        DESKTOP_ARCH,
      ],
      cwd,
    }),
    Object.freeze({ name: 'electron-builder', command: nodeExecutable, args: builderArgs, cwd }),
    Object.freeze({
      name: 'restore-node-addon',
      command: npmCommand(),
      args: ['rebuild', 'better-sqlite3'],
      cwd,
    }),
  ]);
}

export function runDesktopPackageCommand({ command, args, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

export async function runDesktopPackage({
  cwd,
  mode,
  run = runDesktopPackageCommand,
  ...options
} = {}) {
  const [prepare, rebuild, builder, restore] = createDesktopPackageSteps({ cwd, mode, ...options });
  let primaryFailure;

  try {
    await run(prepare);
    await run(rebuild);
    await run(builder);
  } catch (error) {
    primaryFailure = error;
  }

  let restoreFailure;
  try {
    await run(restore);
  } catch (error) {
    restoreFailure = error;
  }

  if (primaryFailure && restoreFailure) {
    throw new AggregateError(
      [primaryFailure, restoreFailure],
      'Desktop package failed and the Node native addon could not be restored',
    );
  }
  if (primaryFailure) throw primaryFailure;
  if (restoreFailure) throw restoreFailure;
}
