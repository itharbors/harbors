import { describe, expect, it } from 'vitest';
import { identitySummary, limitRenderedRows } from '../panel.data/src/data-view';

describe('SQLite data view helpers', () => {
  it('summarizes primary-key and rowid identities', () => {
    expect(identitySummary({ kind: 'primary-key', values: { id: { type: 'integer', value: '7' } } }))
      .toBe('id = 7');
    expect(identitySummary({ kind: 'rowid', value: { type: 'integer', value: '9' } }))
      .toBe('rowid = 9');
  });

  it('never exposes more than fifty rows to the DOM renderer', () => {
    expect(limitRenderedRows(Array.from({ length: 80 }, (_, index) => index))).toHaveLength(50);
  });
});
