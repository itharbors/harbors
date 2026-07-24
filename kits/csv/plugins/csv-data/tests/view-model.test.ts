import { describe, expect, it } from 'vitest';
import type { CsvQuery } from '@itharbors/csv-contracts';
import {
  escapeHtml,
  formatCellPreview,
  normalizeQuery,
  queryWithFilter,
  toggleSort,
} from '../panel.data/src/view-model.js';
import { cellDetailContent } from '../panel.data/src/csv-cell.js';

const query: CsvQuery = {
  connectionRevision: 4,
  page: 3,
  pageSize: 50,
  search: '  001  ',
  filters: [],
  sort: null,
};

describe('CSV data view model', () => {
  it('escapes unsafe HTML without changing CSV text semantics', () => {
    expect(escapeHtml('<script data-x="&">\'')).toBe('&lt;script data-x=&quot;&amp;&quot;&gt;&#39;');
    expect(formatCellPreview('  001  ')).toBe('  001  ');
    expect(formatCellPreview('90071992547409930001')).toBe('90071992547409930001');
    expect(formatCellPreview('<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;');
  });

  it('renders a literal empty string as a visible badge while detail stays empty', () => {
    expect(formatCellPreview('')).toContain('class="empty-cell"');
    expect(formatCellPreview('')).toContain('空');
    expect(formatCellPreview('')).not.toContain('NULL');
    expect(cellDetailContent('')).toBe('');
    expect(cellDetailContent('  001  ')).toBe('  001  ');
  });

  it('normalizes page sizes and filter values without mutating source text', () => {
    expect(normalizeQuery({ ...query, page: -2, pageSize: 10 as CsvQuery['pageSize'] })).toEqual({
      ...query,
      page: 1,
      pageSize: 50,
      filters: [],
    });
    expect(normalizeQuery({
      ...query,
      filters: [
        { columnId: 'column-1', operator: 'contains', value: ' 001 ' },
        { columnId: 'column-2', operator: 'is-empty', value: 'ignored' },
      ],
    }).filters).toEqual([
      { columnId: 'column-1', operator: 'contains', value: ' 001 ' },
      { columnId: 'column-2', operator: 'is-empty' },
    ]);
  });

  it('cycles one sort and resets page one for query changes', () => {
    expect(toggleSort(null, 'column-2')).toEqual({ columnId: 'column-2', direction: 'asc' });
    expect(toggleSort({ columnId: 'column-2', direction: 'asc' }, 'column-2'))
      .toEqual({ columnId: 'column-2', direction: 'desc' });
    expect(toggleSort({ columnId: 'column-2', direction: 'desc' }, 'column-2')).toBeNull();
    expect(toggleSort({ columnId: 'column-1', direction: 'desc' }, 'column-2'))
      .toEqual({ columnId: 'column-2', direction: 'asc' });

    expect(queryWithFilter(query, { columnId: 'column-1', operator: 'equals', value: '001' }))
      .toMatchObject({ page: 1, filters: [{ columnId: 'column-1', operator: 'equals', value: '001' }] });
  });
});
