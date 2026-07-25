import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CsvQuery } from '@itharbors/csv-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CsvIndex } from '../main/src/csv-index.js';
import { CsvService } from '../main/src/csv-service.js';

const baseQuery: CsvQuery = {
  connectionRevision: 1,
  page: 1,
  pageSize: 25,
  search: '',
  filters: [],
  sort: null,
};

describe('CsvIndex queries and statistics', () => {
  let temporaryRoot: string;
  const indexes: CsvIndex[] = [];

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-query-test-'));
  });

  afterEach(async () => {
    await Promise.all(indexes.splice(0).map((index) => index.dispose()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('treats LIKE wildcards literally and combines case-insensitive filters', async () => {
    const index = await createIndex([
      ['001', 'Beta', 'a%_'],
      ['002', 'alpha', 'plain'],
      ['003', 'ALPHA', ''],
      ['004', 'slash', 'a\\b'],
    ]);

    expect(index.getRows({ ...baseQuery, search: 'a%_' }).total).toBe(1);
    expect(index.getRows({ ...baseQuery, search: 'A%_' }).rows).toEqual([{
      recordNumber: 1,
      values: ['001', 'Beta', 'a%_'],
    }]);
    expect(index.getRows({ ...baseQuery, search: 'a\\b' }).rows.map((row) => row.recordNumber))
      .toEqual([4]);
    expect(index.getRows({
      ...baseQuery,
      filters: [
        { columnId: 'column-2', operator: 'equals', value: 'ALPHA' },
        { columnId: 'column-3', operator: 'is-not-empty' },
      ],
    }).rows.map((row) => row.recordNumber)).toEqual([2]);
  });

  it('sorts text with NOCASE semantics and source-record tie-breaking', async () => {
    const index = await createIndex([
      ['001', 'Beta'],
      ['002', 'alpha'],
      ['003', 'ALPHA'],
    ]);

    expect(index.getRows({
      ...baseQuery,
      sort: { columnId: 'column-2', direction: 'asc' },
    }).rows.map((row) => row.recordNumber)).toEqual([2, 3, 1]);
    expect(index.getRows({ ...baseQuery }).rows[0]?.values[0]).toBe('001');
  });

  it('pages deterministically and calculates empty, non-empty, and length statistics', async () => {
    const index = await createIndex(Array.from(
      { length: 27 },
      (_, offset) => [`${offset + 1}`.padStart(3, '0'), offset === 0 ? '' : `value-${offset + 1}`],
    ));

    const result = index.getRows({ ...baseQuery, page: 2 });
    expect(result).toMatchObject({ page: 2, pageSize: 25, total: 27 });
    expect(result.rows.map((row) => row.recordNumber)).toEqual([26, 27]);
    expect(index.getColumnStats('column-2')).toEqual({
      columnId: 'column-2',
      emptyCount: 1,
      nonEmptyCount: 26,
      maxLength: 8,
    });
  });

  it('rejects unknown columns, invalid page sizes, malformed filters, and sort directions', async () => {
    const index = await createIndex([['a', 'b']]);

    expect(() => index.getRows({
      ...baseQuery,
      filters: [{ columnId: 'column-3', operator: 'equals', value: 'x' }],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_COLUMN' }));
    expect(() => index.getRows({
      ...baseQuery,
      pageSize: 10 as CsvQuery['pageSize'],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => index.getRows({
      ...baseQuery,
      page: 0,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => index.getRows({
      ...baseQuery,
      filters: [{ columnId: 'column-1', operator: 'contains' }],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => index.getRows({
      ...baseQuery,
      sort: { columnId: 'column-1', direction: 'sideways' as 'asc' },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => index.getColumnStats('column-99'))
      .toThrowError(expect.objectContaining({ code: 'INVALID_COLUMN' }));
  });

  it('filters, sorts, reconstructs, and calculates statistics across column partitions', async () => {
    const width = 2_001;
    const row = (first: string, last: string) => {
      const values = Array.from({ length: width }, () => '');
      values[0] = first;
      values[width - 1] = last;
      return values;
    };
    const index = await createIndex([
      row('record-1', 'Zulu'),
      row('record-2', 'alpha'),
      row('record-3', 'ALPHA'),
    ]);

    const result = index.getRows({
      ...baseQuery,
      filters: [{ columnId: `column-${width}`, operator: 'contains', value: 'PHA' }],
      sort: { columnId: `column-${width}`, direction: 'asc' },
    });
    expect(result.rows.map((entry) => entry.recordNumber)).toEqual([2, 3]);
    expect(result.rows[0]?.values).toHaveLength(width);
    expect(result.rows[0]?.values.at(-1)).toBe('alpha');
    expect(index.getRows({
      ...baseQuery,
      search: 'record-2',
    }).rows.map((entry) => entry.recordNumber)).toEqual([2]);
    expect(index.getColumnStats(`column-${width}`)).toEqual({
      columnId: `column-${width}`,
      emptyCount: 0,
      nonEmptyCount: 3,
      maxLength: 5,
    });
  });

  it('maps validated index results to the public service contract and rejects stale revisions', async () => {
    const source = path.join(temporaryRoot, 'service.csv');
    fs.writeFileSync(source, '编号,名称\n001,Beta\n002,alpha\n', 'utf8');
    const service = new CsvService({ temporaryRoot });
    try {
      const opened = await service.openFile({
        path: source,
        encoding: 'utf8',
        delimiter: ',',
        hasHeader: true,
      });
      const query = { ...baseQuery, connectionRevision: opened.connectionRevision };

      expect(service.getRows(query)).toEqual({
        connectionRevision: opened.connectionRevision,
        page: 1,
        pageSize: 25,
        totalRows: 2,
        rows: [
          { record: 1, values: ['001', 'Beta'] },
          { record: 2, values: ['002', 'alpha'] },
        ],
      });
      expect(service.getColumnStats({
        connectionRevision: opened.connectionRevision,
        columnId: 'column-1',
      })).toEqual({
        connectionRevision: opened.connectionRevision,
        columnId: 'column-1',
        emptyCount: 0,
        nonEmptyCount: 2,
        maxLength: 3,
      });
      expect(() => service.getRows({ ...query, connectionRevision: query.connectionRevision - 1 }))
        .toThrowError(expect.objectContaining({ code: 'STALE_CONNECTION' }));
    } finally {
      await service.dispose();
    }
  });

  async function createIndex(rows: string[][]): Promise<CsvIndex> {
    const index = CsvIndex.create(temporaryRoot, Date.now());
    indexes.push(index);
    const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
    index.initialize(width);
    fs.writeFileSync(
      index.spoolPath,
      rows.map((row) => JSON.stringify(row)).join('\n'),
      'utf8',
    );
    await index.importSpool(width, new AbortController().signal);
    return index;
  }
});
