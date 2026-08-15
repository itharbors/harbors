import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export const KIT_INSTALL_RUNNER_VERSION = '1';
const COMPLETION_FILE = '.harbors-kit-install.json';
const LOCK_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const STRIPPED_DEPENDENCY_SELECTION_ENVIRONMENT = new Set([
  'NODE_ENV',
  'NPM_CONFIG_OMIT',
  'NPM_CONFIG_INCLUDE',
]);
const STRIPPED_LIFECYCLE_CREDENTIAL_ENVIRONMENT = new Set([
  'NODE_AUTH_TOKEN',
  'NPM_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
]);

function canonicalDirectory(value, context) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new TypeError(`${context} must be a canonical absolute path`);
  }
  return value;
}

async function readRegularFile(file, context) {
  let info;
  try {
    info = await lstat(file);
  } catch {
    throw new Error(`${context} does not exist: ${file}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${context} must be a regular file: ${file}`);
  }
  return readFile(file, 'utf8');
}

async function readOptionalRegularBytes(file, context) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${context} must be a regular file: ${file}`);
  }
  return readFile(file);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function sanitizedInstallEnvironment(command) {
  return Object.fromEntries(Object.entries(process.env).filter(
    ([key]) => {
      const normalized = key.toUpperCase();
      return !STRIPPED_DEPENDENCY_SELECTION_ENVIRONMENT.has(normalized)
        && (command !== 'rebuild' || !STRIPPED_LIFECYCLE_CREDENTIAL_ENVIRONMENT.has(normalized));
    },
  ));
}

function assertLockMatchesPackage(packageJson, lock) {
  const rootImporter = lock?.importers?.['.'];
  if (rootImporter === null || typeof rootImporter !== 'object' || Array.isArray(rootImporter)) {
    throw new Error('pnpm-lock.yaml is missing its root importer');
  }
  for (const field of LOCK_DEPENDENCY_FIELDS) {
    const packageDeps = packageJson[field] ?? {};
    const lockedDeps = rootImporter[field] ?? {};
    const packageNames = Object.keys(packageDeps).sort();
    const lockedNames = Object.keys(lockedDeps).sort();
    if (JSON.stringify(packageNames) !== JSON.stringify(lockedNames)) {
      throw new Error(`pnpm-lock.yaml and package.json drift at ${field}`);
    }
    for (const name of packageNames) {
      const locked = lockedDeps[name];
      if (locked === null || typeof locked !== 'object' || locked.specifier !== packageDeps[name]) {
        throw new Error(`pnpm-lock.yaml and package.json drift at ${field}.${name}`);
      }
    }
  }
}

async function assertLocalDependenciesStayInsideKit(packageJson, lock, kitDirectory, workspaceNames) {
  for (const [importerPath, importer] of Object.entries(lock.importers ?? {})) {
    const normalizedImporterPath = importerPath === '.'
      ? ''
      : assertPortablePath(importerPath, 'pnpm-lock importer', { allowParent: false });
    const importerDirectory = path.resolve(kitDirectory, ...normalizedImporterPath.split('/'));
    if (!isInside(importerDirectory, kitDirectory)) {
      throw new Error(`pnpm-lock importer must stay inside the Kit root: ${importerPath}`);
    }
    for (const field of LOCK_DEPENDENCY_FIELDS) {
      for (const [dependencyName, entry] of Object.entries(importer?.[field] ?? {})) {
        const version = entry?.version;
        if (typeof version !== 'string') continue;
        const match = /^(?:file|link):(.*)$/u.exec(version);
        if (match) {
          await assertContainedDependencyPath(
            match[1],
            importerDirectory,
            kitDirectory,
            `pnpm-lock ${field} link dependency`,
          );
        }
      }
    }
  }
  for (const [packageKey, entry] of Object.entries(lock.packages ?? {})) {
    const tarball = entry?.resolution?.tarball;
    if (typeof tarball === 'string' && /^(?:file|link):/u.test(tarball)) {
      await assertContainedDependencyPath(
        tarball.replace(/^(?:file|link):/u, ''),
        kitDirectory,
        kitDirectory,
        'pnpm-lock package resolution',
      );
    }
  }
}

function runPnpm(pnpmExecutable, args, installRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpmExecutable, ['--dir', installRoot, ...args], {
      cwd: installRoot,
      env: sanitizedInstallEnvironment(args[0]),
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`pnpm ${args[0]} terminated by signal ${signal}`));
      else if (code !== 0) reject(new Error(`pnpm ${args[0]} exited with code ${String(code)}`));
      else resolve();
    });
  });
}

function readCommandVersion(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], {
      env: sanitizedInstallEnvironment('--version'),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`pnpm --version terminated by signal ${signal}`));
      else if (code !== 0) reject(new Error(`pnpm --version exited with code ${String(code)}: ${stderr.trim()}`));
      else resolve(stdout.trim());
    });
  });
}

function pnpmInstallArguments() {
  return [
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
  ];
}

async function readCompletion(installRoot) {
  try {
    const completionFile = path.join(installRoot, COMPLETION_FILE);
    const info = await lstat(completionFile);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    return JSON.parse(await readFile(completionFile, 'utf8'));
  } catch {
    return undefined;
  }
}

async function canonicalizePotentialPath(candidate) {
  const suffix = [];
  let current = candidate;
  while (true) {
    try {
      return path.join(await realpath(current), ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`cannot resolve path identity: ${candidate}`);
    suffix.push(path.basename(current));
    current = parent;
  }
}

async function inspectSafeDirectory(directory, containmentRoot, context) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${context} must be a real directory, not a symbolic link or special file`);
  }
  const canonical = await realpath(directory);
  if (containmentRoot !== undefined && !isInside(canonical, containmentRoot)) {
    throw new Error(`${context} must remain contained in the cache root`);
  }
  return canonical;
}

async function ensureSafeDirectoryPath(directory, context) {
  const missing = [];
  let current = directory;
  let canonicalParent;
  while (true) {
    try {
      canonicalParent = await inspectSafeDirectory(current, undefined, context);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(path.basename(current));
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  while (missing.length > 0) {
    await inspectSafeDirectory(current, canonicalParent, context);
    current = path.join(current, missing.pop());
    try {
      await mkdir(current);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    canonicalParent = await inspectSafeDirectory(current, canonicalParent, context);
  }
  return canonicalParent;
}

async function assertDirectoryIdentity(directory, canonical, context) {
  const actual = await inspectSafeDirectory(directory, canonical, context);
  if (actual !== canonical) throw new Error(`${context} directory identity changed`);
}

async function ensureSafeCacheChild(parent, canonicalParent, name, context) {
  await assertDirectoryIdentity(parent, canonicalParent, context);
  const child = path.join(parent, name);
  try {
    await mkdir(child);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return inspectSafeDirectory(child, canonicalParent, context);
}

async function assertSafeDirectChild(target, parent, canonicalParent, context) {
  if (path.dirname(target) !== parent) throw new Error(`${context} must be a direct cache child`);
  await assertDirectoryIdentity(parent, canonicalParent, context);
}

function completionIdentity(completion) {
  if (completion === null || typeof completion !== 'object' || Array.isArray(completion)) return undefined;
  const { projectionHash, ...identity } = completion;
  return typeof projectionHash === 'string' ? { identity, projectionHash } : undefined;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireTemplateLock(
  lockRoot,
  dependencyRoot,
  cacheIdentity,
  templateSlugRoot,
  canonicalTemplateSlugRoot,
) {
  const deadline = Date.now() + 120_000;
  while (true) {
    await assertSafeDirectChild(
      lockRoot,
      templateSlugRoot,
      canonicalTemplateSlugRoot,
      'dependency template lock',
    );
    try {
      await mkdir(lockRoot);
      await inspectSafeDirectory(lockRoot, canonicalTemplateSlugRoot, 'dependency template lock');
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await inspectSafeDirectory(lockRoot, canonicalTemplateSlugRoot, 'dependency template lock');
    if (await isCompletedProjection(dependencyRoot, cacheIdentity)) {
      return false;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for dependency template lock: ${lockRoot}`);
    }
    await delay(50);
  }
}

function isKitSourceEntryIncluded(source) {
  const segments = source.split(path.sep);
  return !segments.some((segment) => [
    'node_modules',
    'dist',
    'coverage',
    '.vite',
    '.vitest',
    COMPLETION_FILE,
  ].includes(segment));
}

function isFrameworkSnapshotEntryIncluded(source) {
  const segments = source.split(path.sep);
  return !segments.some((segment) => [
    'node_modules',
    'coverage',
    '.vite',
    '.vitest',
    '.cache',
  ].includes(segment));
}

async function digestTree(root) {
  const hash = createHash('sha256');
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        hash.update('missing');
        return;
      }
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(root, entryPath);
      if (entry.isSymbolicLink()) throw new Error(`runner artifact must not contain symlinks: ${relative}`);
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}:${relative}\0`);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) hash.update(await readFile(entryPath));
      else throw new Error(`runner artifact contains unsupported entry: ${relative}`);
    }
  }
  await visit(root);
  return hash.digest('hex');
}

async function assertSafeCopyTree(root, context, filter) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (!filter(entryPath)) continue;
      const relative = path.relative(root, entryPath);
      if (entry.isSymbolicLink()) throw new Error(`${context} must not contain a symbolic link: ${relative}`);
      if (entry.isDirectory()) await visit(entryPath);
      else if (!entry.isFile()) throw new Error(`${context} must contain only regular files and directories: ${relative}`);
    }
  }
  await visit(root);
}

function assertPortablePath(value, context, { allowParent = true } = {}) {
  if (typeof value !== 'string' || value.length === 0
    || value.includes('\\') || value.includes('%') || value.includes('\0')
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
    || /^[A-Za-z]:/u.test(value) || value.startsWith('//')) {
    throw new Error(`${context} must be a portable relative path: ${String(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (!allowParent && (normalized === '..' || normalized.startsWith('../'))) {
    throw new Error(`${context} must stay inside the Kit root: ${value}`);
  }
  return normalized;
}

async function assertContainedDependencyPath(value, baseDirectory, kitDirectory, context) {
  const normalized = assertPortablePath(value, context);
  const candidate = path.resolve(baseDirectory, ...normalized.split('/'));
  if (!isInside(candidate, kitDirectory)) {
    throw new Error(`${context} must stay inside the Kit root: ${value}`);
  }
  let canonicalCandidate;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch {
    throw new Error(`${context} target does not exist inside the Kit root: ${value}`);
  }
  const canonicalKitDirectory = await realpath(kitDirectory);
  if (!isInside(canonicalCandidate, canonicalKitDirectory)) {
    throw new Error(`${context} must stay inside the Kit root: ${value}`);
  }
}

function isBareLocalPathSpecifier(specifier) {
  let candidate = specifier;
  for (let depth = 0; depth < 4; depth += 1) {
    if (candidate.includes('\\')
      || path.posix.isAbsolute(candidate)
      || path.win32.isAbsolute(candidate)
      || /^[A-Za-z]:/u.test(candidate)
      || /^(?:\.{1,2})(?:\/|$)/u.test(candidate)
      || candidate.startsWith('//')) return true;
    if (!/%[0-9A-Fa-f]{2}/u.test(candidate)) return false;
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) return false;
      candidate = decoded;
    } catch {
      return false;
    }
  }
  return false;
}

async function assertManifestDependencies(
  packageJson,
  ownerDirectory,
  kitDirectory,
  workspaceNames,
  lock,
) {
  const importerKey = ownerDirectory === kitDirectory
    ? '.'
    : path.relative(kitDirectory, ownerDirectory).split(path.sep).join('/');
  const importer = lock.importers?.[importerKey] ?? {};
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [dependencyName, specifier] of Object.entries(packageJson[field] ?? {})) {
      if (typeof specifier !== 'string') continue;
      const match = /^(file|link):(.*)$/u.exec(specifier);
      if (match) {
        await assertContainedDependencyPath(
          match[2],
          ownerDirectory,
          kitDirectory,
          `${match[1]} dependency`,
        );
      } else if (specifier.startsWith('workspace:')) {
        if (!workspaceNames.has(dependencyName)) {
          throw new Error(`workspace dependency must name a Kit-local workspace: ${dependencyName}`);
        }
        const locked = importer[field]?.[dependencyName];
        if (locked === null || typeof locked !== 'object' || typeof locked.version !== 'string' || !locked.version.startsWith('link:')) {
          throw new Error(`workspace dependency must have a contained pnpm-lock link: ${dependencyName}`);
        }
        await assertContainedDependencyPath(
          locked.version.slice('link:'.length),
          kitDirectory,
          kitDirectory,
          'workspace pnpm-lock link dependency',
        );
      } else if (isBareLocalPathSpecifier(specifier)) {
        throw new Error(`dependency specifier must not be a bare local path: ${specifier}`);
      }
    }
  }
}

async function validateProjectionSymlink(linkPath, root, requireTarget, allowAbsoluteInside = false) {
  const target = await readlink(linkPath);
  const absoluteTarget = path.isAbsolute(target) || path.win32.isAbsolute(target);
  if (absoluteTarget && !allowAbsoluteInside) {
    throw new Error('dependency projection symbolic link must be a portable relative path');
  }
  if (!absoluteTarget) assertPortablePath(target, 'dependency projection symbolic link');
  const resolved = absoluteTarget
    ? path.resolve(target)
    : path.resolve(path.dirname(linkPath), ...path.posix.normalize(target).split('/'));
  if (!isInside(resolved, root)) {
    throw new Error(`dependency projection symbolic link escapes its root: ${path.relative(root, linkPath)}`);
  }
  if (requireTarget) {
    const canonicalTarget = await realpath(resolved);
    const canonicalRoot = await realpath(root);
    if (!isInside(canonicalTarget, canonicalRoot)) {
      throw new Error(`dependency projection symbolic link escapes its root: ${path.relative(root, linkPath)}`);
    }
  } else {
    try {
      const canonicalTarget = await realpath(resolved);
      const canonicalRoot = await realpath(root);
      if (!isInside(canonicalTarget, canonicalRoot)) {
        throw new Error(`dependency projection symbolic link escapes its root: ${path.relative(root, linkPath)}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return target;
}

async function digestDependencyProjection(root) {
  const hash = createHash('sha256');
  hash.update('harbors-kit-dependency-tree\0v2\0');

  function lengthBuffer(length) {
    const result = Buffer.allocUnsafe(8);
    result.writeBigUInt64BE(BigInt(length));
    return result;
  }

  function updateEntry(type, relative, mode, payload) {
    const typeBytes = Buffer.from(type, 'utf8');
    const pathBytes = Buffer.from(relative, 'utf8');
    hash.update(lengthBuffer(typeBytes.byteLength));
    hash.update(typeBytes);
    hash.update(lengthBuffer(pathBytes.byteLength));
    hash.update(pathBytes);
    hash.update(lengthBuffer(mode));
    if (payload === undefined) {
      hash.update(lengthBuffer(0));
      return;
    }
    hash.update(lengthBuffer(payload.byteLength));
    hash.update(createHash('sha256').update(payload).digest());
  }

  async function visit(directory, insideNodeModules) {
    let containsProjection = false;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (directory === root && entry.name === COMPLETION_FILE) continue;
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(root, entryPath);
      const nowInside = insideNodeModules || entry.name === 'node_modules';
      if (!nowInside && !entry.isDirectory()) {
        throw new Error(`dependency template contains content outside node_modules: ${relative}`);
      }
      if (entry.isSymbolicLink()) {
        const target = await validateProjectionSymlink(entryPath, root, false);
        updateEntry('l', relative, 0, Buffer.from(target, 'utf8'));
        containsProjection = true;
      } else if (entry.isDirectory()) {
        updateEntry('d', relative, (await lstat(entryPath)).mode & 0o777);
        const childProjection = await visit(entryPath, nowInside);
        if (!nowInside && !childProjection) {
          throw new Error(`dependency template contains an empty path outside node_modules: ${relative}`);
        }
        containsProjection ||= nowInside || childProjection;
      } else if (entry.isFile() && nowInside) {
        updateEntry('f', relative, (await lstat(entryPath)).mode & 0o777, await readFile(entryPath));
        containsProjection = true;
      } else {
        throw new Error(`dependency template contains unsupported content: ${relative}`);
      }
    }
    return containsProjection;
  }
  await visit(root, false);
  return hash.digest('hex');
}

async function completedProjectionHash(dependencyRoot, cacheIdentity) {
  try {
    const completion = completionIdentity(await readCompletion(dependencyRoot));
    if (!completion
      || JSON.stringify(completion.identity) !== JSON.stringify(cacheIdentity)) return undefined;
    return await digestDependencyProjection(dependencyRoot) === completion.projectionHash
      ? completion.projectionHash
      : undefined;
  } catch {
    return undefined;
  }
}

async function isCompletedProjection(dependencyRoot, cacheIdentity) {
  return await completedProjectionHash(dependencyRoot, cacheIdentity) !== undefined;
}

async function validateInstalledProjection(root, runtimePlatform) {
  async function visit(directory, insideNodeModules) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const nowInside = insideNodeModules || entry.name === 'node_modules';
      if (entry.isSymbolicLink()) {
        if (!nowInside) throw new Error(`installed Kit source contains a symbolic link: ${path.relative(root, entryPath)}`);
        await validateProjectionSymlink(entryPath, root, true, runtimePlatform === 'win32');
      } else if (entry.isDirectory()) {
        await visit(entryPath, nowInside);
      } else if (!entry.isFile()) {
        throw new Error(`installed Kit contains unsupported content: ${path.relative(root, entryPath)}`);
      }
    }
  }
  await visit(root, false);
}

async function readWorkspaceManifests(kitDirectory) {
  const hash = createHash('sha256');
  const manifests = [];
  const names = new Set();
  const workspaceConfigPath = path.join(kitDirectory, 'pnpm-workspace.yaml');
  const workspaceConfigText = await readRegularFile(workspaceConfigPath, 'Kit pnpm-workspace.yaml');
  const workspaceConfig = parseYaml(workspaceConfigText);
  const patterns = Array.isArray(workspaceConfig?.packages) ? workspaceConfig.packages : [];
  hash.update(`pnpm-workspace.yaml\0${workspaceConfigText}\0`);
  for (const pattern of [...patterns].sort()) {
    if (typeof pattern !== 'string' || !pattern.endsWith('/*')) {
      throw new Error(`Kit workspace pattern must end with /*: ${String(pattern)}`);
    }
    const workspaceRoot = path.resolve(kitDirectory, pattern.slice(0, -2));
    if (!isInside(workspaceRoot, kitDirectory)) {
      throw new Error(`Kit workspace pattern must stay inside the Kit root: ${pattern}`);
    }
    let entries = [];
    try {
      entries = await readdir(workspaceRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error(`Kit workspace must not be a symbolic link: ${pattern}${entry.name}`);
      if (!entry.isDirectory()) continue;
      const manifest = path.join(workspaceRoot, entry.name, 'package.json');
      const manifestText = await readRegularFile(manifest, `Kit workspace ${pattern}${entry.name} package.json`);
      const manifestJson = JSON.parse(manifestText);
      if (typeof manifestJson.name !== 'string' || manifestJson.name.length === 0) {
        throw new Error(`Kit workspace must have a package name: ${pattern}${entry.name}`);
      }
      if (names.has(manifestJson.name)) {
        throw new Error(`Kit workspace package name must be unique: ${manifestJson.name}`);
      }
      names.add(manifestJson.name);
      manifests.push({ directory: path.dirname(manifest), packageJson: manifestJson });
      hash.update(`${path.relative(kitDirectory, manifest)}\0${manifestText}\0`);
    }
  }
  return { hash: hash.digest('hex'), manifests, names };
}

async function copyDependencyProjection(sourceRoot, projectionRoot) {
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const source = path.join(directory, entry.name);
      if (entry.name === 'node_modules') {
        const relative = path.relative(sourceRoot, source);
        await cp(source, path.join(projectionRoot, relative), {
          recursive: true,
          verbatimSymlinks: true,
        });
      } else {
        await visit(source);
      }
    }
  }
  await mkdir(projectionRoot, { recursive: true });
  await visit(sourceRoot);
}

async function restoreDependencyProjection(projectionRoot, installRoot) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === COMPLETION_FILE) continue;
      const source = path.join(directory, entry.name);
      const relative = path.relative(projectionRoot, source);
      const destination = path.join(installRoot, relative);
      if (entry.isDirectory() && entry.name === 'node_modules') {
        await cp(source, destination, { recursive: true, verbatimSymlinks: true });
      } else if (entry.isDirectory()) {
        await visit(source);
      }
    }
  }
  await visit(projectionRoot);
}

async function injectFrameworkSnapshot(repositoryRoot, workingRepositoryRoot, runtimePlatform) {
  for (const name of ['packages', 'plugins', 'scripts']) {
    const source = path.join(repositoryRoot, name);
    const canonicalSource = await realpath(source);
    if (!isInside(canonicalSource, repositoryRoot)) {
      throw new Error(`Framework injection path escapes the repository: ${name}`);
    }
    await cp(canonicalSource, path.join(workingRepositoryRoot, name), {
      recursive: true,
      filter: isFrameworkSnapshotEntryIncluded,
    });
    await assertSafeCopyTree(
      path.join(workingRepositoryRoot, name),
      'Framework snapshot',
      () => true,
    );
  }
  for (const name of ['package.json', 'tsconfig.json']) {
    const source = path.join(repositoryRoot, name);
    let sourceInfo;
    try {
      sourceInfo = await lstat(source);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw new Error(`Framework ${name} must be a regular file`);
    }
    await cp(source, path.join(workingRepositoryRoot, name));
    await readRegularFile(path.join(workingRepositoryRoot, name), `copied Framework ${name}`);
  }
  const rootNodeModules = path.join(repositoryRoot, 'node_modules');
  const canonicalNodeModules = await realpath(rootNodeModules);
  if (!isInside(canonicalNodeModules, repositoryRoot)) {
    throw new Error('Framework node_modules injection escapes the repository');
  }
  await symlink(
    canonicalNodeModules,
    path.join(workingRepositoryRoot, 'node_modules'),
    runtimePlatform === 'win32' ? 'junction' : 'dir',
  );
}

export async function ensureKitInstall({
  descriptor,
  cacheRoot,
  pnpmExecutable = 'pnpm',
  runtimePlatform = process.platform,
  testHooks = {},
}) {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new TypeError('descriptor must be a Kit descriptor');
  }
  const kitDirectory = canonicalDirectory(descriptor.directory, 'descriptor.directory');
  const normalizedCacheRoot = canonicalDirectory(cacheRoot, 'cacheRoot');
  if (typeof descriptor.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(descriptor.slug)) {
    throw new TypeError('descriptor.slug must be a canonical Kit slug');
  }
  if (typeof pnpmExecutable !== 'string' || pnpmExecutable.length === 0) {
    throw new TypeError('pnpmExecutable must be a non-empty string');
  }
  if (typeof runtimePlatform !== 'string' || runtimePlatform.length === 0) {
    throw new TypeError('runtimePlatform must be a non-empty string');
  }
  if (testHooks === null || typeof testHooks !== 'object' || Array.isArray(testHooks)) {
    throw new TypeError('testHooks must be an object');
  }
  for (const hook of Object.values(testHooks)) {
    if (typeof hook !== 'function') throw new TypeError('testHooks values must be functions');
  }

  const packageText = await readRegularFile(path.join(kitDirectory, 'package.json'), 'Kit package.json');
  const lockText = await readRegularFile(path.join(kitDirectory, 'pnpm-lock.yaml'), 'Kit pnpm-lock.yaml');
  const packageJson = JSON.parse(packageText);
  const lock = parseYaml(lockText);
  assertLockMatchesPackage(packageJson, lock);

  const repositoryRoot = await realpath(path.dirname(path.dirname(kitDirectory)));
  const canonicalKitDirectory = await realpath(kitDirectory);
  const canonicalKitsRoot = await realpath(path.join(repositoryRoot, 'kits'));
  const kitDirectoryInfo = await lstat(kitDirectory);
  if (kitDirectoryInfo.isSymbolicLink()
    || !isInside(canonicalKitDirectory, canonicalKitsRoot)
    || path.basename(canonicalKitDirectory) !== descriptor.slug) {
    throw new Error('descriptor.directory must be the real canonical Kit root for descriptor.slug');
  }
  if (descriptor.id !== packageJson.name) {
    throw new Error('descriptor.id must match the Kit package name');
  }
  if (descriptor.version !== packageJson.version) {
    throw new Error('descriptor.version must match the Kit package version');
  }
  const canonicalCacheRoot = await canonicalizePotentialPath(normalizedCacheRoot);
  if (isInside(canonicalCacheRoot, canonicalKitDirectory)
    || isInside(canonicalKitDirectory, canonicalCacheRoot)) {
    throw new Error('cacheRoot must not overlap the Kit root');
  }
  for (const frameworkRoot of [
    path.join(repositoryRoot, 'packages'),
    path.join(repositoryRoot, 'plugins'),
    path.join(repositoryRoot, 'scripts'),
    path.join(repositoryRoot, 'node_modules'),
  ]) {
    const canonicalFrameworkRoot = await realpath(frameworkRoot);
    if (isInside(canonicalCacheRoot, canonicalFrameworkRoot)
      || isInside(canonicalFrameworkRoot, canonicalCacheRoot)) {
      throw new Error('cacheRoot must not overlap Framework snapshot inputs');
    }
  }
  await assertSafeCopyTree(kitDirectory, 'Kit source', isKitSourceEntryIncluded);
  for (const name of ['packages', 'plugins', 'scripts']) {
    await assertSafeCopyTree(
      path.join(repositoryRoot, name),
      'Framework snapshot',
      isFrameworkSnapshotEntryIncluded,
    );
  }
  const workspaceState = await readWorkspaceManifests(kitDirectory);
  await assertManifestDependencies(packageJson, kitDirectory, kitDirectory, workspaceState.names, lock);
  for (const workspace of workspaceState.manifests) {
    await assertManifestDependencies(
      workspace.packageJson,
      workspace.directory,
      kitDirectory,
      workspaceState.names,
      lock,
    );
  }
  await assertLocalDependenciesStayInsideKit(packageJson, lock, kitDirectory, workspaceState.names);

  const lockHash = createHash('sha256').update(lockText).digest('hex');
  const pnpmConfig = await readOptionalRegularBytes(path.join(kitDirectory, '.npmrc'), 'Kit .npmrc');
  const runnerPackage = JSON.parse(await readRegularFile(
    path.join(repositoryRoot, 'packages', 'kit-cli', 'package.json'),
    'Kit runner package.json',
  ).catch((error) => {
    if (error.message.includes('does not exist')) return '{"version":"fixture"}';
    throw error;
  }));
  const cacheIdentity = Object.freeze({
    installerSchema: KIT_INSTALL_RUNNER_VERSION,
    slug: descriptor.slug,
    id: packageJson.name,
    lockHash,
    pnpmConfigHash: pnpmConfig === undefined
      ? 'missing'
      : `sha256:${createHash('sha256').update(pnpmConfig).digest('hex')}`,
    workspaceManifestHash: workspaceState.hash,
    runnerVersion: runnerPackage.version,
    runnerArtifactHash: await digestTree(path.join(repositoryRoot, 'packages', 'kit-cli', 'dist')),
    platform: runtimePlatform,
    arch: process.arch,
    nodeVersion: process.version,
    nodeAbi: process.versions.modules,
    pnpmVersion: await readCommandVersion(pnpmExecutable),
  });
  const cacheKey = createHash('sha256')
    .update(JSON.stringify(cacheIdentity))
    .digest('hex');
  const createdCanonicalCacheRoot = await ensureSafeDirectoryPath(normalizedCacheRoot, 'cacheRoot');
  if (createdCanonicalCacheRoot !== canonicalCacheRoot) {
    throw new Error('cacheRoot directory identity changed');
  }
  const templatesRoot = path.join(normalizedCacheRoot, 'templates');
  let canonicalTemplatesRoot;
  let canonicalTemplateSlugRoot;
  const templateSlugRoot = path.join(templatesRoot, descriptor.slug);
  const dependencyRoot = path.join(templateSlugRoot, cacheKey);
  const templateLockRoot = path.join(templateSlugRoot, `.${cacheKey}.lock`);
  const usesProjectionCache = runtimePlatform !== 'win32';
  if (usesProjectionCache) {
    canonicalTemplatesRoot = await ensureSafeCacheChild(
      normalizedCacheRoot,
      canonicalCacheRoot,
      'templates',
      'cache templates',
    );
    await testHooks.beforeTemplateDirectoryUse?.();
    await assertDirectoryIdentity(templatesRoot, canonicalTemplatesRoot, 'cache templates');
    canonicalTemplateSlugRoot = await ensureSafeCacheChild(
      templatesRoot,
      canonicalTemplatesRoot,
      descriptor.slug,
      'Kit dependency templates',
    );
  }
  let reused = usesProjectionCache && await isCompletedProjection(dependencyRoot, cacheIdentity);
  if (usesProjectionCache && !reused) {
    const ownsTemplateLock = await acquireTemplateLock(
      templateLockRoot,
      dependencyRoot,
      cacheIdentity,
      templateSlugRoot,
      canonicalTemplateSlugRoot,
    );
    if (!ownsTemplateLock) {
      reused = true;
    } else {
      try {
        reused = await isCompletedProjection(dependencyRoot, cacheIdentity);
        if (!reused) {
          await assertDirectoryIdentity(
            templateSlugRoot,
            canonicalTemplateSlugRoot,
            'Kit dependency templates',
          );
          const temporaryParent = await mkdtemp(path.join(templateSlugRoot, `.${cacheKey}-`));
          const canonicalTemporaryParent = await inspectSafeDirectory(
            temporaryParent,
            canonicalTemplateSlugRoot,
            'temporary dependency template',
          );
          const temporaryInstallRoot = path.join(temporaryParent, 'install');
          const temporaryDependencyRoot = path.join(temporaryParent, 'projection');
          try {
            await cp(kitDirectory, temporaryInstallRoot, {
              recursive: true,
              filter: isKitSourceEntryIncluded,
            });
            await runPnpm(pnpmExecutable, pnpmInstallArguments(), temporaryInstallRoot);
            await mkdir(path.join(temporaryInstallRoot, 'node_modules'), { recursive: true });
            await copyDependencyProjection(temporaryInstallRoot, temporaryDependencyRoot);
            const projectionHash = await digestDependencyProjection(temporaryDependencyRoot);
            await writeFile(
              path.join(temporaryDependencyRoot, COMPLETION_FILE),
              `${JSON.stringify({ ...cacheIdentity, projectionHash }, null, 2)}\n`,
              { flag: 'wx' },
            );
            await assertSafeDirectChild(
              dependencyRoot,
              templateSlugRoot,
              canonicalTemplateSlugRoot,
              'dependency template replacement',
            );
            await rm(dependencyRoot, { recursive: true, force: true });
            await assertSafeDirectChild(
              temporaryDependencyRoot,
              temporaryParent,
              canonicalTemporaryParent,
              'temporary dependency projection',
            );
            await assertSafeDirectChild(
              dependencyRoot,
              templateSlugRoot,
              canonicalTemplateSlugRoot,
              'dependency template replacement',
            );
            await rename(temporaryDependencyRoot, dependencyRoot);
            await inspectSafeDirectory(
              dependencyRoot,
              canonicalTemplateSlugRoot,
              'dependency template',
            );
          } finally {
            await assertSafeDirectChild(
              temporaryParent,
              templateSlugRoot,
              canonicalTemplateSlugRoot,
              'temporary dependency template cleanup',
            );
            await rm(temporaryParent, { recursive: true, force: true });
          }
        }
      } finally {
        await assertSafeDirectChild(
          templateLockRoot,
          templateSlugRoot,
          canonicalTemplateSlugRoot,
          'dependency template lock cleanup',
        );
        await rm(templateLockRoot, { recursive: true, force: true });
      }
    }
  }
  const expectedProjectionHash = usesProjectionCache
    ? await completedProjectionHash(dependencyRoot, cacheIdentity)
    : undefined;
  if (usesProjectionCache && expectedProjectionHash === undefined) {
    throw new Error('dependency template changed after installation');
  }

  const runsRoot = path.join(normalizedCacheRoot, 'runs');
  const canonicalRunsRoot = await ensureSafeCacheChild(
    normalizedCacheRoot,
    canonicalCacheRoot,
    'runs',
    'cache runs',
  );
  await testHooks.beforeRunsDirectoryUse?.();
  await assertDirectoryIdentity(runsRoot, canonicalRunsRoot, 'cache runs');
  const runRoot = await mkdtemp(path.join(runsRoot, `${descriptor.slug}-`));
  const canonicalRunRoot = await inspectSafeDirectory(runRoot, canonicalRunsRoot, 'private Kit run');
  const workingRepositoryRoot = path.join(runRoot, 'repository');
  const installRoot = path.join(workingRepositoryRoot, 'kits', descriptor.slug);
  try {
    await mkdir(path.dirname(installRoot), { recursive: true });
    await cp(kitDirectory, installRoot, {
      recursive: true,
      filter: isKitSourceEntryIncluded,
    });
    if (usesProjectionCache) {
      await testHooks.afterProjectionValidation?.();
      await restoreDependencyProjection(dependencyRoot, installRoot);
      const verificationRoot = path.join(runRoot, 'restored-projection');
      try {
        await copyDependencyProjection(installRoot, verificationRoot);
        if (await digestDependencyProjection(verificationRoot) !== expectedProjectionHash) {
          throw new Error('dependency template changed while restoring');
        }
      } finally {
        await assertSafeDirectChild(
          verificationRoot,
          runRoot,
          canonicalRunRoot,
          'restored projection verification cleanup',
        );
        await rm(verificationRoot, { recursive: true, force: true });
      }
    } else {
      await runPnpm(pnpmExecutable, pnpmInstallArguments(), installRoot);
    }
    await validateInstalledProjection(installRoot, runtimePlatform);
    await testHooks.beforeFrameworkSnapshotInjection?.();
    await injectFrameworkSnapshot(repositoryRoot, workingRepositoryRoot, runtimePlatform);
    await runPnpm(pnpmExecutable, ['rebuild'], installRoot);
    await validateInstalledProjection(installRoot, runtimePlatform);
  } catch (error) {
    await assertSafeDirectChild(runRoot, runsRoot, canonicalRunsRoot, 'private Kit run cleanup');
    await rm(runRoot, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({ cacheKey, dependencyRoot, installRoot, reused, runRoot });
}
