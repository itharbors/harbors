import { describe, expect, it } from 'vitest';
import {
  groupRelationshipGraph,
  tokenizeTableName,
  type RelationshipGraph,
} from '../src/index.js';

function graphOf(names: string[]): RelationshipGraph {
  return {
    tables: names.map((name) => ({ name, kind: 'table', columns: [] })),
    relationships: [],
  };
}

describe('relationship graph table names', () => {
  it('tokenizes separators, camel case, numbers, and conservative plurals', () => {
    expect(tokenizeTableName('UserProfile2FA')).toEqual(['user', 'profile', '2', 'fa']);
    expect(tokenizeTableName('users_roles')).toEqual(['user', 'role']);
    expect(tokenizeTableName('audit-log')).toEqual(['audit', 'log']);
    expect(tokenizeTableName('status')).toEqual(['status']);
    expect(tokenizeTableName('地址明细2')).toEqual(['地址明细', '2']);
  });

  it('groups close business names without joining unrelated technical suffixes', () => {
    const groups = groupRelationshipGraph(graphOf([
      'user',
      'user_profile',
      'user_roles',
      'order',
      'order_items',
      'audit_log',
    ]));

    expect(groups.get('user_profile')).toBe(groups.get('user_roles'));
    expect(groups.get('user')).toBe(groups.get('user_profile'));
    expect(groups.get('order')).toBe(groups.get('order_items'));
    expect(groups.get('audit_log')).not.toBe(groups.get('user'));
    expect(groups.get('audit_log')).not.toBe(groups.get('order'));
  });

  it('bounds candidate comparisons with a token index and local windows', () => {
    const graph = graphOf(Array.from({ length: 2_000 }, (_, index) => (
      `module_${String(index).padStart(4, '0')}_data`
    )));
    let candidates = 0;

    groupRelationshipGraph(graph, { onCandidatePair: () => { candidates += 1; } });

    expect(candidates).toBeLessThan(graph.tables.length * 24);
  });
});
