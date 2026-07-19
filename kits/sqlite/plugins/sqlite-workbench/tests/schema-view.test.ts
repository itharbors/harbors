// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { groupSchemaObjects, renderSqlCode } from '../panel.workbench/src/schema-view';

describe('SQLite schema view', () => {
  it('groups object kinds without inferring from names', () => {
    const groups = groupSchemaObjects([
      { name: 'users', kind: 'table' },
      { name: 'active_users', kind: 'view' },
      { name: 'search', kind: 'virtual' },
      { name: 'search_data', kind: 'shadow' },
    ]);
    expect(groups.map((group) => [group.kind, group.objects.length, group.collapsed])).toEqual([
      ['table', 1, false],
      ['view', 1, false],
      ['virtual', 1, false],
      ['shadow', 1, true],
    ]);
  });

  it('renders formatted SQL as text tokens with matching line numbers', () => {
    const code = renderSqlCode('CREATE TABLE users (id INTEGER, name TEXT);');
    expect(code.querySelectorAll('.sql-line-number')).toHaveLength(
      code.querySelector('code')!.textContent!.split('\n').length,
    );
    expect(code.querySelector('.sql-token-keyword')?.textContent).toBe('CREATE');
    expect(code.textContent).toContain('users');
  });
});
