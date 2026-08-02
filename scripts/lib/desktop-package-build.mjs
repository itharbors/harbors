import { spawn } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { extractFile, listPackage, statFile } from '@electron/asar';

export const DESKTOP_ELECTRON_VERSION = '43.2.0';
export const DESKTOP_ARCH = 'arm64';
const DESKTOP_KEYRING_PACKAGE = '@itharbors/native-credential-vault';
const DESKTOP_KEYRING_NATIVE_FILE = 'node_modules/@itharbors/native-credential-vault/build/Release/harbors_native_credential_vault.node';
const DESKTOP_KEYRING_VERSION = '0.0.1';
const DESKTOP_KEYRING_MANIFEST = 'node_modules/@itharbors/native-credential-vault/package.json';
const DESKTOP_KEYRING_MAIN = 'node_modules/@itharbors/native-credential-vault/index.cjs';
const DESKTOP_KEYRING_LOADER = 'node_modules/@itharbors/native-credential-vault/lib/loader.cjs';
const APP_OWNED_ENTRY = /^(?:dist|packages\/server\/dist)\//u;
const STRICT_CREDENTIAL_ENTRY = /^(?:dist\/(?:framework\.mjs|credentials(?:\/.*)?\.[cm]?js)|packages\/server\/dist\/credentials(?:\/.*)?\.[cm]?js)$/iu;
const SELECTED_KEYRING_ENTRY = /^node_modules\/@itharbors\/native-credential-vault\//u;
const CREDENTIAL_FALLBACK_MARKERS = Object.freeze([
  Object.freeze({ label: 'Linux secret-tool helper', pattern: /\bsecret-tool\b/iu }),
  Object.freeze({
    label: 'macOS security credential verb',
    pattern: /\b(?:add|find|delete)-generic-password\b/iu,
  }),
  Object.freeze({ label: 'Windows cmdkey helper', pattern: /\bcmdkey(?:\.exe)?\b/iu }),
  Object.freeze({ label: 'basic text backend', pattern: /\bbasic[-_ ]?text\b/iu }),
  Object.freeze({ label: 'plaintext store', pattern: /\bplain(?:text)?[-_ ]?store\b/iu }),
  Object.freeze({
    label: 'fixed credential key',
    pattern: /\b(?:fixed|hardcoded)[-_ ]?(?:credential[-_ ]?)?key\b/iu,
  }),
]);
const STRICT_PROCESS_MARKERS = Object.freeze([
  Object.freeze({ label: 'child process module', pattern: /\b(?:node:)?child_process\b/u }),
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

async function listUnpackedNativeFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (/\.node$/iu.test(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(
          `Packaged keyring verification failed: invalid unpacked native file closure; non-regular ${relative}`,
        );
      }
      files.push(relative);
    } else if (entry.isDirectory()) {
      files.push(...await listUnpackedNativeFiles(path.join(directory, entry.name), relative));
    }
  }
  return files.sort();
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function assertTrustedOutputRoot(directory) {
  // The packaging controller owns this resolved absolute appOutDir path. Its
  // terminal directory is the trust anchor and may not itself be a symlink.
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) {
    throw new Error(
      'Packaged keyring verification failed: desktop output directory must be an explicit absolute path',
    );
  }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      'Packaged keyring verification failed: desktop output directory is a symlink or not a directory',
    );
  }
  return realpath(directory);
}

async function assertTrustedChildDirectory({
  parent,
  parentReal,
  child,
  basename,
  label,
  outputReal,
  escapeLabel = 'trusted output directory',
}) {
  if (child !== path.join(parent, basename)) {
    throw new Error(
      `Packaged keyring verification failed: ${label} is not the expected direct child`,
    );
  }
  const metadata = await lstat(child);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      `Packaged keyring verification failed: ${label} is a symlink or escapes ${escapeLabel}`,
    );
  }
  const childReal = await realpath(child);
  if (childReal !== path.join(parentReal, basename) || !isWithin(outputReal, childReal)) {
    throw new Error(
      `Packaged keyring verification failed: ${label} is a symlink or escapes ${escapeLabel}`,
    );
  }
  return childReal;
}

async function assertTrustedChildFile({
  parent,
  parentReal,
  child,
  basename,
  label,
  outputReal,
}) {
  if (child !== path.join(parent, basename)) {
    throw new Error(
      `Packaged keyring verification failed: ${label} is not the expected direct child`,
    );
  }
  const metadata = await lstat(child);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Packaged keyring verification failed: ${label} is not regular`);
  }
  const childReal = await realpath(child);
  if (childReal !== path.join(parentReal, basename) || !isWithin(outputReal, childReal)) {
    throw new Error(`Packaged keyring verification failed: ${label} escapes trusted output directory`);
  }
  return childReal;
}

function readArchiveScanContent(archive, entry) {
  const metadata = statFile(archive, entry);
  if (!metadata || !Number.isInteger(metadata.size) || typeof metadata.link === 'string') return null;
  if (/\.node$/iu.test(entry)) return null;
  const content = extractFile(archive, entry);
  return content.toString('latin1');
}

function assertNoCredentialFallback(
  entry,
  content,
  { strictProcessSource = false } = {},
) {
  const markers = strictProcessSource
    ? [...CREDENTIAL_FALLBACK_MARKERS, ...STRICT_PROCESS_MARKERS]
    : CREDENTIAL_FALLBACK_MARKERS;
  const forbidden = markers.find(({ pattern }) => pattern.test(content));
  if (forbidden) {
    throw new Error(
      `Packaged keyring verification failed: forbidden credential fallback content in ${entry} (${forbidden.label})`,
    );
  }
}

export async function verifyPackagedKeyring({ outputDirectory, appPackage }) {
  const outputReal = await assertTrustedOutputRoot(outputDirectory);
  const appPackageReal = await assertTrustedChildDirectory({
    parent: outputDirectory,
    parentReal: outputReal,
    child: appPackage,
    basename: 'ITHARBORS.app',
    label: 'ITHARBORS.app',
    outputReal,
  });
  const contents = path.join(appPackage, 'Contents');
  const contentsReal = await assertTrustedChildDirectory({
    parent: appPackage,
    parentReal: appPackageReal,
    child: contents,
    basename: 'Contents',
    label: 'Contents',
    outputReal,
  });
  const resources = path.join(appPackage, 'Contents', 'Resources');
  const resourcesReal = await assertTrustedChildDirectory({
    parent: contents,
    parentReal: contentsReal,
    child: resources,
    basename: 'Resources',
    label: 'Resources',
    outputReal,
  });
  const archive = path.join(resources, 'app.asar');
  await assertTrustedChildFile({
    parent: resources,
    parentReal: resourcesReal,
    child: archive,
    basename: 'app.asar',
    label: 'app.asar',
    outputReal,
  });
  const unpackedArchiveRoot = path.join(resources, 'app.asar.unpacked');
  const unpackedArchiveRealRoot = await assertTrustedChildDirectory({
    parent: resources,
    parentReal: resourcesReal,
    child: unpackedArchiveRoot,
    basename: 'app.asar.unpacked',
    label: 'unpacked archive root',
    outputReal,
  });
  const unpackedNodeModules = path.join(unpackedArchiveRoot, 'node_modules');
  const unpackedNodeModulesReal = await assertTrustedChildDirectory({
    parent: unpackedArchiveRoot,
    parentReal: unpackedArchiveRealRoot,
    child: unpackedNodeModules,
    basename: 'node_modules',
    label: 'unpacked native parent',
    outputReal,
    escapeLabel: 'archive root',
  });
  const unpackedRoot = path.join(unpackedNodeModules, '@itharbors');
  const unpackedRealRoot = await assertTrustedChildDirectory({
    parent: unpackedNodeModules,
    parentReal: unpackedNodeModulesReal,
    child: unpackedRoot,
    basename: '@itharbors',
    label: 'unpacked native parent',
    outputReal,
    escapeLabel: 'archive root',
  });
  const unpackedNativePackage = path.join(unpackedRoot, 'native-credential-vault');
  const unpackedNativePackageReal = await assertTrustedChildDirectory({
    parent: unpackedRoot,
    parentReal: unpackedRealRoot,
    child: unpackedNativePackage,
    basename: 'native-credential-vault',
    label: 'unpacked native parent',
    outputReal,
    escapeLabel: 'archive root',
  });
  const unpackedBuild = path.join(unpackedNativePackage, 'build');
  const unpackedBuildReal = await assertTrustedChildDirectory({
    parent: unpackedNativePackage,
    parentReal: unpackedNativePackageReal,
    child: unpackedBuild,
    basename: 'build',
    label: 'unpacked native build directory',
    outputReal,
    escapeLabel: 'archive root',
  });
  const unpackedRelease = path.join(unpackedBuild, 'Release');
  const unpackedReleaseReal = await assertTrustedChildDirectory({
    parent: unpackedBuild,
    parentReal: unpackedBuildReal,
    child: unpackedRelease,
    basename: 'Release',
    label: 'unpacked native release directory',
    outputReal,
    escapeLabel: 'archive root',
  });
  const expectedNative = path.join(unpackedRelease, 'harbors_native_credential_vault.node');
  await assertTrustedChildFile({
    parent: unpackedRelease,
    parentReal: unpackedReleaseReal,
    child: expectedNative,
    basename: 'harbors_native_credential_vault.node',
    label: 'expected native file',
    outputReal,
  });
  const entries = listPackage(archive).map((entry) => entry.replace(/^\//u, ''));
  const frameworkEntry = 'dist/framework.mjs';
  if (!entries.includes(frameworkEntry)) {
    throw new Error('Packaged keyring verification failed: Framework bundle is missing');
  }
  const frameworkBundle = readArchiveScanContent(archive, frameworkEntry);
  if (frameworkBundle === null) {
    throw new Error('Packaged keyring verification failed: Framework bundle is not regular text');
  }
  if (!/import\(["']@itharbors\/native-credential-vault["']\)/u.test(frameworkBundle)) {
    throw new Error('Packaged keyring verification failed: external import is missing');
  }
  assertNoCredentialFallback(frameworkEntry, frameworkBundle, { strictProcessSource: true });

  const credentialPackages = [...new Set(entries.flatMap((entry) => {
    if (/^node_modules\/@itharbors\/native-credential-vault(?:\/|$)/u.test(entry)) {
      return [DESKTOP_KEYRING_PACKAGE];
    }
    const legacy = /^node_modules\/@napi-rs\/(keyring(?:-[^/]+)?)(?:\/|$)/u.exec(entry);
    return legacy ? [`@napi-rs/${legacy[1]}`] : [];
  }))].sort();
  if (!exactStringArray(credentialPackages, [DESKTOP_KEYRING_PACKAGE])) {
    throw new Error(
      `Packaged keyring verification failed: unexpected credential dependency closure ${credentialPackages.join(', ')}`,
    );
  }
  const wrapperManifest = readArchiveJson(
    archive,
    DESKTOP_KEYRING_MANIFEST,
    'wrapper',
  );
  const expectedFiles = [
    'index.cjs',
    'index.d.ts',
    'lib/loader.cjs',
    'build/Release/harbors_native_credential_vault.node',
  ];
  if (
    wrapperManifest.name !== DESKTOP_KEYRING_PACKAGE
    || wrapperManifest.version !== DESKTOP_KEYRING_VERSION
    || wrapperManifest.private !== true
    || wrapperManifest.type !== 'commonjs'
    || wrapperManifest.main !== 'index.cjs'
    || wrapperManifest.types !== 'index.d.ts'
    || !exactStringArray(wrapperManifest.files, expectedFiles)
    || !entries.includes(DESKTOP_KEYRING_MAIN)
    || !entries.includes(DESKTOP_KEYRING_LOADER)
  ) {
    throw new Error('Packaged keyring verification failed: invalid wrapper manifest');
  }
  if (entries.some((entry) => /shell[-_.]?helper|plain(?:text)?[-_.]?store|basic_text/iu.test(entry))) {
    throw new Error('Packaged keyring verification failed: forbidden credential helper artifact is present');
  }
  const appOwnedEntries = entries.filter((entry) => APP_OWNED_ENTRY.test(entry));
  for (const entry of appOwnedEntries) {
    const content = readArchiveScanContent(archive, entry);
    if (content === null) continue;
    assertNoCredentialFallback(entry, content, {
      strictProcessSource: STRICT_CREDENTIAL_ENTRY.test(entry),
    });
  }
  const selectedKeyringEntries = entries.filter((entry) => SELECTED_KEYRING_ENTRY.test(entry));
  for (const entry of selectedKeyringEntries) {
    const content = readArchiveScanContent(archive, entry);
    if (content === null) continue;
    assertNoCredentialFallback(entry, content, { strictProcessSource: true });
  }
  const expectedKeyringEntries = [
    'node_modules/@itharbors/native-credential-vault/build',
    'node_modules/@itharbors/native-credential-vault/build/Release',
    DESKTOP_KEYRING_NATIVE_FILE,
    DESKTOP_KEYRING_MAIN,
    'node_modules/@itharbors/native-credential-vault/lib',
    DESKTOP_KEYRING_LOADER,
    DESKTOP_KEYRING_MANIFEST,
  ].sort();
  const archiveNativeFiles = entries.filter((entry) => (
    /^node_modules\/@itharbors\/native-credential-vault\/.*\.node$/u.test(entry)
  )).sort();
  if (!exactStringArray(archiveNativeFiles, [DESKTOP_KEYRING_NATIVE_FILE])) {
    throw new Error('Packaged keyring verification failed: invalid archive native file closure');
  }
  if (statFile(archive, DESKTOP_KEYRING_NATIVE_FILE).unpacked !== true) {
    throw new Error('Packaged keyring verification failed: Darwin ARM64 native file is not unpacked');
  }
  const unpackedNativeFiles = (await listUnpackedNativeFiles(unpackedRoot))
    .filter((entry) => /^native-credential-vault\/.*\.node$/u.test(entry))
    .map((entry) => path.posix.join('node_modules/@itharbors', entry));
  if (!exactStringArray(unpackedNativeFiles, [DESKTOP_KEYRING_NATIVE_FILE])) {
    throw new Error('Packaged keyring verification failed: invalid unpacked native file closure');
  }
  const comparableKeyringEntries = selectedKeyringEntries
    .filter((entry) => entry !== 'node_modules/@itharbors/native-credential-vault')
    .sort();
  if (!exactStringArray(comparableKeyringEntries, expectedKeyringEntries)) {
    throw new Error(
      `Packaged keyring verification failed: invalid package file closure ${comparableKeyringEntries.join(', ')}`,
    );
  }

  return Object.freeze({
    external: DESKTOP_KEYRING_PACKAGE,
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
  const outputDirectory = path.resolve(cwd, 'dist', 'desktop-release', 'mac-arm64');
  const appPackage = path.join(outputDirectory, 'ITHARBORS.app');
  let primaryFailure;
  let packageEvidence;

  try {
    await run(prepare);
    await run(rebuild);
    await run(builder);
    packageEvidence = await verify({ outputDirectory, appPackage });
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
