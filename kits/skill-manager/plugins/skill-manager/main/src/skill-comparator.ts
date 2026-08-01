import { createHash } from 'node:crypto';

import type {
  CompareInput,
  SkillAction,
  SkillCandidate,
  SkillDiagnostic,
  SkillListItem,
  SkillStatus,
} from './types.js';

type CandidateGroup = {
  key: string;
  name: string;
  candidates: SkillCandidate[];
  collisionDiagnostics: SkillDiagnostic[];
};

const ACTIONS: Record<SkillStatus, readonly SkillAction[]> = {
  'source-only': ['install'],
  current: [],
  'update-available': ['update'],
  'global-only': ['disable', 'uninstall'],
  disabled: ['restore'],
  trashed: ['restore'],
  protected: [],
  conflict: [],
  invalid: [],
};

const STATUS_ORDER: Record<SkillStatus, number> = {
  conflict: 0,
  invalid: 1,
  'update-available': 2,
  'source-only': 3,
  'global-only': 4,
  disabled: 5,
  trashed: 6,
  protected: 7,
  current: 8,
};

export function compareSkillScans(input: CompareInput): SkillListItem[] {
  const groups = groupCandidates(input);
  markBasenameCollisions(groups);
  return [...groups.values()]
    .map(projectGroup)
    .sort((left, right) => {
      const nameOrder = compareText(normalizeName(left.name), normalizeName(right.name));
      if (nameOrder !== 0) return nameOrder;
      const statusOrder = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
      return statusOrder !== 0 ? statusOrder : compareText(left.id, right.id);
    });
}

function groupCandidates(input: CompareInput): Map<string, CandidateGroup> {
  const groups = new Map<string, CandidateGroup>();
  for (const candidate of [...input.source, ...input.global, ...input.recovery]) {
    const key = candidate.manifest
      ? `name:${normalizeName(candidate.manifest.name)}`
      : `invalid:${candidate.id}`;
    const group = groups.get(key) ?? {
      key,
      name: candidate.manifest?.name ?? candidate.basename,
      candidates: [],
      collisionDiagnostics: [],
    };
    group.candidates.push(candidate);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.candidates.sort((left, right) => compareText(left.id, right.id));
  }
  return groups;
}

function markBasenameCollisions(groups: Map<string, CandidateGroup>): void {
  const sources = [...groups.values()].flatMap((group) => group.candidates
    .filter((candidate) => candidate.origin === 'source')
    .map((candidate) => ({ candidate, group })));
  const globals = [...groups.values()].flatMap((group) => group.candidates
    .filter((candidate) => candidate.origin === 'global' || candidate.origin === 'system')
    .map((candidate) => ({ candidate, group })));

  for (const source of sources) {
    for (const global of globals) {
      if (
        source.group.key === global.group.key
        || portableBasename(source.candidate.basename) !== portableBasename(global.candidate.basename)
      ) continue;
      source.group.collisionDiagnostics.push({
        code: 'SKILL_CONFLICT',
        message: `Install directory ${source.candidate.basename} is already occupied`,
      });
      global.group.collisionDiagnostics.push({
        code: 'SKILL_CONFLICT',
        message: `Source Skill targets the existing directory ${global.candidate.basename}`,
      });
    }
  }
}

function projectGroup(group: CandidateGroup): SkillListItem {
  const source = byOrigin(group, 'source');
  const global = group.candidates.filter((candidate) => (
    candidate.origin === 'global' || candidate.origin === 'system'
  ));
  const recovery = group.candidates.filter((candidate) => (
    candidate.origin === 'disabled' || candidate.origin === 'trash'
  ));
  const diagnostics = [
    ...group.candidates.flatMap((candidate) => candidate.diagnostics.map((diagnostic) => ({
      ...diagnostic,
    }))),
    ...group.collisionDiagnostics.map((diagnostic) => ({ ...diagnostic })),
  ];
  const status = deriveStatus({ source, global, recovery, diagnostics });
  const preferred = source[0] ?? global[0] ?? recovery[0] ?? group.candidates[0];

  return {
    id: opaqueGroupId(group, status),
    name: preferred.manifest?.name ?? preferred.basename,
    description: preferred.manifest?.description ?? '',
    basename: preferred.basename,
    status,
    actions: [...ACTIONS[status]],
    sourceDigest: source[0]?.digest ?? null,
    globalDigest: global[0]?.digest ?? null,
    recoveryDigest: recovery[0]?.digest ?? null,
    protected: global.some((candidate) => candidate.protected || candidate.origin === 'system'),
    diagnostics,
  };
}

function deriveStatus(input: {
  source: SkillCandidate[];
  global: SkillCandidate[];
  recovery: SkillCandidate[];
  diagnostics: SkillDiagnostic[];
}): SkillStatus {
  const all = [...input.source, ...input.global, ...input.recovery];
  if (all.some(isInvalidCandidate)) return 'invalid';
  if (
    input.source.length > 1
    || input.global.length > 1
    || input.recovery.length > 1
    || input.diagnostics.some((diagnostic) => (
      diagnostic.code === 'OVERLAPPING_SKILL' || diagnostic.code === 'SKILL_CONFLICT'
    ))
    || (input.recovery.length > 0 && (input.source.length > 0 || input.global.length > 0))
  ) return 'conflict';
  if (input.global.some((candidate) => candidate.protected || candidate.origin === 'system')) {
    return 'protected';
  }
  if (input.recovery.length === 1) {
    return input.recovery[0].origin === 'disabled' ? 'disabled' : 'trashed';
  }
  if (input.source.length === 1 && input.global.length === 0) return 'source-only';
  if (input.source.length === 0 && input.global.length === 1) return 'global-only';
  if (input.source.length === 1 && input.global.length === 1) {
    return input.source[0].digest === input.global[0].digest ? 'current' : 'update-available';
  }
  return 'invalid';
}

function isInvalidCandidate(candidate: SkillCandidate): boolean {
  return candidate.manifest === null
    || candidate.digest === null
    || candidate.diagnostics.some((diagnostic) => (
      diagnostic.code !== 'OVERLAPPING_SKILL' && diagnostic.code !== 'SKILL_CONFLICT'
    ));
}

function byOrigin(group: CandidateGroup, origin: 'source'): SkillCandidate[] {
  return group.candidates.filter((candidate) => candidate.origin === origin);
}

function opaqueGroupId(group: CandidateGroup, status: SkillStatus): string {
  const candidateIds = group.candidates.map((candidate) => candidate.id).sort(compareText);
  return createHash('sha256')
    .update(`${group.key}\0${status}\0${candidateIds.join('\0')}`)
    .digest('hex')
    .slice(0, 24);
}

function normalizeName(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase('en-US');
}

function portableBasename(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase('en-US');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
