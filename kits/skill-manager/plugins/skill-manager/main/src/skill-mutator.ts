import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { digestSkillDirectory } from './digest.ts';
import {
  assertDirectoryIdentity,
  canonicalDirectory,
  type DirectoryIdentity,
} from './safe-path.ts';
import type { SkillStore } from './skill-store.ts';
import {
  SkillManagerError,
  type MutationAction,
  type MutationInput,
  type MutationReceipt,
  type ScanLimits,
  type SkillCandidate,
} from './types.ts';

const DEFAULT_LIMITS: ScanLimits = {
  maxFiles: 5_000,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

type MutationHooks = {
  afterStage?(input: { action: 'install' | 'update'; targetBasename: string }): Promise<void>;
};

export type SkillMutator = {
  install(input: MutationInput): Promise<MutationReceipt>;
  update(input: MutationInput): Promise<MutationReceipt>;
  disable(input: MutationInput): Promise<MutationReceipt>;
  uninstall(input: MutationInput): Promise<MutationReceipt>;
  restore(input: MutationInput): Promise<MutationReceipt>;
};

export async function createSkillMutator(options: {
  globalRoot: string;
  store: SkillStore;
  limits?: ScanLimits;
  renameEntry?: (from: string, to: string) => Promise<void>;
  hooks?: MutationHooks;
  createId?: () => string;
}): Promise<SkillMutator> {
  const global = await canonicalDirectory(options.globalRoot);
  const limits = options.limits ?? DEFAULT_LIMITS;
  const renameEntry = options.renameEntry ?? rename;
  const createId = options.createId ?? randomUUID;
  const locks = createKeyedLocks();
  const journalsRoot = path.join(options.store.root, 'journals');

  return Object.freeze({
    install(input: MutationInput) {
      const source = requireSource(input);
      return locks.withKey(targetKey(source.basename), () => installLocked(input, source));
    },

    update(input: MutationInput) {
      const source = requireSource(input);
      const current = requireGlobal(input);
      if (source.manifest?.name !== current.manifest?.name) {
        throw conflict('Update source and global Skill names must match');
      }
      return locks.withKey(targetKey(current.basename), () => updateLocked(input, source, current));
    },

    async disable(input: MutationInput): Promise<MutationReceipt> {
      return moveToStore('disable', input, 'disabled');
    },

    async uninstall(input: MutationInput): Promise<MutationReceipt> {
      return moveToStore('uninstall', input, 'trash');
    },

    async restore(input: MutationInput): Promise<MutationReceipt> {
      validateRevision(input.revision);
      if (!input.recoveryId) throw invalid('Recovery id is required');
      await options.store.restore({
        globalRoot: global.directory,
        id: input.recoveryId,
        expectedDigest: input.expectedDigest,
      });
      return {
        action: 'restore',
        status: 'completed',
        revision: input.revision,
        basename: '',
        digest: input.expectedDigest,
      };
    },
  });

  async function installLocked(
    input: MutationInput,
    source: SkillCandidate,
  ): Promise<MutationReceipt> {
    validateRevision(input.revision);
    if (input.expectedDigest !== source.digest) throw stale('Source digest is stale');
    const target = path.join(global.directory, source.basename);
    const stage = await prepareStage('install', source);
    let targetIdentity: DirectoryIdentity | undefined;
    try {
      await options.hooks?.afterStage?.({ action: 'install', targetBasename: source.basename });
      await assertSourceUnchanged(source);
      await assertDirectoryIdentity(global.directory, global.identity);
      try {
        await mkdir(target, { mode: 0o700 });
      } catch (caught) {
        if ((caught as NodeJS.ErrnoException).code === 'EEXIST') {
          throw conflict('Install target is already occupied');
        }
        throw caught;
      }
      targetIdentity = (await canonicalDirectory(target)).identity;
      await copyDirectoryContents(stage.directory, target, true);
      await assertDirectoryIdentity(target, targetIdentity);
      if ((await digestSkillDirectory(target, limits)).value !== source.digest) {
        throw invalid('Published Skill does not match the staged source');
      }
      return receipt('install', input, source.basename, source.digest!);
    } catch (caught) {
      if (targetIdentity) {
        try {
          await assertDirectoryIdentity(target, targetIdentity);
          await rm(target, { recursive: true });
        } catch (cleanupError) {
          throw new AggregateError(
            [caught, cleanupError],
            'Skill installation failed and its partial target could not be removed safely',
          );
        }
      }
      throw caught;
    } finally {
      await removeOwnedDirectory(
        stage.directory,
        global.directory,
        '.skill-manager-stage-',
        stage.identity,
      );
    }
  }

  async function updateLocked(
    input: MutationInput,
    source: SkillCandidate,
    current: SkillCandidate,
  ): Promise<MutationReceipt> {
    validateRevision(input.revision);
    if (input.expectedDigest !== current.digest) throw stale('Global digest is stale');
    const target = path.join(global.directory, current.basename);
    const currentDirectory = await canonicalDirectory(current.directory);
    if (currentDirectory.directory !== target) throw conflict('Update target is not a direct global Skill');
    if ((await digestSkillDirectory(target, limits)).value !== current.digest) {
      throw stale('Global Skill changed after scanning');
    }

    const stage = await prepareStage('update', source);
    const id = validatedId(createId());
    const backupBasename = `.skill-manager-backup-${id}`;
    const backup = path.join(global.directory, backupBasename);
    const journalPath = path.join(journalsRoot, `${id}.json`);
    const journal = {
      schemaVersion: 1,
      id,
      operation: 'update',
      targetBasename: current.basename,
      expectedOldDigest: current.digest,
      backupBasename,
      stageBasename: path.basename(stage.directory),
    };
    let backupMoved = false;
    let published = false;
    try {
      await options.hooks?.afterStage?.({ action: 'update', targetBasename: current.basename });
      await assertSourceUnchanged(source);
      if ((await digestSkillDirectory(target, limits)).value !== current.digest) {
        throw stale('Global Skill changed before update publication');
      }
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await assertDirectoryIdentity(global.directory, global.identity);
      await renameEntry(target, backup);
      backupMoved = true;
      if (await optionalLstat(target)) throw conflict('Update target became occupied');
      await renameEntry(stage.directory, target);
      published = true;
      await assertDirectoryIdentity(target, stage.identity);
      if ((await digestSkillDirectory(target, limits)).value !== source.digest) {
        throw invalid('Updated Skill does not match the staged source');
      }
      try {
        await removeOwnedDirectory(
          backup,
          global.directory,
          '.skill-manager-backup-',
          currentDirectory.identity,
        );
        await unlink(journalPath);
      } catch {
        return receipt('update', input, current.basename, source.digest!, 'recovery-required', id);
      }
      return receipt('update', input, current.basename, source.digest!);
    } catch (caught) {
      if (!backupMoved) {
        await unlink(journalPath).catch(() => undefined);
        throw caught;
      }
      if (published) {
        try {
          await assertDirectoryIdentity(target, stage.identity);
          await rm(target, { recursive: true });
        } catch (cleanupError) {
          return receipt('update', input, current.basename, current.digest!, 'recovery-required', id);
        }
      }
      if (await optionalLstat(target)) {
        return receipt('update', input, current.basename, current.digest!, 'recovery-required', id);
      }
      try {
        await renameEntry(backup, target);
        await unlink(journalPath);
      } catch {
        return receipt('update', input, current.basename, current.digest!, 'recovery-required', id);
      }
      throw caught;
    } finally {
      await removeOwnedDirectory(
        stage.directory,
        global.directory,
        '.skill-manager-stage-',
        stage.identity,
      );
    }
  }

  async function prepareStage(
    action: 'install' | 'update',
    source: SkillCandidate,
  ): Promise<{ directory: string; identity: DirectoryIdentity }> {
    const sourceDirectory = await canonicalDirectory(source.directory);
    const initialDigest = await digestSkillDirectory(sourceDirectory.directory, limits);
    if (initialDigest.value !== source.digest) throw stale('Source Skill changed after scanning');
    const id = validatedId(createId());
    const directory = path.join(global.directory, `.skill-manager-stage-${id}`);
    await mkdir(directory, { mode: 0o700 });
    const identity = (await canonicalDirectory(directory)).identity;
    try {
      await copyDirectoryContents(sourceDirectory.directory, directory, false);
      if ((await digestSkillDirectory(directory, limits)).value !== source.digest) {
        throw invalid(`Staged ${action} content does not match its source`);
      }
      return { directory, identity };
    } catch (caught) {
      await removeOwnedDirectory(directory, global.directory, '.skill-manager-stage-', identity);
      throw caught;
    }
  }

  async function assertSourceUnchanged(source: SkillCandidate): Promise<void> {
    try {
      if ((await digestSkillDirectory(source.directory, limits)).value !== source.digest) {
        throw stale('Source Skill changed during staging');
      }
    } catch (caught) {
      if (caught instanceof SkillManagerError && caught.code === 'UNSAFE_PATH') throw caught;
      if (caught instanceof SkillManagerError) throw caught;
      throw stale('Source Skill could not be revalidated');
    }
  }

  async function moveToStore(
    action: 'disable' | 'uninstall',
    input: MutationInput,
    recoveryAction: 'disabled' | 'trash',
  ): Promise<MutationReceipt> {
    validateRevision(input.revision);
    const current = requireGlobal(input);
    const entry = await options.store.moveFromGlobal({
      globalRoot: global.directory,
      candidate: current,
      action: recoveryAction,
      expectedDigest: input.expectedDigest,
    });
    return receipt(action, input, current.basename, entry.digest, 'completed', entry.id);
  }

  function targetKey(basename: string): string {
    validateBasename(basename);
    return path.join(global.directory, basename);
  }
}

async function copyDirectoryContents(source: string, destination: string, deferSkillFile: boolean) {
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    if (deferSkillFile && entry.name === 'SKILL.md') continue;
    await copyEntry(path.join(source, entry.name), path.join(destination, entry.name));
  }
  if (deferSkillFile) {
    await copyEntry(path.join(source, 'SKILL.md'), path.join(destination, 'SKILL.md'));
  }
}

async function copyEntry(source: string, destination: string): Promise<void> {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) throw new SkillManagerError('UNSAFE_PATH', 'Skill contains a symbolic link');
  if (stat.isDirectory()) {
    await mkdir(destination, { mode: 0o700 });
    await copyDirectoryContents(source, destination, false);
    return;
  }
  if (!stat.isFile()) throw new SkillManagerError('UNSAFE_PATH', 'Skill contains a special file');

  const sourceFile = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const openedStat = await sourceFile.stat();
    if (!openedStat.isFile()) throw new SkillManagerError('UNSAFE_PATH', 'Skill source changed while copying');
    const contents = await sourceFile.readFile();
    await writeFile(destination, contents, { flag: 'wx', mode: 0o600 });
    await chmod(destination, 0o600 | (openedStat.mode & 0o100));
  } finally {
    await sourceFile.close();
  }
}

async function removeOwnedDirectory(
  directory: string,
  expectedParent: string,
  prefix: string,
  expectedIdentity: DirectoryIdentity,
): Promise<void> {
  const basename = path.basename(directory);
  if (
    path.dirname(directory) !== expectedParent
    || !basename.startsWith(prefix)
    || !/^[a-f0-9-]{36}$/u.test(basename.slice(prefix.length))
  ) {
    throw new SkillManagerError('UNSAFE_PATH', 'Refused to remove an unrecognized transaction directory');
  }
  if (!await optionalLstat(directory)) return;
  await assertDirectoryIdentity(directory, expectedIdentity);
  await rm(directory, { recursive: true });
}

function requireSource(input: MutationInput): SkillCandidate {
  validateRevision(input.revision);
  const source = input.source;
  if (
    !source
    || source.origin !== 'source'
    || source.protected
    || !source.manifest
    || !source.digest
  ) throw invalid('A valid source Skill is required');
  validateBasename(source.basename);
  return source;
}

function requireGlobal(input: MutationInput): SkillCandidate {
  validateRevision(input.revision);
  const current = input.global;
  if (
    !current
    || current.origin !== 'global'
    || current.protected
    || !current.manifest
    || !current.digest
  ) throw invalid('A writable global Skill is required');
  validateBasename(current.basename);
  return current;
}

function validateRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) throw stale('Mutation revision is invalid');
}

function validateBasename(value: string): void {
  if (
    value.length === 0
    || value === '.'
    || value === '..'
    || path.basename(value) !== value
    || value.includes('/')
    || value.includes('\\')
    || value.startsWith('.skill-manager-')
  ) throw invalid('Skill basename is invalid');
}

function validatedId(id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(id)) {
    throw invalid('Transaction id is invalid');
  }
  return id.toLowerCase();
}

function receipt(
  action: MutationAction,
  input: MutationInput,
  basename: string,
  digest: string,
  status: MutationReceipt['status'] = 'completed',
  recoveryId?: string,
): MutationReceipt {
  return {
    action,
    status,
    revision: input.revision,
    basename,
    digest,
    ...(recoveryId ? { recoveryId } : {}),
  };
}

async function optionalLstat(target: string) {
  try {
    return await lstat(target);
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw caught;
  }
}

function createKeyedLocks() {
  const tails = new Map<string, Promise<void>>();
  async function withKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release = () => undefined;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => turn);
    tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  }
  return { withKey };
}

function invalid(message: string): SkillManagerError {
  return new SkillManagerError('INVALID_SKILL', message);
}

function conflict(message: string): SkillManagerError {
  return new SkillManagerError('SKILL_CONFLICT', message);
}

function stale(message: string): SkillManagerError {
  return new SkillManagerError('STALE_SNAPSHOT', message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
