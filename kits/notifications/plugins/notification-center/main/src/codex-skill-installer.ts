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
  rename?: typeof rename;
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
        renameEntry: operations.rename ?? rename,
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
  renameEntry,
}: {
  sourceDir: string;
  codexHome: string;
  renameEntry: typeof rename;
}): Promise<CodexSkillInstallResult> {
  await validateSkillSource(sourceDir);
  const digest = await digestDirectory(sourceDir);
  const parentDir = path.join(codexHome, 'skills');
  const destination = path.join(parentDir, SKILL_NAME);
  await mkdir(parentDir, { recursive: true });

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
    await updateManagedSkill({ sourceDir, parentDir, destination, digest, renameEntry });
    return { status: 'updated', destination, digest };
  }

  const { tempRoot, stagingDir } = await stageSkill({ sourceDir, parentDir, digest });
  try {
    await renameEntry(stagingDir, destination);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
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
}: {
  sourceDir: string;
  parentDir: string;
  digest: string;
}) {
  const tempRoot = await mkdtemp(path.join(parentDir, '.notify-user-install-'));
  const stagingDir = path.join(tempRoot, SKILL_NAME);
  try {
    await cp(sourceDir, stagingDir, { recursive: true, dereference: false });
    await writeFile(
      path.join(stagingDir, MARKER_FILE),
      `${JSON.stringify(createMarker(digest), null, 2)}\n`,
      'utf8',
    );
    return { tempRoot, stagingDir };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function updateManagedSkill({
  sourceDir,
  parentDir,
  destination,
  digest,
  renameEntry,
}: {
  sourceDir: string;
  parentDir: string;
  destination: string;
  digest: string;
  renameEntry: typeof rename;
}) {
  const { tempRoot, stagingDir } = await stageSkill({ sourceDir, parentDir, digest });
  const backupDir = path.join(parentDir, `.notify-user-backup-${randomUUID()}`);
  let movedExisting = false;
  try {
    await renameEntry(destination, backupDir);
    movedExisting = true;
    try {
      await renameEntry(stagingDir, destination);
    } catch (error) {
      await renameEntry(backupDir, destination);
      movedExisting = false;
      throw error;
    }
    await rm(backupDir, { recursive: true, force: true });
    movedExisting = false;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    if (movedExisting) {
      await renameEntry(backupDir, destination).catch(() => undefined);
    }
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
