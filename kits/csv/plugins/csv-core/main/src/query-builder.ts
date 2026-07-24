import type { CsvQuery } from '@itharbors/csv-contracts';
import { CsvCoreError, requireRecord } from './protocol.js';

const ALLOWED_PAGE_SIZES = new Set([25, 50, 100, 250]);
const SEARCH_COLUMNS_PER_PREDICATE = 400;

export type CsvIndexPartition = {
  table: string;
  startIndex: number;
  columnCount: number;
};

type ColumnLocation = {
  columnId: string;
  identifier: string;
  partition: CsvIndexPartition;
};

type ParsedFilter =
  | { columnId: string; operator: 'contains' | 'equals'; value: string }
  | { columnId: string; operator: 'is-empty' | 'is-not-empty' };

export type CompiledCsvQuery = {
  page: number;
  pageSize: CsvQuery['pageSize'];
  whereSql: string;
  orderSql: string;
  parameters: Record<string, string>;
};

export function compileCsvQuery(
  input: unknown,
  partitions: readonly CsvIndexPartition[],
): CompiledCsvQuery {
  const query = parseQuery(input);
  const columns = buildColumnMap(partitions);
  const predicates: string[] = [];
  const parameters: Record<string, string> = {};
  let aliasIndex = 0;

  if (query.search !== '') {
    parameters.search = `%${escapeLike(query.search)}%`;
    const locations = [...columns.values()];
    if (locations.length === 0) {
      predicates.push('0');
    } else {
      const searchPredicates: string[] = [];
      for (let start = 0; start < locations.length; start += SEARCH_COLUMNS_PER_PREDICATE) {
        const chunk = locations.slice(start, start + SEARCH_COLUMNS_PER_PREDICATE);
        const byPartition = groupLocations(chunk);
        for (const [partition, partitionColumns] of byPartition) {
          const alias = `search_${aliasIndex++}`;
          searchPredicates.push(buildExists(
            partition,
            alias,
            partitionColumns.map((column) => (
              `${qualified(alias, column.identifier)} COLLATE NOCASE LIKE @search ESCAPE '\\'`
            )).join(' OR '),
          ));
        }
      }
      predicates.push(`(${searchPredicates.join(' OR ')})`);
    }
  }

  query.filters.forEach((filter, index) => {
    const column = requireColumn(columns, filter.columnId);
    const alias = `filter_${aliasIndex++}`;
    let condition: string;
    if (filter.operator === 'contains') {
      const parameter = `filter_${index}`;
      parameters[parameter] = `%${escapeLike(filter.value)}%`;
      condition = `${qualified(alias, column.identifier)} COLLATE NOCASE LIKE @${parameter} ESCAPE '\\'`;
    } else if (filter.operator === 'equals') {
      const parameter = `filter_${index}`;
      parameters[parameter] = filter.value;
      condition = `${qualified(alias, column.identifier)} COLLATE NOCASE = @${parameter}`;
    } else if (filter.operator === 'is-empty') {
      condition = `${qualified(alias, column.identifier)} = ''`;
    } else {
      condition = `${qualified(alias, column.identifier)} <> ''`;
    }
    predicates.push(buildExists(column.partition, alias, condition));
  });

  let orderSql = `${qualified('base', 'record_number')} ASC`;
  if (query.sort !== null) {
    const column = requireColumn(columns, query.sort.columnId);
    const alias = `sort_${aliasIndex}`;
    orderSql = `(
      SELECT ${qualified(alias, column.identifier)}
      FROM ${quoteIdentifier(column.partition.table)} AS ${quoteIdentifier(alias)}
      WHERE ${qualified(alias, 'record_number')} = ${qualified('base', 'record_number')}
    ) COLLATE NOCASE ${query.sort.direction.toUpperCase()}, ${qualified('base', 'record_number')} ASC`;
  }

  return {
    page: query.page,
    pageSize: query.pageSize,
    whereSql: predicates.length === 0 ? '' : ` WHERE ${predicates.join(' AND ')}`,
    orderSql: ` ORDER BY ${orderSql}`,
    parameters,
  };
}

export function resolveColumn(
  columnId: unknown,
  partitions: readonly CsvIndexPartition[],
): ColumnLocation {
  if (typeof columnId !== 'string') {
    throw new CsvCoreError('INVALID_COLUMN', 'CSV 列标识无效。');
  }
  return requireColumn(buildColumnMap(partitions), columnId);
}

function parseQuery(input: unknown): {
  connectionRevision: number;
  page: number;
  pageSize: CsvQuery['pageSize'];
  search: string;
  filters: ParsedFilter[];
  sort: CsvQuery['sort'];
} {
  const record = requireRecord(input, 'CSV 查询参数无效。');
  if (!Number.isInteger(record.connectionRevision) || (record.connectionRevision as number) < 0) {
    throw new CsvCoreError('INVALID_INPUT', 'connectionRevision 必须是非负整数。');
  }
  if (!Number.isInteger(record.page) || (record.page as number) < 1) {
    throw new CsvCoreError('INVALID_INPUT', 'page 必须是正整数。');
  }
  if (!Number.isInteger(record.pageSize) || !ALLOWED_PAGE_SIZES.has(record.pageSize as number)) {
    throw new CsvCoreError('INVALID_INPUT', 'pageSize 必须是 25、50、100 或 250。');
  }
  if (typeof record.search !== 'string') {
    throw new CsvCoreError('INVALID_INPUT', 'search 必须是字符串。');
  }
  if (!Array.isArray(record.filters)) {
    throw new CsvCoreError('INVALID_INPUT', 'filters 必须是数组。');
  }
  const filters = record.filters.map((value, index): ParsedFilter => {
    const filter = requireRecord(value, `第 ${index + 1} 个筛选条件无效。`);
    if (typeof filter.columnId !== 'string') {
      throw new CsvCoreError('INVALID_COLUMN', `第 ${index + 1} 个筛选条件的列标识无效。`);
    }
    if (filter.operator === 'contains' || filter.operator === 'equals') {
      if (typeof filter.value !== 'string') {
        throw new CsvCoreError('INVALID_INPUT', `第 ${index + 1} 个筛选条件缺少字符串值。`);
      }
      return {
        columnId: filter.columnId,
        operator: filter.operator,
        value: filter.value,
      };
    }
    if (filter.operator === 'is-empty' || filter.operator === 'is-not-empty') {
      if (Object.hasOwn(filter, 'value')) {
        throw new CsvCoreError('INVALID_INPUT', `第 ${index + 1} 个空值筛选条件不能包含值。`);
      }
      return { columnId: filter.columnId, operator: filter.operator };
    }
    throw new CsvCoreError('INVALID_INPUT', `第 ${index + 1} 个筛选操作无效。`);
  });

  let sort: CsvQuery['sort'];
  if (record.sort === null) {
    sort = null;
  } else {
    const inputSort = requireRecord(record.sort, '排序参数无效。');
    if (typeof inputSort.columnId !== 'string') {
      throw new CsvCoreError('INVALID_COLUMN', '排序列标识无效。');
    }
    if (inputSort.direction !== 'asc' && inputSort.direction !== 'desc') {
      throw new CsvCoreError('INVALID_INPUT', '排序方向必须是 asc 或 desc。');
    }
    sort = { columnId: inputSort.columnId, direction: inputSort.direction };
  }

  const page = record.page as number;
  const pageSize = record.pageSize as CsvQuery['pageSize'];
  if (!Number.isSafeInteger((page - 1) * pageSize)) {
    throw new CsvCoreError('INVALID_INPUT', '分页偏移超出支持范围。');
  }
  return {
    connectionRevision: record.connectionRevision as number,
    page,
    pageSize,
    search: record.search,
    filters,
    sort,
  };
}

function buildColumnMap(
  partitions: readonly CsvIndexPartition[],
): Map<string, ColumnLocation> {
  const columns = new Map<string, ColumnLocation>();
  for (const partition of partitions) {
    for (let offset = 0; offset < partition.columnCount; offset += 1) {
      const index = partition.startIndex + offset + 1;
      const columnId = `column-${index}`;
      columns.set(columnId, {
        columnId,
        identifier: `c${index}`,
        partition,
      });
    }
  }
  return columns;
}

function requireColumn(
  columns: ReadonlyMap<string, ColumnLocation>,
  columnId: string,
): ColumnLocation {
  const column = columns.get(columnId);
  if (column === undefined) {
    throw new CsvCoreError('INVALID_COLUMN', `未知 CSV 列：${columnId}`);
  }
  return column;
}

function groupLocations(
  columns: readonly ColumnLocation[],
): Map<CsvIndexPartition, ColumnLocation[]> {
  const grouped = new Map<CsvIndexPartition, ColumnLocation[]>();
  for (const column of columns) {
    const group = grouped.get(column.partition);
    if (group === undefined) grouped.set(column.partition, [column]);
    else group.push(column);
  }
  return grouped;
}

function buildExists(partition: CsvIndexPartition, alias: string, condition: string): string {
  return `EXISTS (
    SELECT 1
    FROM ${quoteIdentifier(partition.table)} AS ${quoteIdentifier(alias)}
    WHERE ${qualified(alias, 'record_number')} = ${qualified('base', 'record_number')}
      AND (${condition})
  )`;
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualified(alias: string, identifier: string): string {
  return `${quoteIdentifier(alias)}.${quoteIdentifier(identifier)}`;
}
