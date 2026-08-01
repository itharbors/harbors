import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { extractFile, listPackage, statFile } from '@electron/asar';

export const DESKTOP_ELECTRON_VERSION = '43.2.0';
export const DESKTOP_ARCH = 'arm64';
const DESKTOP_KEYRING_PACKAGE = '@napi-rs/keyring';
const DESKTOP_KEYRING_NATIVE_PACKAGE = '@napi-rs/keyring-darwin-arm64';
const DESKTOP_KEYRING_NATIVE_FILE = 'node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node';

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
  const modes = ['dir', 'dist', 'unsigned'];
  if (!modes.includes(mode)) throw new TypeError('mode must be dir, dist, or unsigned');

  const builderConfig = mode === 'unsigned'
    ? 'electron-builder.unsigned.config.mjs'
    : 'electron-builder.config.mjs';
  const builderArgs = [
    electronBuilderCli,
    '--config',
    builderConfig,
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

export async function verifyPackagedKeyring({ cwd }) {
  const resources = path.join(
    cwd,
    'dist',
    'desktop-release',
    'mac-arm64',
    'ITHARBORS.app',
    'Contents',
    'Resources',
  );
  const archive = path.join(resources, 'app.asar');
  const entries = listPackage(archive).map((entry) => entry.replace(/^\//u, ''));
  const frameworkEntry = 'dist/framework.mjs';
  if (!entries.includes(frameworkEntry)) {
    throw new Error('Packaged keyring verification failed: Framework bundle is missing');
  }
  const frameworkBundle = extractFile(archive, frameworkEntry).toString('utf8');
  if (!/import\(["']@napi-rs\/keyring["']\)/u.test(frameworkBundle)) {
    throw new Error('Packaged keyring verification failed: external import is missing');
  }
  if (/\/usr\/bin\/security|secret-tool|cmdkey|basic_text|plaintextStore/u.test(frameworkBundle)) {
    throw new Error('Packaged keyring verification failed: forbidden credential fallback is bundled');
  }

  const keyringPackages = [...new Set(entries.flatMap((entry) => {
    const match = /^node_modules\/@napi-rs\/(keyring(?:-[^/]+)?)(?:\/|$)/u.exec(entry);
    return match ? [`@napi-rs/${match[1]}`] : [];
  }))].sort();
  const expectedPackages = [DESKTOP_KEYRING_PACKAGE, DESKTOP_KEYRING_NATIVE_PACKAGE].sort();
  if (
    keyringPackages.length !== expectedPackages.length
    || keyringPackages.some((entry, index) => entry !== expectedPackages[index])
  ) {
    throw new Error(
      `Packaged keyring verification failed: unexpected platform dependency closure ${keyringPackages.join(', ')}`,
    );
  }
  if (entries.some((entry) => /shell[-_.]?helper|plain(?:text)?[-_.]?store|basic_text/iu.test(entry))) {
    throw new Error('Packaged keyring verification failed: forbidden credential helper artifact is present');
  }
  if (!entries.includes(DESKTOP_KEYRING_NATIVE_FILE)) {
    throw new Error('Packaged keyring verification failed: Darwin ARM64 native file is missing');
  }
  if (statFile(archive, DESKTOP_KEYRING_NATIVE_FILE).unpacked !== true) {
    throw new Error('Packaged keyring verification failed: Darwin ARM64 native file is not unpacked');
  }
  await access(path.join(`${archive}.unpacked`, DESKTOP_KEYRING_NATIVE_FILE));

  return Object.freeze({
    external: DESKTOP_KEYRING_PACKAGE,
    nativePackage: DESKTOP_KEYRING_NATIVE_PACKAGE,
    nativeFile: DESKTOP_KEYRING_NATIVE_FILE,
  });
}

export async function runDesktopPackage({
  cwd,
  mode,
  run = runDesktopPackageCommand,
  verify = verifyPackagedKeyring,
  ...options
} = {}) {
  const [prepare, rebuild, builder, restore] = createDesktopPackageSteps({ cwd, mode, ...options });
  let primaryFailure;
  let packageEvidence;

  try {
    await run(prepare);
    await run(rebuild);
    await run(builder);
    packageEvidence = await verify({ cwd });
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
  return packageEvidence;
}
