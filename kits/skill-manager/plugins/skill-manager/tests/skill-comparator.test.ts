import { describe, expect, it } from 'vitest';

import { compareSkillScans } from '../main/src/skill-comparator.ts';
import type {
  CompareInput,
  SkillCandidate,
  SkillListItem,
  SkillOrigin,
} from '../main/src/types.ts';

describe('compareSkillScans', () => {
  it('projects the complete nine-state matrix with server-owned actions', () => {
    const items = compareSkillScans({
      source: [
        candidate('source', 'source-only', 'one'),
        candidate('source', 'current', 'same'),
        candidate('source', 'update', 'new'),
        candidate('source', 'conflict', 'one', { id: 'conflict-one' }),
        candidate('source', 'conflict', 'two', { id: 'conflict-two' }),
      ],
      global: [
        candidate('global', 'current', 'same'),
        candidate('global', 'update', 'old'),
        candidate('global', 'global-only', 'global'),
        candidate('system', 'protected', 'system', { protected: true }),
        candidate('global', null, null, { basename: 'invalid-global' }),
      ],
      recovery: [
        candidate('disabled', 'disabled', 'disabled'),
        candidate('trash', 'trashed', 'trash'),
      ],
    });

    expect(statusOf(items, 'source-only')).toEqual(['source-only', ['install']]);
    expect(statusOf(items, 'current')).toEqual(['current', []]);
    expect(statusOf(items, 'update')).toEqual(['update-available', ['update']]);
    expect(statusOf(items, 'global-only')).toEqual(['global-only', ['disable', 'uninstall']]);
    expect(statusOf(items, 'disabled')).toEqual(['disabled', ['restore']]);
    expect(statusOf(items, 'trashed')).toEqual(['trashed', ['restore']]);
    expect(statusOf(items, 'protected')).toEqual(['protected', []]);
    expect(statusOf(items, 'invalid-global')).toEqual(['invalid', []]);
    expect(statusOf(items, 'conflict')).toEqual(['conflict', []]);
  });

  it('treats overlaps and destination basename collisions as conflicts', () => {
    const overlap = candidate('source', 'overlap', 'one', {
      diagnostics: [{ code: 'OVERLAPPING_SKILL', message: 'overlap', relativePath: 'nested' }],
    });
    const sourceCollision = candidate('source', 'incoming', 'one', { basename: 'occupied' });
    const globalCollision = candidate('global', 'different-name', 'two', { basename: 'occupied' });

    const items = compareSkillScans({
      source: [overlap, sourceCollision],
      global: [globalCollision],
      recovery: [],
    });

    expect(statusOf(items, 'overlap')).toEqual(['conflict', []]);
    expect(statusOf(items, 'incoming')).toEqual(['conflict', []]);
    expect(statusOf(items, 'different-name')).toEqual(['conflict', []]);
  });

  it('returns deterministic opaque projections without filesystem paths', () => {
    const input: CompareInput = {
      source: [candidate('source', 'zeta', 'one'), candidate('source', 'alpha', 'one')],
      global: [],
      recovery: [],
    };

    const first = compareSkillScans(input);
    const second = compareSkillScans({ ...input, source: [...input.source].reverse() });

    expect(first).toEqual(second);
    expect(first.map((item) => item.name)).toEqual(['alpha', 'zeta']);
    expect(first.every((item) => /^[a-f0-9]{24}$/u.test(item.id))).toBe(true);
    expect(JSON.stringify(first)).not.toContain('/tmp/');
    expect(first[0]).not.toHaveProperty('directory');
  });
});

function statusOf(items: SkillListItem[], name: string) {
  const item = items.find((candidate) => candidate.name === name);
  expect(item, `missing item ${name}`).toBeDefined();
  return [item?.status, item?.actions];
}

function candidate(
  origin: SkillOrigin,
  name: string | null,
  digest: string | null,
  overrides: Partial<SkillCandidate> = {},
): SkillCandidate {
  const basename = overrides.basename ?? name ?? 'invalid';
  return {
    id: overrides.id ?? `${origin}-${basename}-${digest}`,
    origin,
    directory: `/tmp/private/${origin}/${basename}`,
    basename,
    manifest: name === null ? null : { name, description: `${name} description` },
    digest,
    protected: overrides.protected ?? false,
    diagnostics: overrides.diagnostics ?? [],
  };
}
