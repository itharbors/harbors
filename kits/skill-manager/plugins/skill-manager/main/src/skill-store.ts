import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { digestSkillDirectory } from './digest.js';
import { parseSkillFrontmatter } from './frontmatter.js';
import {
  assertDirectoryIdentity,
  canonicalDirectory,
} from './safe-path.js';
import {
  SkillManagerError,
  type MoveInput,
  type RecoveryEntry,
  type RecoveryRecord,
  type RestoreInput,
  type ScanLimits,
  type SkillDiagnostic,
  type SkillManifest,
} from './types.js';

const DEFAULT_LIMITS: ScanLimits = {
  maxFiles: 5_000,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

type RenameEntry = (from: string, to: string) => Promise<void>;

export type SkillStore = {
  root: string;
  list(): Promise<RecoveryEntry[]>;
  moveFromGlobal(input: MoveInput): Promise<RecoveryEntry>;
  restore(input: RestoreInput): Promise<void>;
};

export async function createSkillStore(options: {
  codexHome: string;
  limits?: ScanLimits;
  renameEntry?: RenameEntry;
  createId?: () => string;
  now?: () => Date;
}): Promise<SkillStore> {
  await mkdir(options.codexHome, { recursive: true, mode: 0o700 });
  const home = await canonicalDirectory(options.codexHome);
  const root = path.join(home.directory, 'skill-manager-store', 'v1');
  const disabledRoot = path.join(root, 'disabled');
  const trashRoot = path.join(root, 'trash');
  const recordsRoot = path.join(root, 'records');
  const journalsRoot = path.join(root, 'journals');
  for (const directory of [root, disabledRoot, trashRoot, recordsRoot, journalsRoot]) {
    await ensurePrivateDirectory(directory);
  }

  const limits = options.limits ?? DEFAULT_LIMITS;
  const renameEntry = options.renameEntry ?? rename;
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const locks = createKeyedLocks();

  return Object.freeze({
    root,

    async list(): Promise<RecoveryEntry[]> {
      const records = await readdir(recordsRoot, { withFileTypes: true });
      const entries: RecoveryEntry[] = [];
      for (const recordFile of records.sort((left, right) => compareText(left.name, right.name))) {
        if (!recordFile.isFile() || !recordFile.name.endsWith('.json')) continue;
        const id = recordFile.name.slice(0, -'.json'.length);
        try {
          entries.push(await readRecoveryEntry(id));
        } catch {
          entries.push(invalidRecordEntry(id));
        }
      }
      return entries;
    },

    async moveFromGlobal(input: MoveInput): Promise<RecoveryEntry> {
      validateMoveInput(input);
      const global = await canonicalDirectory(input.globalRoot);
      const candidateDirectory = await canonicalDirectory(input.candidate.directory);
      const expectedDirectory = path.join(global.directory, input.candidate.basename);
      if (candidateDirectory.directory !== expectedDirectory) {
        throw conflict('Only direct global Skill directories can be moved');
      }

      return locks.withKeys([`global:${candidateDirectory.directory}`], async () => {
        await assertDirectoryIdentity(global.directory, global.identity);
        const currentCandidate = await canonicalDirectory(candidateDirectory.directory);
        if (
          currentCandidate.identity.dev !== candidateDirectory.identity.dev
          || currentCandidate.identity.ino !== candidateDirectory.identity.ino
        ) throw stale('Global Skill directory identity changed');

        const digest = await digestSkillDirectory(currentCandidate.directory, limits);
        if (digest.value !== input.expectedDigest || digest.value !== input.candidate.digest) {
          throw stale('Global Skill content changed after scanning');
        }
        const manifest = parseSkillFrontmatter(
          await readFile(path.join(currentCandidate.directory, 'SKILL.md'), 'utf8'),
        );
        if (manifest.name !== input.candidate.manifest?.name) {
          throw stale('Global Skill manifest changed after scanning');
        }

        const id = nextId(createId);
        const actionRoot = input.action === 'disabled' ? disabledRoot : trashRoot;
        const entryRoot = path.join(actionRoot, id);
        const storedDirectory = path.join(entryRoot, 'skill');
        const recordPath = path.join(recordsRoot, `${id}.json`);
        const temporaryRecord = path.join(recordsRoot, `.${id}.${nextId(createId)}.tmp`);
        const record: RecoveryRecord = {
          schemaVersion: 1,
          id,
          action: input.action,
          skillName: manifest.name,
          originalBasename: input.candidate.basename,
          digest: digest.value,
          createdAt: now().toISOString(),
        };

        await mkdir(entryRoot, { mode: 0o700 });
        await writeFile(temporaryRecord, `${JSON.stringify(record, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        let moved = false;
        try {
          await assertDirectoryIdentity(global.directory, global.identity);
          await assertDirectoryIdentity(currentCandidate.directory, currentCandidate.identity);
          if ((await digestSkillDirectory(currentCandidate.directory, limits)).value !== record.digest) {
            throw stale('Global Skill content changed before recovery publication');
          }
          await renameEntry(currentCandidate.directory, storedDirectory);
          moved = true;
          await renameEntry(temporaryRecord, recordPath);
        } catch (caught) {
          await unlink(temporaryRecord).catch(() => undefined);
          if (moved) {
            try {
              if (await optionalLstat(currentCandidate.directory)) {
                throw conflict('Global Skill target became occupied during rollback');
              }
              await renameEntry(storedDirectory, currentCandidate.directory);
            } catch (rollbackError) {
              await writeJournal(journalsRoot, id, {
                operation: 'move',
                record,
                globalDirectory: currentCandidate.directory,
                storedDirectory,
              });
              throw new AggregateError(
                [caught, rollbackError],
                `Skill move failed and recovery entry ${id} requires manual reconciliation`,
              );
            }
          }
          await rm(entryRoot, { recursive: true, force: true });
          throw caught;
        }

        return {
          ...record,
          directory: storedDirectory,
          manifest,
          valid: true,
          diagnostics: [],
        };
      });
    },

    async restore(input: RestoreInput): Promise<void> {
      validateRecoveryId(input.id);
      const firstEntry = await readRecoveryEntry(input.id);
      const global = await canonicalDirectory(input.globalRoot);
      const target = path.join(global.directory, firstEntry.originalBasename);
      await locks.withKeys([`recovery:${input.id}`, `global:${target}`], async () => {
        const entry = await readRecoveryEntry(input.id);
        if (!entry.valid || !entry.manifest) {
          throw invalid('Recovery entry is invalid or its content changed');
        }
        if (entry.digest !== input.expectedDigest) {
          throw stale('Recovery entry changed after scanning');
        }
        if (await optionalLstat(target)) {
          throw conflict('Restore target is already occupied');
        }
        await assertDirectoryIdentity(global.directory, global.identity);
        const currentDigest = await digestSkillDirectory(entry.directory, limits);
        if (currentDigest.value !== entry.digest) {
          throw invalid('Stored Skill content no longer matches its recovery record');
        }

        const recordPath = path.join(recordsRoot, `${entry.id}.json`);
        await renameEntry(entry.directory, target);
        try {
          await unlink(recordPath);
        } catch (caught) {
          try {
            await renameEntry(target, entry.directory);
          } catch (rollbackError) {
            await writeJournal(journalsRoot, entry.id, {
              operation: 'restore',
              record: recoveryRecord(entry),
              globalDirectory: target,
              storedDirectory: entry.directory,
            });
            throw new AggregateError(
              [caught, rollbackError],
              `Skill restore failed and recovery entry ${entry.id} requires manual reconciliation`,
            );
          }
          throw caught;
        }
        await rm(path.dirname(entry.directory), { recursive: true, force: true });
      });
    },
  });

  async function readRecoveryEntry(id: string): Promise<RecoveryEntry> {
    validateRecoveryId(id);
    const recordPath = path.join(recordsRoot, `${id}.json`);
    let record: RecoveryRecord;
    try {
      record = parseRecoveryRecord(JSON.parse(await readFile(recordPath, 'utf8')), id);
    } catch (caught) {
      throw invalid('Recovery record is missing or invalid', caught);
    }
    const actionRoot = record.action === 'disabled' ? disabledRoot : trashRoot;
    const directory = path.join(actionRoot, id, 'skill');
    try {
      const digest = await digestSkillDirectory(directory, limits);
      const manifest = parseSkillFrontmatter(await readFile(path.join(directory, 'SKILL.md'), 'utf8'));
      if (digest.value !== record.digest || manifest.name !== record.skillName) {
        throw invalid('Stored Skill does not match its recovery record');
      }
      return { ...record, directory, manifest, valid: true, diagnostics: [] };
    } catch (caught) {
      return {
        ...record,
        directory,
        manifest: null,
        valid: false,
        diagnostics: [diagnostic(caught)],
      };
    }
  }

  function invalidRecordEntry(id: string): RecoveryEntry {
    return {
      schemaVersion: 1,
      id,
      action: 'trash',
      skillName: id,
      originalBasename: id,
      digest: '',
      createdAt: '',
      directory: root,
      manifest: null,
      valid: false,
      diagnostics: [{
        code: 'INVALID_SKILL',
        message: 'Recovery record is missing or invalid',
      }],
    };
  }
}

function validateMoveInput(input: MoveInput): void {
  if (input.action !== 'disabled' && input.action !== 'trash') {
    throw new TypeError('Recovery action must be disabled or trash');
  }
  if (
    input.candidate.protected
    || input.candidate.origin !== 'global'
    || !input.candidate.manifest
    || !input.candidate.digest
  ) throw conflict('Protected, system, or invalid Skills cannot be moved');
  if (input.expectedDigest !== input.candidate.digest) {
    throw stale('Expected digest does not match the scanned Skill');
  }
  validateBasename(input.candidate.basename);
}

function parseRecoveryRecord(value: unknown, expectedId: string): RecoveryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Recovery record must be an object');
  const record = value as Partial<RecoveryRecord>;
  const keys = Object.keys(value).sort(compareText);
  if (
    JSON.stringify(keys) !== JSON.stringify([
      'action',
      'createdAt',
      'digest',
      'id',
      'originalBasename',
      'schemaVersion',
      'skillName',
    ])
    ||
    record.schemaVersion !== 1
    || record.id !== expectedId
    || (record.action !== 'disabled' && record.action !== 'trash')
    || typeof record.skillName !== 'string'
    || typeof record.originalBasename !== 'string'
    || typeof record.digest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(record.digest)
    || typeof record.createdAt !== 'string'
    || Number.isNaN(Date.parse(record.createdAt))
  ) throw invalid('Recovery record fields are invalid');
  validateBasename(record.originalBasename);
  return record as RecoveryRecord;
}

function recoveryRecord(entry: RecoveryEntry): RecoveryRecord {
  return {
    schemaVersion: 1,
    id: entry.id,
    action: entry.action,
    skillName: entry.skillName,
    originalBasename: entry.originalBasename,
    digest: entry.digest,
    createdAt: entry.createdAt,
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SkillManagerError('UNSAFE_PATH', 'Recovery store contains an unsafe directory');
  }
  await chmod(directory, 0o700);
}

function validateRecoveryId(id: string): void {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9-]{27}$/u.test(id)) {
    throw invalid('Recovery entry id is invalid');
  }
}

function nextId(createId: () => string): string {
  const id = createId();
  validateRecoveryId(id);
  return id;
}

function validateBasename(value: string): void {
  if (
    value.length === 0
    || value === '.'
    || value === '..'
    || path.basename(value) !== value
    || value.includes('/')
    || value.includes('\\')
  ) throw invalid('Recovery basename is invalid');
}

async function optionalLstat(target: string) {
  try {
    return await lstat(target);
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw caught;
  }
}

async function writeJournal(
  journalsRoot: string,
  id: string,
  value: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    path.join(journalsRoot, `${id}.json`),
    `${JSON.stringify({ schemaVersion: 1, id, ...value }, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
}

function diagnostic(caught: unknown): SkillDiagnostic {
  return {
    code: 'INVALID_SKILL',
    message: 'Recovery entry is missing, unsafe, or changed',
  };
}

function invalid(message: string, cause?: unknown): SkillManagerError {
  return new SkillManagerError('INVALID_SKILL', message, cause === undefined ? undefined : { cause });
}

function conflict(message: string): SkillManagerError {
  return new SkillManagerError('SKILL_CONFLICT', message);
}

function stale(message: string): SkillManagerError {
  return new SkillManagerError('STALE_SNAPSHOT', message);
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

  async function withKeys<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort(compareText);
    const acquire = (index: number): Promise<T> => (
      index === ordered.length
        ? operation()
        : withKey(ordered[index], () => acquire(index + 1))
    );
    return acquire(0);
  }

  return { withKeys };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
