import { createHash, randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const SKILL_NAME = 'notify-user';
const MARKER_FILE = '.harbors-skill.json';
const MARKER_VERSION = 1;

export type CodexSkillInstallStatus = 'installed' | 'updated' | 'current';

export type CodexSkillInstallResult = {
  status: CodexSkillInstallStatus;
  destination: string;
  digest: string;
};

export type CodexSkillInstallErrorCode =
  | 'SKILL_SOURCE_INVALID'
  | 'SKILL_CONFLICT'
  | 'SKILL_UNSAFE_PATH';

export class CodexSkillInstallError extends Error {
  constructor(
    public readonly code: CodexSkillInstallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CodexSkillInstallError';
  }
}

export function createCodexSkillInstaller({
  sourceDir,
  codexHome,
}: {
  sourceDir: string;
  codexHome: string;
}, operations: {
  cp?: typeof cp;
  rename?: typeof rename;
  rm?: typeof rm;
} = {}): { install(): Promise<CodexSkillInstallResult> } {
  if (!path.isAbsolute(sourceDir) || !path.isAbsolute(codexHome)) {
    throw new TypeError('Skill source and Codex home must be absolute paths');
  }

  let inFlight: Promise<CodexSkillInstallResult> | null = null;
  const installer = {
    install() {
      if (inFlight) return inFlight;
      inFlight = installCodexSkill({
        sourceDir,
        codexHome,
        copyEntry: operations.cp ?? cp,
        renameEntry: operations.rename ?? rename,
        removeEntry: operations.rm ?? rm,
      })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
  return installer;
}

async function installCodexSkill({
  sourceDir,
  codexHome,
  copyEntry,
  renameEntry,
  removeEntry,
}: {
  sourceDir: string;
  codexHome: string;
  copyEntry: typeof cp;
  renameEntry: typeof rename;
  removeEntry: typeof rm;
}): Promise<CodexSkillInstallResult> {
  await validateSkillSource(sourceDir);
  const digest = await digestDirectory(sourceDir);
  const parentDir = path.join(codexHome, 'skills');
  const destination = path.join(parentDir, SKILL_NAME);
  await ensureSafeDirectory(codexHome, 'CODEX_HOME');
  await ensureSafeDirectory(parentDir, 'Codex skills directory');

  const destinationStat = await optionalLstat(destination);
  if (destinationStat?.isSymbolicLink()) {
    throw new CodexSkillInstallError(
      'SKILL_UNSAFE_PATH',
      `Refusing to replace symbolic link at ${destination}`,
    );
  }
  if (destinationStat) {
    if (!destinationStat.isDirectory()) {
      throw new CodexSkillInstallError(
        'SKILL_CONFLICT',
        `A non-directory entry already exists at ${destination}`,
      );
    }
    await assertNoSymlinks(destination, destination, 'SKILL_UNSAFE_PATH');
    const marker = await readManagedMarker(destination);
    if (!marker) {
      throw new CodexSkillInstallError(
        'SKILL_CONFLICT',
        `A Skill not managed by Harbors already exists at ${destination}`,
      );
    }
    const installedDigest = await digestDirectory(destination);
    if (installedDigest !== marker.digest) {
      throw new CodexSkillInstallError(
        'SKILL_CONFLICT',
        `The Harbors-managed Skill at ${destination} contains local modifications`,
      );
    }
    if (marker.digest === digest) {
      return { status: 'current', destination, digest };
    }
    await updateManagedSkill({
      sourceDir,
      parentDir,
      destination,
      digest,
      installedDigest,
      copyEntry,
      renameEntry,
      removeEntry,
    });
    return { status: 'updated', destination, digest };
  }

  const { tempRoot, stagingDir } = await stageSkill({
    sourceDir,
    parentDir,
    digest,
    copyEntry,
    removeEntry,
  });
  try {
    if (await optionalLstat(destination)) {
      throw new CodexSkillInstallError(
        'SKILL_CONFLICT',
        `A Skill appeared at ${destination} while installation was in progress`,
      );
    }
    await renameEntry(stagingDir, destination);
  } finally {
    await removeEntry(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  return { status: 'installed', destination, digest };
}

async function validateSkillSource(sourceDir: string) {
  const sourceStat = await optionalLstat(sourceDir);
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new CodexSkillInstallError(
      'SKILL_SOURCE_INVALID',
      'The bundled notify-user Skill directory is unavailable',
    );
  }

  const skillFile = path.join(sourceDir, 'SKILL.md');
  const skillStat = await optionalLstat(skillFile);
  if (!skillStat?.isFile() || skillStat.isSymbolicLink()) {
    throw new CodexSkillInstallError(
      'SKILL_SOURCE_INVALID',
      'The bundled notify-user Skill does not contain a regular SKILL.md',
    );
  }

  await assertNoSymlinks(sourceDir, sourceDir, 'SKILL_SOURCE_INVALID');
}

async function ensureSafeDirectory(directory: string, label: string) {
  const before = await optionalLstat(directory);
  if (before?.isSymbolicLink()) {
    throw new CodexSkillInstallError(
      'SKILL_UNSAFE_PATH',
      `${label} must not be a symbolic link: ${directory}`,
    );
  }
  if (before && !before.isDirectory()) {
    throw new CodexSkillInstallError(
      'SKILL_UNSAFE_PATH',
      `${label} must be a directory: ${directory}`,
    );
  }
  await mkdir(directory, { recursive: true });
  const after = await lstat(directory);
  if (after.isSymbolicLink() || !after.isDirectory()) {
    throw new CodexSkillInstallError(
      'SKILL_UNSAFE_PATH',
      `${label} changed while installation was in progress: ${directory}`,
    );
  }
}

async function assertNoSymlinks(
  rootDir: string,
  currentDir: string,
  errorCode: 'SKILL_SOURCE_INVALID' | 'SKILL_UNSAFE_PATH',
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new CodexSkillInstallError(
        errorCode,
        `Skill contains a symbolic link: ${path.relative(rootDir, entryPath)}`,
      );
    }
    if (entry.isDirectory()) await assertNoSymlinks(rootDir, entryPath, errorCode);
  }
}

async function stageSkill({
  sourceDir,
  parentDir,
  digest,
  copyEntry,
  removeEntry,
}: {
  sourceDir: string;
  parentDir: string;
  digest: string;
  copyEntry: typeof cp;
  removeEntry: typeof rm;
}) {
  const tempRoot = await mkdtemp(path.join(parentDir, '.notify-user-install-'));
  const stagingDir = path.join(tempRoot, SKILL_NAME);
  try {
    await copyEntry(sourceDir, stagingDir, { recursive: true, dereference: false });
    await assertNoSymlinks(stagingDir, stagingDir, 'SKILL_SOURCE_INVALID');
    if (await digestDirectory(stagingDir) !== digest) {
      throw new CodexSkillInstallError(
        'SKILL_SOURCE_INVALID',
        'Bundled Skill changed while it was being staged',
      );
    }
    await writeFile(
      path.join(stagingDir, MARKER_FILE),
      `${JSON.stringify(createMarker(digest), null, 2)}\n`,
      'utf8',
    );
    return { tempRoot, stagingDir };
  } catch (error) {
    await removeEntry(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function updateManagedSkill({
  sourceDir,
  parentDir,
  destination,
  digest,
  installedDigest,
  copyEntry,
  renameEntry,
  removeEntry,
}: {
  sourceDir: string;
  parentDir: string;
  destination: string;
  digest: string;
  installedDigest: string;
  copyEntry: typeof cp;
  renameEntry: typeof rename;
  removeEntry: typeof rm;
}) {
  const { tempRoot, stagingDir } = await stageSkill({
    sourceDir,
    parentDir,
    digest,
    copyEntry,
    removeEntry,
  });
  const backupDir = path.join(parentDir, `.notify-user-backup-${randomUUID()}`);
  try {
    await renameEntry(destination, backupDir);
    const backupDigest = await digestDirectory(backupDir);
    if (backupDigest !== installedDigest) {
      const conflict = new CodexSkillInstallError(
        'SKILL_CONFLICT',
        `The Harbors-managed Skill at ${destination} changed during installation`,
      );
      await restoreBackup({ backupDir, destination, renameEntry, originalError: conflict });
      throw conflict;
    }
    try {
      await renameEntry(stagingDir, destination);
    } catch (error) {
      await restoreBackup({ backupDir, destination, renameEntry, originalError: error });
      throw error;
    }
    try {
      await removeEntry(backupDir, { recursive: true, force: true });
    } catch (cleanupError) {
      await rollbackCommittedUpdate({
        backupDir,
        destination,
        parentDir,
        renameEntry,
        removeEntry,
        cleanupError,
      });
      throw cleanupError;
    }
  } finally {
    await removeEntry(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function restoreBackup({
  backupDir,
  destination,
  renameEntry,
  originalError,
}: {
  backupDir: string;
  destination: string;
  renameEntry: typeof rename;
  originalError: unknown;
}) {
  try {
    await renameEntry(backupDir, destination);
  } catch (restoreError) {
    throw new AggregateError(
      [originalError, restoreError],
      `Skill update failed and the previous version remains at ${backupDir}`,
    );
  }
}

async function rollbackCommittedUpdate({
  backupDir,
  destination,
  parentDir,
  renameEntry,
  removeEntry,
  cleanupError,
}: {
  backupDir: string;
  destination: string;
  parentDir: string;
  renameEntry: typeof rename;
  removeEntry: typeof rm;
  cleanupError: unknown;
}) {
  const failedNewDir = path.join(parentDir, `.notify-user-install-failed-${randomUUID()}`);
  try {
    await renameEntry(destination, failedNewDir);
    await renameEntry(backupDir, destination);
    await removeEntry(failedNewDir, { recursive: true, force: true }).catch(() => undefined);
  } catch (rollbackError) {
    throw new AggregateError(
      [cleanupError, rollbackError],
      `Skill update cleanup and rollback failed; recovery data remains at ${backupDir}`,
    );
  }
}

async function digestDirectory(rootDir: string): Promise<string> {
  const hash = createHash('sha256');
  const files = await listFiles(rootDir, rootDir);
  for (const file of files) {
    const relativePath = path.relative(rootDir, file).split(path.sep).join('/');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function listFiles(rootDir: string, currentDir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(currentDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (currentDir === rootDir && entry.name === MARKER_FILE) continue;
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(rootDir, entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function readManagedMarker(destination: string): Promise<{
  owner: string;
  skill: string;
  digest: string;
  version: number;
} | null> {
  try {
    const value = JSON.parse(await readFile(path.join(destination, MARKER_FILE), 'utf8'));
    if (value?.owner !== 'itharbors'
      || value?.skill !== SKILL_NAME
      || value?.version !== MARKER_VERSION
      || typeof value?.digest !== 'string') {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function createMarker(digest: string) {
  return {
    owner: 'itharbors',
    skill: SKILL_NAME,
    digest,
    version: MARKER_VERSION,
  };
}

async function optionalLstat(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
