import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import Database from 'better-sqlite3';
import type { CsvQuery } from '@itharbors/csv-contracts';
import { CsvCoreError } from './protocol.js';
import {
  compileCsvQuery,
  resolveColumn,
  type CsvIndexPartition,
} from './query-builder.js';

export const CSV_INDEX_MARKER = '.harbors-csv-index.json';
export const CSV_INDEX_OWNER = '@itharbors/csv-core';
export const CSV_INDEX_SCHEMA_VERSION = 1;
const INDEX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const INSERT_BATCH_SIZE = 500;
const ACTIVE_INDEX_DIRECTORIES = new Set<string>();

type CsvIndexMarker = {
  schemaVersion: number;
  owner: string;
  expiresAt: number;
  pid: number;
};

export type CsvIndexRow = {
  recordNumber: number;
  values: string[];
};

export type CsvIndexRowsResult = {
  page: number;
  pageSize: CsvQuery['pageSize'];
  total: number;
  rows: CsvIndexRow[];
};

export type CsvIndexColumnStats = {
  columnId: string;
  emptyCount: number;
  nonEmptyCount: number;
  maxLength: number;
};

export class CsvIndex {
  readonly directory: string;
  readonly databasePath: string;
  readonly spoolPath: string;
  private database: Database.Database | null;
  private partitions: CsvIndexPartition[] = [];

  private constructor(directory: string, database: Database.Database) {
    this.directory = directory;
    this.databasePath = path.join(directory, 'index.sqlite');
    this.spoolPath = path.join(directory, 'rows.ndjson');
    this.database = database;
  }

  static create(temporaryRoot: string, now: number): CsvIndex {
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'harbors-csv-'));
    let database: Database.Database | null = null;
    try {
      const marker: CsvIndexMarker = {
        schemaVersion: CSV_INDEX_SCHEMA_VERSION,
        owner: CSV_INDEX_OWNER,
        expiresAt: now + INDEX_LIFETIME_MS,
        pid: process.pid,
      };
      fs.writeFileSync(path.join(directory, CSV_INDEX_MARKER), JSON.stringify(marker), {
        encoding: 'utf8',
        flag: 'wx',
      });
      const databasePath = path.join(directory, 'index.sqlite');
      database = new Database(databasePath);
      database.pragma('journal_mode = WAL');
      database.pragma('synchronous = NORMAL');
      ACTIVE_INDEX_DIRECTORIES.add(directory);
      return new CsvIndex(directory, database);
    } catch (error) {
      try {
        database?.close();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  static cleanupExpired(temporaryRoot: string, now: number): void {
    let names: string[];
    try {
      names = fs.readdirSync(temporaryRoot);
    } catch (error) {
      if (isMissingPath(error)) return;
      throw error;
    }
    for (const name of names) {
      if (!name.startsWith('harbors-csv-')) continue;
      const directory = path.join(temporaryRoot, name);
      if (ACTIVE_INDEX_DIRECTORIES.has(directory)) continue;
      try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const marker = JSON.parse(
          fs.readFileSync(path.join(directory, CSV_INDEX_MARKER), 'utf8'),
        ) as unknown;
        if (!isOwnedExpiredMarker(marker, now)) continue;
        if (isMarkerOwnerAlive(marker.pid)) continue;
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        // Unknown, malformed, and inaccessible directories are never owned by this cleanup pass.
      }
    }
  }

  initialize(columnCount: number): void {
    const database = this.requireDatabase();
    const maximumColumnsPerTable = sqliteMaximumColumns(database) - 1;
    this.partitions = columnCount === 0
      ? [{ table: 'rows', startIndex: 0, columnCount: 0 }]
      : Array.from(
        { length: Math.ceil(columnCount / maximumColumnsPerTable) },
        (_, partitionIndex): CsvIndexPartition => ({
          table: partitionIndex === 0 ? 'rows' : `rows_${partitionIndex + 1}`,
          startIndex: partitionIndex * maximumColumnsPerTable,
          columnCount: Math.min(
            maximumColumnsPerTable,
            columnCount - (partitionIndex * maximumColumnsPerTable),
          ),
        }),
      );
    for (const partition of this.partitions) {
      const columns = Array.from(
        { length: partition.columnCount },
        (_, offset) => `c${partition.startIndex + offset + 1} TEXT NOT NULL`,
      );
      database.exec(
        `CREATE TABLE ${partition.table} (record_number INTEGER PRIMARY KEY${columns.length === 0 ? '' : `, ${columns.join(', ')}`})`,
      );
    }
  }

  async importSpool(
    columnCount: number,
    signal: AbortSignal,
    onBatch?: (insertedRows: number) => void,
  ): Promise<number> {
    const database = this.requireDatabase();
    if (this.partitions.length === 0) {
      throw new CsvCoreError('INDEX_NOT_INITIALIZED', 'CSV 临时索引尚未初始化。');
    }
    if (this.partitions.reduce((sum, partition) => sum + partition.columnCount, 0) !== columnCount) {
      throw new CsvCoreError('INDEX_SCHEMA_MISMATCH', 'CSV 临时索引列数不匹配。');
    }
    const inserts = this.partitions.map((partition) => {
      const names = Array.from(
        { length: partition.columnCount },
        (_, offset) => `c${partition.startIndex + offset + 1}`,
      );
      const placeholders = Array.from(
        { length: partition.columnCount + 1 },
        () => '?',
      ).join(', ');
      return {
        partition,
        statement: database.prepare(
          `INSERT INTO ${partition.table} (record_number${names.length === 0 ? '' : `, ${names.join(', ')}`}) VALUES (${placeholders})`,
        ),
      };
    });
    const insertBatch = database.transaction((batch: string[][], startingRecord: number) => {
      for (let offset = 0; offset < batch.length; offset += 1) {
        const values = batch[offset];
        for (const { partition, statement } of inserts) {
          const normalized = Array.from(
            { length: partition.columnCount },
            (_, columnOffset) => values[partition.startIndex + columnOffset] ?? '',
          );
          statement.run(startingRecord + offset, ...normalized);
        }
      }
    });

    const input = createReadStream(this.spoolPath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let batch: string[][] = [];
    let insertedRows = 0;
    try {
      for await (const line of lines) {
        assertNotAborted(signal);
        if (line === '') continue;
        batch.push(JSON.parse(line) as string[]);
        if (batch.length < INSERT_BATCH_SIZE) continue;
        insertBatch(batch, insertedRows + 1);
        insertedRows += batch.length;
        batch = [];
        onBatch?.(insertedRows);
        await yieldToEventLoop();
      }
      assertNotAborted(signal);
      if (batch.length > 0) {
        insertBatch(batch, insertedRows + 1);
        insertedRows += batch.length;
        onBatch?.(insertedRows);
      }
      return insertedRows;
    } finally {
      lines.close();
      input.destroy();
    }
  }

  async removeSpool(): Promise<void> {
    await fsp.rm(this.spoolPath, { force: true });
  }

  validateQuery(query: CsvQuery): void {
    compileCsvQuery(query, this.partitions);
  }

  getRows(query: CsvQuery, knownTotal?: number): CsvIndexRowsResult {
    const database = this.requireDatabase();
    const compiled = compileCsvQuery(query, this.partitions);
    const baseTable = this.partitions[0];
    if (baseTable === undefined) {
      throw new CsvCoreError('INDEX_NOT_INITIALIZED', 'CSV 临时索引尚未初始化。');
    }
    const baseFrom = `${quoteIdentifier(baseTable.table)} AS "base"`;
    const countValue = knownTotal === undefined
      ? database.prepare(
        `SELECT COUNT(*) AS total FROM ${baseFrom}${compiled.whereSql}`,
      ).get(compiled.parameters) as { total: number | bigint }
      : { total: knownTotal };
    const total = Number(countValue.total);
    if (!Number.isSafeInteger(total)) {
      throw new CsvCoreError('RESULT_TOO_LARGE', 'CSV 查询结果数量超出支持范围。');
    }
    const offset = (compiled.page - 1) * compiled.pageSize;
    const selected = database.prepare(
      `SELECT "base"."record_number" AS recordNumber
       FROM ${baseFrom}${compiled.whereSql}${compiled.orderSql}
       LIMIT @limit OFFSET @offset`,
    ).all({
      ...compiled.parameters,
      limit: compiled.pageSize,
      offset,
    }) as Array<{ recordNumber: number }>;
    const recordNumbers = selected.map((row) => row.recordNumber);
    const valuesByRecord = new Map<number, string[]>(
      recordNumbers.map((recordNumber) => [
        recordNumber,
        Array.from({ length: this.columnCount() }, () => ''),
      ]),
    );

    if (recordNumbers.length > 0) {
      const placeholders = recordNumbers.map(() => '?').join(', ');
      for (const partition of this.partitions) {
        const identifiers = Array.from(
          { length: partition.columnCount },
          (_, offsetInPartition) => `c${partition.startIndex + offsetInPartition + 1}`,
        );
        const projection = ['record_number', ...identifiers].map(quoteIdentifier).join(', ');
        const records = database.prepare(
          `SELECT ${projection}
           FROM ${quoteIdentifier(partition.table)}
           WHERE "record_number" IN (${placeholders})`,
        ).all(...recordNumbers) as Array<Record<string, number | string>>;
        for (const record of records) {
          const values = valuesByRecord.get(record.record_number as number);
          if (values === undefined) continue;
          identifiers.forEach((identifier, offsetInPartition) => {
            values[partition.startIndex + offsetInPartition] = record[identifier] as string;
          });
        }
      }
    }

    return {
      page: compiled.page,
      pageSize: compiled.pageSize,
      total,
      rows: recordNumbers.map((recordNumber) => ({
        recordNumber,
        values: valuesByRecord.get(recordNumber) ?? [],
      })),
    };
  }

  getColumnStats(columnId: string): CsvIndexColumnStats {
    const database = this.requireDatabase();
    const column = resolveColumn(columnId, this.partitions);
    const identifier = quoteIdentifier(column.identifier);
    const values = database.prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN ${identifier} = '' THEN 1 ELSE 0 END), 0) AS emptyCount,
        COALESCE(SUM(CASE WHEN ${identifier} <> '' THEN 1 ELSE 0 END), 0) AS nonEmptyCount,
        COALESCE(MAX(LENGTH(${identifier})), 0) AS maxLength
       FROM ${quoteIdentifier(column.partition.table)}`,
    ).get() as {
      emptyCount: number | bigint;
      nonEmptyCount: number | bigint;
      maxLength: number | bigint;
    };
    return {
      columnId: column.columnId,
      emptyCount: toSafeCount(values.emptyCount),
      nonEmptyCount: toSafeCount(values.nonEmptyCount),
      maxLength: toSafeCount(values.maxLength),
    };
  }

  async dispose(): Promise<void> {
    const database = this.database;
    this.database = null;
    try {
      if (database !== null) {
        database.close();
      }
    } finally {
      try {
        await fsp.rm(this.directory, { recursive: true, force: true });
      } finally {
        ACTIVE_INDEX_DIRECTORIES.delete(this.directory);
      }
    }
  }

  private requireDatabase(): Database.Database {
    if (this.database === null) {
      throw new CsvCoreError('INDEX_CLOSED', 'CSV 临时索引已经关闭。');
    }
    return this.database;
  }

  private columnCount(): number {
    return this.partitions.reduce((total, partition) => total + partition.columnCount, 0);
  }
}

function isOwnedExpiredMarker(value: unknown, now: number): value is CsvIndexMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return marker.schemaVersion === CSV_INDEX_SCHEMA_VERSION
    && marker.owner === CSV_INDEX_OWNER
    && typeof marker.expiresAt === 'number'
    && Number.isFinite(marker.expiresAt)
    && marker.expiresAt <= now
    && typeof marker.pid === 'number'
    && Number.isSafeInteger(marker.pid)
    && marker.pid > 0;
}

function isMarkerOwnerAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, 'ESRCH');
  }
}

function sqliteMaximumColumns(database: Database.Database): number {
  const options = database.pragma('compile_options', { simple: false }) as Array<{
    compile_options?: unknown;
  }>;
  const option = options
    .map((row) => (row as { compile_options?: unknown }).compile_options)
    .find((value) => typeof value === 'string' && value.startsWith('MAX_COLUMN='));
  const parsed = typeof option === 'string' ? Number(option.slice('MAX_COLUMN='.length)) : NaN;
  return Number.isInteger(parsed) && parsed >= 2 ? parsed : 2_000;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CsvCoreError('OPEN_CANCELLED', '已取消打开 CSV 文件。');
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function toSafeCount(value: number | bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new CsvCoreError('RESULT_TOO_LARGE', 'CSV 统计结果超出支持范围。');
  }
  return converted;
}
