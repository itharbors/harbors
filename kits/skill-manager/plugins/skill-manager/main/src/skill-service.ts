import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { compareSkillScans } from './skill-comparator.js';
import {
  createDirectoryBrowser,
  type DirectoryBrowser,
  type DirectoryPage,
} from './directory-browser.js';
import { digestSkillDirectory } from './digest.js';
import { createSkillMutator, type SkillMutator } from './skill-mutator.js';
import {
  recoveryEntriesToCandidates,
  scanGlobalRoot,
  scanSourceRoot,
} from './skill-scanner.js';
import { createSkillStore } from './skill-store.js';
import {
  SkillManagerError,
  type MutationAction,
  type ScanLimits,
  type ScanOptions,
  type SkillAction,
  type SkillCandidate,
  type SkillDetail,
  type SkillDetailLocation,
  type SkillDiagnostic,
  type SkillListItem,
  type SkillScanResult,
  type SkillSnapshot,
  type SkillStatus,
} from './types.js';

export const SNAPSHOT_CHANGED = '@itharbors/skill-manager.snapshot.changed';
export const SCAN_PROGRESS = '@itharbors/skill-manager.scan.progress';
export const OPERATION_PROGRESS = '@itharbors/skill-manager.operation.progress';

const DEFAULT_LIMITS: ScanLimits = {
  maxFiles: 5_000,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

const STATUSES: SkillStatus[] = [
  'source-only',
  'current',
  'update-available',
  'global-only',
  'disabled',
  'trashed',
  'protected',
  'conflict',
  'invalid',
];

type CandidateIndex = {
  item: SkillListItem;
  source: SkillCandidate[];
  global: SkillCandidate[];
  recovery: SkillCandidate[];
};

type ScanFunction = (root: string, options: ScanOptions) => Promise<SkillScanResult>;

export type SkillService = {
  getSnapshot(): SkillSnapshot;
  browseDirectory(input: unknown): Promise<DirectoryPage>;
  selectSource(input: unknown): Promise<SkillSnapshot>;
  clearSource(): Promise<SkillSnapshot>;
  rescan(): Promise<SkillSnapshot>;
  getSkillDetail(input: unknown): Promise<SkillDetail>;
  performAction(input: unknown): Promise<{ receipt: unknown; snapshot: SkillSnapshot }>;
  dispose(): void;
};

export async function createSkillService(options: {
  codexHome: string;
  homeDirectory: string;
  filesystemRoots?: string[];
  broadcast(topic: string, payload: unknown): void;
  limits?: ScanLimits;
  scanSource?: ScanFunction;
  scanGlobal?: ScanFunction;
}): Promise<SkillService> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const globalRoot = path.join(options.codexHome, 'skills');
  await mkdir(globalRoot, { recursive: true, mode: 0o700 });
  const browser = await createDirectoryBrowser({
    homeDirectory: options.homeDirectory,
    filesystemRoots: options.filesystemRoots ?? [path.parse(options.homeDirectory).root],
  });
  const store = await createSkillStore({ codexHome: options.codexHome, limits });
  const mutator = await createSkillMutator({ globalRoot, store, limits });
  const scanSource = options.scanSource ?? scanSourceRoot;
  const scanGlobal = options.scanGlobal ?? scanGlobalRoot;

  let disposed = false;
  let generation = 0;
  let activeScan: AbortController | null = null;
  let sourceSelection: { directory: string; displayPath: string } | null = null;
  let privateIndex = new Map<string, CandidateIndex>();
  let snapshot = freezeSnapshot({
    revision: 0,
    generation: 0,
    mode: 'global',
    globalRootLabel: '$CODEX_HOME/skills',
    sourceRootLabel: null,
    scanning: false,
    truncated: false,
    counts: emptyCounts(),
    items: [],
    diagnostics: [],
  });

  const service: SkillService = Object.freeze({
    getSnapshot() {
      return snapshot;
    },

    async browseDirectory(input: unknown) {
      ensureActive();
      const value = optionalRecord(input);
      return browser.open(optionalString(value.directoryId));
    },

    async selectSource(input: unknown) {
      ensureActive();
      const value = requiredRecord(input, 'Source selection');
      const directoryId = requiredString(value.directoryId, 'directoryId');
      sourceSelection = await browser.resolveSelection(directoryId);
      return runScan();
    },

    async clearSource() {
      ensureActive();
      sourceSelection = null;
      return runScan();
    },

    async rescan() {
      ensureActive();
      return runScan();
    },

    async getSkillDetail(input: unknown) {
      ensureActive();
      const request = parseRevisionRequest(input);
      const entry = requireCurrentEntry(request.skillId, request.revision);
      try {
        return deepFreeze({
          id: entry.item.id,
          revision: snapshot.revision,
          name: entry.item.name,
          description: entry.item.description,
          status: entry.item.status,
          diagnostics: entry.item.diagnostics.map((diagnostic) => ({ ...diagnostic })),
          source: await detailLocation(entry.source[0]),
          global: await detailLocation(entry.global[0]),
          recovery: await detailLocation(entry.recovery[0]),
        });
      } catch (caught) {
        if (caught instanceof SkillManagerError && caught.code === 'STALE_SNAPSHOT') {
          void runScan().catch(() => undefined);
        }
        throw caught;
      }
    },

    async performAction(input: unknown) {
      ensureActive();
      const request = parseActionRequest(input);
      const entry = requireCurrentEntry(request.skillId, request.revision);
      if (!entry.item.actions.includes(request.action)) {
        throw new SkillManagerError('SKILL_CONFLICT', 'Action is not allowed for the current Skill state');
      }
      const digest = expectedActionDigest(entry.item, request.action);
      if (!digest || digest !== request.expectedDigest) {
        throw new SkillManagerError('STALE_SNAPSHOT', 'Expected digest does not match the current Skill state');
      }

      options.broadcast(OPERATION_PROGRESS, deepFreeze({
        action: request.action,
        skillId: request.skillId,
        revision: request.revision,
        state: 'started',
      }));
      try {
        const receipt = await mutate(request.action, request.revision, digest, entry, mutator);
        const nextSnapshot = await runScan();
        options.broadcast(OPERATION_PROGRESS, deepFreeze({
          action: request.action,
          skillId: request.skillId,
          revision: nextSnapshot.revision,
          state: 'completed',
        }));
        return deepFreeze({ receipt, snapshot: nextSnapshot });
      } catch (caught) {
        options.broadcast(OPERATION_PROGRESS, deepFreeze({
          action: request.action,
          skillId: request.skillId,
          revision: snapshot.revision,
          state: 'failed',
        }));
        throw caught;
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      activeScan?.abort();
      activeScan = null;
      privateIndex.clear();
    },
  });

  await runScan();
  return service;

  async function runScan(): Promise<SkillSnapshot> {
    ensureActive();
    activeScan?.abort();
    const controller = new AbortController();
    activeScan = controller;
    const scanGeneration = ++generation;
    snapshot = freezeSnapshot({
      ...snapshot,
      generation: scanGeneration,
      mode: sourceSelection ? 'source' : 'global',
      sourceRootLabel: sourceSelection?.displayPath ?? null,
      scanning: true,
    });
    options.broadcast(SCAN_PROGRESS, deepFreeze({
      generation: scanGeneration,
      state: 'started',
      mode: snapshot.mode,
    }));

    try {
      const scanOptions = { limits, signal: controller.signal };
      const [globalScan, sourceScan, recoveryEntries] = await Promise.all([
        scanGlobal(globalRoot, scanOptions),
        sourceSelection
          ? scanSource(sourceSelection.directory, scanOptions)
          : Promise.resolve<SkillScanResult>({ candidates: [], diagnostics: [], truncated: false }),
        store.list(),
      ]);
      if (disposed || scanGeneration !== generation || controller.signal.aborted) return snapshot;
      const recovery = recoveryEntriesToCandidates(recoveryEntries);
      const compareInput = {
        source: sourceScan.candidates,
        global: globalScan.candidates,
        recovery,
      };
      const items = compareSkillScans(compareInput);
      privateIndex = buildPrivateIndex(items, compareInput);
      const diagnostics = [
        ...globalScan.diagnostics,
        ...sourceScan.diagnostics,
        ...recoveryEntries.flatMap((entry) => entry.diagnostics),
      ].map((diagnostic) => ({ ...diagnostic }));
      snapshot = freezeSnapshot({
        revision: snapshot.revision + 1,
        generation: scanGeneration,
        mode: sourceSelection ? 'source' : 'global',
        globalRootLabel: '$CODEX_HOME/skills',
        sourceRootLabel: sourceSelection?.displayPath ?? null,
        scanning: false,
        truncated: globalScan.truncated || sourceScan.truncated,
        counts: countStatuses(items),
        items,
        diagnostics,
      });
      options.broadcast(SNAPSHOT_CHANGED, snapshot);
      options.broadcast(SCAN_PROGRESS, deepFreeze({
        generation: scanGeneration,
        state: 'completed',
        revision: snapshot.revision,
      }));
      return snapshot;
    } catch (caught) {
      if (disposed || scanGeneration !== generation || controller.signal.aborted) return snapshot;
      snapshot = freezeSnapshot({ ...snapshot, scanning: false });
      options.broadcast(SCAN_PROGRESS, deepFreeze({
        generation: scanGeneration,
        state: 'failed',
        code: caught instanceof SkillManagerError ? caught.code : 'INVALID_SKILL',
      }));
      throw caught;
    } finally {
      if (activeScan === controller) activeScan = null;
    }
  }

  function ensureActive(): void {
    if (disposed) throw new SkillManagerError('SCAN_CANCELLED', 'Skill service is disposed');
  }

  async function detailLocation(candidate?: SkillCandidate): Promise<SkillDetailLocation | null> {
    if (!candidate?.manifest || !candidate.digest) return null;
    const digest = await digestSkillDirectory(candidate.directory, limits);
    if (digest.value !== candidate.digest) {
      throw new SkillManagerError('STALE_SNAPSHOT', 'Skill content changed after scanning');
    }
    const text = await readFile(path.join(candidate.directory, 'SKILL.md'), 'utf8');
    return {
      origin: candidate.origin,
      basename: candidate.basename,
      manifest: { ...candidate.manifest },
      digest: candidate.digest,
      text,
    };
  }

  function requireCurrentEntry(skillId: string, revision: number): CandidateIndex {
    if (revision !== snapshot.revision) {
      throw new SkillManagerError('STALE_SNAPSHOT', 'Snapshot revision is stale');
    }
    const entry = privateIndex.get(skillId);
    if (!entry) throw new SkillManagerError('STALE_SNAPSHOT', 'Skill id is unknown or stale');
    return entry;
  }
}

async function mutate(
  action: SkillAction,
  revision: number,
  expectedDigest: string,
  entry: CandidateIndex,
  mutator: SkillMutator,
) {
  const input = {
    revision,
    expectedDigest,
    source: entry.source[0],
    global: entry.global[0],
    recoveryId: entry.recovery[0]?.id,
  };
  return mutator[action](input);
}

function buildPrivateIndex(
  items: SkillListItem[],
  input: { source: SkillCandidate[]; global: SkillCandidate[]; recovery: SkillCandidate[] },
): Map<string, CandidateIndex> {
  const index = new Map<string, CandidateIndex>();
  for (const item of items) {
    const matches = (candidate: SkillCandidate) => candidate.manifest
      ? candidate.manifest.name === item.name
      : candidate.basename === item.basename;
    index.set(item.id, {
      item,
      source: input.source.filter(matches),
      global: input.global.filter(matches),
      recovery: input.recovery.filter(matches),
    });
  }
  return index;
}

function expectedActionDigest(item: SkillListItem, action: SkillAction): string | null {
  if (action === 'install') return item.sourceDigest;
  if (action === 'update' || action === 'disable' || action === 'uninstall') return item.globalDigest;
  return item.recoveryDigest;
}

function countStatuses(items: SkillListItem[]): Record<SkillStatus, number> {
  const counts = emptyCounts();
  for (const item of items) counts[item.status] += 1;
  return counts;
}

function emptyCounts(): Record<SkillStatus, number> {
  return Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<SkillStatus, number>;
}

function parseRevisionRequest(input: unknown): { skillId: string; revision: number } {
  const value = requiredRecord(input, 'Skill detail request');
  return {
    skillId: requiredString(value.skillId, 'skillId'),
    revision: requiredRevision(value.revision),
  };
}

function parseActionRequest(input: unknown): {
  action: SkillAction;
  skillId: string;
  revision: number;
  expectedDigest: string;
} {
  const value = requiredRecord(input, 'Skill action request');
  const action = requiredString(value.action, 'action') as SkillAction;
  if (!['install', 'update', 'disable', 'uninstall', 'restore'].includes(action)) {
    throw new SkillManagerError('SKILL_CONFLICT', 'Skill action is invalid');
  }
  return {
    action,
    skillId: requiredString(value.skillId, 'skillId'),
    revision: requiredRevision(value.revision),
    expectedDigest: requiredString(value.expectedDigest, 'expectedDigest'),
  };
}

function requiredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SkillManagerError('STALE_SNAPSHOT', 'Snapshot revision is invalid');
  }
  return value as number;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : requiredRecord(value, 'Directory request');
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredString(value, 'directoryId');
}

function freezeSnapshot(value: SkillSnapshot): SkillSnapshot {
  return deepFreeze(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
