import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { extractFile, listPackage, statFile } from '@electron/asar';

export const DESKTOP_ELECTRON_VERSION = '43.2.0';
export const DESKTOP_ARCH = 'arm64';
const DESKTOP_KEYRING_PACKAGE = '@napi-rs/keyring';
const DESKTOP_KEYRING_NATIVE_PACKAGE = '@napi-rs/keyring-darwin-arm64';
const DESKTOP_KEYRING_NATIVE_FILE = 'node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node';
const DESKTOP_KEYRING_VERSION = '1.3.0';
const DESKTOP_KEYRING_WRAPPER_MANIFEST = 'node_modules/@napi-rs/keyring/package.json';
const DESKTOP_KEYRING_NATIVE_MANIFEST = 'node_modules/@napi-rs/keyring-darwin-arm64/package.json';
const DESKTOP_KEYRING_WRAPPER_MAIN = 'node_modules/@napi-rs/keyring/index.js';
const KEYRING_TEXT_ENTRY = /(?:\.(?:[cm]?js|json|ts|md|txt)|\/(?:license|readme))$/iu;
const CREDENTIAL_MODULE_ENTRY = /^(?:dist|packages\/server\/dist)\/(?:.*\/)?credentials(?:\/.*)?\.[cm]?js$/iu;
const KEYRING_MUSL_PROBE = /require\((['"])child_process\1\)\.execSync\((['"])ldd --version\2,\s*\{\s*encoding:\s*(['"])utf8\3\s*\}\)/gu;
const FORBIDDEN_CREDENTIAL_CONTENT = Object.freeze([
  Object.freeze({ label: 'child process module', pattern: /\b(?:node:)?child_process\b/u }),
  Object.freeze({
    label: 'process execution call',
    pattern: /(?<![\w$.])(?:exec|execFile|execSync|spawn|spawnSync)\s*\(/u,
  }),
  Object.freeze({ label: 'Linux secret-tool helper', pattern: /\bsecret-tool\b/iu }),
  Object.freeze({
    label: 'macOS security helper',
    pattern: /(?:\/usr\/bin\/security\b|\bsecurity\s+(?:add|find|delete)-generic-password\b)/iu,
  }),
  Object.freeze({ label: 'Windows cmdkey helper', pattern: /\bcmdkey(?:\.exe)?\b/iu }),
  Object.freeze({ label: 'basic text backend', pattern: /\bbasic[-_ ]?text\b/iu }),
  Object.freeze({ label: 'plaintext store', pattern: /\bplain(?:text)?[-_ ]?store\b/iu }),
  Object.freeze({
    label: 'fixed credential key',
    pattern: /\b(?:fixed|hardcoded)[-_ ]?(?:credential[-_ ]?)?key\b/iu,
  }),
]);

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

function readArchiveJson(archive, entry, label) {
  let value;
  try {
    value = JSON.parse(extractFile(archive, entry).toString('utf8'));
  } catch {
    throw new Error(`Packaged keyring verification failed: invalid ${label} manifest`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Packaged keyring verification failed: invalid ${label} manifest`);
  }
  return value;
}

function exactStringArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path.join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

function assertNoCredentialFallback(entry, content, { allowKeyringMuslProbe = false } = {}) {
  let inspectedContent = content;
  if (allowKeyringMuslProbe) {
    const probes = [...content.matchAll(KEYRING_MUSL_PROBE)];
    if (probes.length > 1) {
      throw new Error(
        `Packaged keyring verification failed: forbidden credential fallback content in ${entry} (repeated musl probe)`,
      );
    }
    inspectedContent = content.replace(KEYRING_MUSL_PROBE, '');
  }
  const forbidden = FORBIDDEN_CREDENTIAL_CONTENT.find(({ pattern }) => pattern.test(inspectedContent));
  if (forbidden) {
    throw new Error(
      `Packaged keyring verification failed: forbidden credential fallback content in ${entry} (${forbidden.label})`,
    );
  }
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
  assertNoCredentialFallback(frameworkEntry, frameworkBundle);

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
  const wrapperManifest = readArchiveJson(
    archive,
    DESKTOP_KEYRING_WRAPPER_MANIFEST,
    'wrapper',
  );
  if (
    wrapperManifest.name !== DESKTOP_KEYRING_PACKAGE
    || wrapperManifest.version !== DESKTOP_KEYRING_VERSION
    || wrapperManifest.main !== 'index.js'
    || !Array.isArray(wrapperManifest.files)
    || !wrapperManifest.files.includes(wrapperManifest.main)
    || !entries.includes(DESKTOP_KEYRING_WRAPPER_MAIN)
  ) {
    throw new Error('Packaged keyring verification failed: invalid wrapper manifest');
  }
  if (
    !wrapperManifest.optionalDependencies
    || typeof wrapperManifest.optionalDependencies !== 'object'
    || Array.isArray(wrapperManifest.optionalDependencies)
    || wrapperManifest.optionalDependencies[DESKTOP_KEYRING_NATIVE_PACKAGE] !== DESKTOP_KEYRING_VERSION
  ) {
    throw new Error('Packaged keyring verification failed: invalid wrapper native dependency');
  }
  const nativeManifest = readArchiveJson(
    archive,
    DESKTOP_KEYRING_NATIVE_MANIFEST,
    'native',
  );
  const nativeFilename = path.posix.basename(DESKTOP_KEYRING_NATIVE_FILE);
  if (
    nativeManifest.name !== DESKTOP_KEYRING_NATIVE_PACKAGE
    || nativeManifest.version !== DESKTOP_KEYRING_VERSION
    || nativeManifest.main !== nativeFilename
    || !exactStringArray(nativeManifest.files, [nativeFilename])
    || !exactStringArray(nativeManifest.os, ['darwin'])
    || !exactStringArray(nativeManifest.cpu, [DESKTOP_ARCH])
  ) {
    throw new Error('Packaged keyring verification failed: invalid native manifest');
  }
  if (entries.some((entry) => /shell[-_.]?helper|plain(?:text)?[-_.]?store|basic_text/iu.test(entry))) {
    throw new Error('Packaged keyring verification failed: forbidden credential helper artifact is present');
  }
  const credentialModuleEntries = entries.filter((entry) => CREDENTIAL_MODULE_ENTRY.test(entry));
  for (const entry of credentialModuleEntries) {
    assertNoCredentialFallback(entry, extractFile(archive, entry).toString('utf8'));
  }
  const keyringTextEntries = entries.filter((entry) => (
    /^node_modules\/@napi-rs\/keyring(?:-[^/]+)?\//u.test(entry)
    && KEYRING_TEXT_ENTRY.test(entry)
  ));
  for (const entry of keyringTextEntries) {
    assertNoCredentialFallback(entry, extractFile(archive, entry).toString('utf8'), {
      allowKeyringMuslProbe: entry === DESKTOP_KEYRING_WRAPPER_MAIN,
    });
  }
  const archiveNativeFiles = entries.filter((entry) => (
    /^node_modules\/@napi-rs\/keyring(?:-[^/]+)?\/.*\.node$/u.test(entry)
  )).sort();
  if (!exactStringArray(archiveNativeFiles, [DESKTOP_KEYRING_NATIVE_FILE])) {
    throw new Error('Packaged keyring verification failed: invalid archive native file closure');
  }
  if (statFile(archive, DESKTOP_KEYRING_NATIVE_FILE).unpacked !== true) {
    throw new Error('Packaged keyring verification failed: Darwin ARM64 native file is not unpacked');
  }
  const unpackedRoot = path.join(`${archive}.unpacked`, 'node_modules', '@napi-rs');
  await access(path.join(`${archive}.unpacked`, DESKTOP_KEYRING_NATIVE_FILE));
  const unpackedNativeFiles = (await listFiles(unpackedRoot))
    .filter((entry) => /^keyring(?:-[^/]+)?\/.*\.node$/u.test(entry))
    .map((entry) => path.posix.join('node_modules/@napi-rs', entry));
  if (!exactStringArray(unpackedNativeFiles, [DESKTOP_KEYRING_NATIVE_FILE])) {
    throw new Error('Packaged keyring verification failed: invalid unpacked native file closure');
  }

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
