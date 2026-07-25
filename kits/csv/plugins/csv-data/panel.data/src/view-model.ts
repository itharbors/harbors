import type { CsvFilter, CsvQuery } from '@itharbors/csv-contracts';

const PAGE_SIZES: ReadonlySet<number> = new Set([25, 50, 100, 250]);

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

export function formatCellPreview(value: string): string {
  if (value === '') {
    return '<span class="empty-cell" aria-label="空字符串">空</span>';
  }
  return escapeHtml(value);
}

export function normalizeQuery(query: CsvQuery): CsvQuery {
  const pageSize = PAGE_SIZES.has(query.pageSize) ? query.pageSize : 50;
  return {
    connectionRevision: query.connectionRevision,
    page: Number.isInteger(query.page) && query.page > 0 ? query.page : 1,
    pageSize,
    search: query.search,
    filters: query.filters.map(normalizeFilter),
    sort: query.sort ? { ...query.sort } : null,
  };
}

export function toggleSort(
  current: CsvQuery['sort'],
  columnId: string,
): CsvQuery['sort'] {
  if (current?.columnId !== columnId) return { columnId, direction: 'asc' };
  if (current.direction === 'asc') return { columnId, direction: 'desc' };
  return null;
}

export function queryWithFilter(query: CsvQuery, filter: CsvFilter): CsvQuery {
  return normalizeQuery({
    ...query,
    page: 1,
    filters: [...query.filters, normalizeFilter(filter)],
  });
}

function normalizeFilter(filter: CsvFilter): CsvFilter {
  if (filter.operator === 'is-empty' || filter.operator === 'is-not-empty') {
    return { columnId: filter.columnId, operator: filter.operator };
  }
  return { columnId: filter.columnId, operator: filter.operator, value: filter.value ?? '' };
}
