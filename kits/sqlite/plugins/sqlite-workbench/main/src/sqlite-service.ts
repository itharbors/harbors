import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  deserializeEditableValue,
  isRecord,
  parsePageInput,
  quoteIdentifier,
  serializeValue,
  type DatabaseValue,
  type SerializedValue,
} from './protocol.js';

export type ConnectionState = {
  connected: boolean;
  path: string | null;
  sqliteVersion: string | null;
};

export type SchemaObject = {
  name: string;
  type: 'table' | 'view';
  writable: boolean;
  sql: string;
};

export type ColumnSchema = {
  name: string;
  type: string;
  notNull: boolean;
  primaryKeyOrder: number;
  defaultValue: string | null;
  hidden: boolean;
  generated: boolean;
};

export type IndexSchema = {
  name: string;
  unique: boolean;
  origin: string;
  partial: boolean;
  columns: string[];
};

export type ObjectSchema = SchemaObject & {
  columns: ColumnSchema[];
  primaryKey: string[];
  indexes: IndexSchema[];
  hasRowid: boolean;
};

export type RowIdentity =
  | { kind: 'primary-key'; values: Record<string, SerializedValue> }
  | { kind: 'rowid'; value: SerializedValue };

export type RowRecord = {
  values: SerializedValue[];
  identity: RowIdentity | null;
};

export type RowsResult = {
  name: string;
  page: number;
  pageSize: number;
  total: number;
  writable: boolean;
  columns: string[];
  rows: RowRecord[];
};

export type SqlRowsResult = {
  kind: 'rows';
  columns: string[];
  rows: SerializedValue[][];
  truncated: boolean;
  elapsedMs: number;
};

export type SqlMutationResult = {
  kind: 'mutation';
  changes: number;
  lastInsertRowid: SerializedValue;
  elapsedMs: number;
};

export type SqlExecutionResult = SqlRowsResult | SqlMutationResult;

type SchemaRow = {
  name: string;
  type: 'table' | 'view';
  sql: string | null;
};

type TableInfoRow = {
  name: string;
  type: string | null;
  notnull: number | bigint;
  dflt_value: string | null;
  pk: number | bigint;
  hidden: number | bigint;
};

type IndexListRow = {
  name: string;
  unique: number | bigint;
  origin: string;
  partial: number | bigint;
};

type IndexInfoRow = {
  name: string | null;
};

export class SqliteService {
  private database: Database.Database | null = null;
  private databasePath: string | null = null;
  private sqliteVersion: string | null = null;

  getConnectionState(): ConnectionState {
    return {
      connected: this.database !== null,
      path: this.databasePath,
      sqliteVersion: this.sqliteVersion,
    };
  }

  openDatabase(input: unknown): ConnectionState {
    if (!isRecord(input)) {
      throw workbenchError('INVALID_INPUT', 'openDatabase input must be an object');
    }
    const requestedPath = requireNonEmptyString(input.path, 'path');
    if (typeof input.create !== 'boolean') {
      throw workbenchError('INVALID_INPUT', 'create must be a boolean');
    }

    const absolutePath = path.resolve(requestedPath);
    const exists = fs.existsSync(absolutePath);
    if (input.create) {
      if (exists) {
        throw workbenchError('PATH_EXISTS', `Database already exists: ${absolutePath}`);
      }
      const parent = path.dirname(absolutePath);
      if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
        throw workbenchError('INVALID_PATH', `Parent directory does not exist: ${parent}`);
      }
    } else {
      if (!exists) {
        throw workbenchError('INVALID_PATH', `Database file does not exist: ${absolutePath}`);
      }
      if (!fs.statSync(absolutePath).isFile()) {
        throw workbenchError('INVALID_PATH', `Database path is not a file: ${absolutePath}`);
      }
    }

    let candidate: Database.Database | null = null;
    try {
      candidate = new Database(absolutePath);
      candidate.defaultSafeIntegers(true);
      candidate.pragma('schema_version', { simple: true });
      candidate.pragma('foreign_keys = ON');
      candidate.pragma('busy_timeout = 5000');
      const versionRow = candidate.prepare('SELECT sqlite_version() AS version').get() as {
        version: string;
      };

      const previous = this.database;
      this.database = candidate;
      this.databasePath = absolutePath;
      this.sqliteVersion = versionRow.version;
      candidate = null;
      previous?.close();
      return this.getConnectionState();
    } catch (error) {
      candidate?.close();
      if (input.create) fs.rmSync(absolutePath, { force: true });
      throw normalizeSqliteError(error);
    }
  }

  closeDatabase(): ConnectionState {
    const database = this.database;
    this.database = null;
    this.databasePath = null;
    this.sqliteVersion = null;
    database?.close();
    return this.getConnectionState();
  }

  dispose(): void {
    this.closeDatabase();
  }

  getSchema(): { objects: SchemaObject[] } {
    const database = this.requireDatabase();
    const rows = database.prepare(`
      SELECT name, type, sql
      FROM sqlite_schema
      WHERE type IN ('table', 'view')
        AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
      ORDER BY name COLLATE NOCASE, name
    `).all() as SchemaRow[];

    return {
      objects: rows.map((row) => ({
        name: row.name,
        type: row.type,
        writable: row.type === 'table',
        sql: row.sql ?? '',
      })),
    };
  }

  getObjectSchema(input: unknown): ObjectSchema {
    if (!isRecord(input)) {
      throw workbenchError('INVALID_INPUT', 'getObjectSchema input must be an object');
    }
    const name = requireNonEmptyString(input.name, 'name');
    const database = this.requireDatabase();
    try {
      const object = this.findSchemaObject(name);
      const tableInfo = database
        .prepare(`PRAGMA table_xinfo(${quoteIdentifier(name)})`)
        .all() as TableInfoRow[];

      const columns = tableInfo.map((row) => {
        const hiddenValue = Number(row.hidden);
        return {
          name: row.name,
          type: row.type ?? '',
          notNull: Number(row.notnull) !== 0,
          primaryKeyOrder: Number(row.pk),
          defaultValue: row.dflt_value,
          hidden: hiddenValue !== 0,
          generated: hiddenValue === 2 || hiddenValue === 3,
        };
      });
      const primaryKey = [...columns]
        .filter((column) => column.primaryKeyOrder > 0)
        .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder)
        .map((column) => column.name);
      const indexes = object.type === 'table'
        ? this.readIndexes(database, name)
        : [];

      return {
        ...object,
        columns,
        primaryKey,
        indexes,
        hasRowid: object.type === 'table' && !/\bWITHOUT\s+ROWID\b/i.test(object.sql),
      };
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  getRows(input: unknown): RowsResult {
    if (!isRecord(input)) {
      throw workbenchError('INVALID_INPUT', 'getRows input must be an object');
    }
    const name = requireNonEmptyString(input.name, 'name');
    const { page, pageSize, offset } = parsePageInput(input);
    const database = this.requireDatabase();
    const schema = this.getObjectSchema({ name });
    const displayColumns = schema.columns
      .filter((column) => !column.hidden || column.generated)
      .map((column) => column.name);
    const totalValue = database
      .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`)
      .pluck()
      .get() as number | bigint;
    const total = Number(totalValue);
    if (!Number.isSafeInteger(total)) {
      throw workbenchError('RESULT_TOO_LARGE', `Row count exceeds the supported range: ${totalValue}`);
    }

    const rowidAlias = schema.type === 'table' && schema.primaryKey.length === 0 && schema.hasRowid
      ? chooseRowidAlias(schema.columns.map((column) => column.name))
      : null;
    const projection = rowidAlias
      ? `rowid AS ${quoteIdentifier(rowidAlias)}, *`
      : '*';
    const records = database
      .prepare(`SELECT ${projection} FROM ${quoteIdentifier(name)} LIMIT ? OFFSET ?`)
      .all(BigInt(pageSize), BigInt(offset)) as Record<string, unknown>[];

    return {
      name,
      page,
      pageSize,
      total,
      writable: schema.writable,
      columns: displayColumns,
      rows: records.map((record) => ({
        values: displayColumns.map((column) => serializeValue(record[column])),
        identity: createRowIdentity(schema, record, rowidAlias),
      })),
    };
  }

  insertRow(input: unknown): { changes: number; lastInsertRowid: SerializedValue } {
    const { name, schema, values } = this.parseWriteInput(input, 'insertRow');
    const columns = Object.keys(values);
    const databaseValues = columns.map((column) => this.parseColumnValue(schema, column, values[column]));
    const sql = columns.length === 0
      ? `INSERT INTO ${quoteIdentifier(name)} DEFAULT VALUES`
      : `INSERT INTO ${quoteIdentifier(name)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    const database = this.requireDatabase();

    try {
      return database.transaction(() => {
        const result = database.prepare(sql).run(...databaseValues);
        return {
          changes: result.changes,
          lastInsertRowid: serializeValue(result.lastInsertRowid),
        };
      })();
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  updateRow(input: unknown): { changes: number } {
    const { name, schema, values, record } = this.parseWriteInput(input, 'updateRow');
    const columns = Object.keys(values);
    if (columns.length === 0) {
      throw workbenchError('INVALID_INPUT', 'updateRow requires at least one value');
    }
    const databaseValues = columns.map((column) => this.parseColumnValue(schema, column, values[column]));
    const identity = buildIdentityWhere(schema, record.identity);
    const sql = `UPDATE ${quoteIdentifier(name)} SET ${columns
      .map((column) => `${quoteIdentifier(column)} = ?`)
      .join(', ')} WHERE ${identity.sql}`;
    return this.runSingleRowMutation(sql, [...databaseValues, ...identity.params]);
  }

  deleteRow(input: unknown): { changes: number } {
    const { name, schema, record } = this.parseWriteInput(input, 'deleteRow', false);
    const identity = buildIdentityWhere(schema, record.identity);
    const sql = `DELETE FROM ${quoteIdentifier(name)} WHERE ${identity.sql}`;
    return this.runSingleRowMutation(sql, identity.params);
  }

  executeSql(input: unknown): SqlExecutionResult {
    if (!isRecord(input)) {
      throw workbenchError('INVALID_INPUT', 'executeSql input must be an object');
    }
    const sql = requireNonEmptyString(input.sql, 'SQL');
    const database = this.requireDatabase();
    const startedAt = performance.now();

    try {
      const statement = database.prepare(sql);
      if (statement.reader) {
        const columns = statement.columns().map((column) => column.name);
        const collected: SerializedValue[][] = [];
        for (const row of statement.raw(true).iterate() as Iterable<unknown[]>) {
          collected.push(row.map(serializeValue));
          if (collected.length === 501) break;
        }
        const truncated = collected.length > 500;
        return {
          kind: 'rows',
          columns,
          rows: truncated ? collected.slice(0, 500) : collected,
          truncated,
          elapsedMs: elapsedSince(startedAt),
        };
      }

      const result = statement.run();
      return {
        kind: 'mutation',
        changes: result.changes,
        lastInsertRowid: serializeValue(result.lastInsertRowid),
        elapsedMs: elapsedSince(startedAt),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/more than one statement/i.test(message)) {
        throw workbenchError('MULTIPLE_STATEMENTS', 'Execute one SQL statement at a time');
      }
      throw normalizeSqliteError(error);
    }
  }

  private findSchemaObject(name: string): SchemaObject {
    const object = this.getSchema().objects.find((item) => item.name === name);
    if (!object) {
      throw workbenchError('OBJECT_NOT_FOUND', `Database object does not exist: ${name}`);
    }
    return object;
  }

  private parseWriteInput(
    input: unknown,
    operation: string,
    requireValues = true,
  ): {
    name: string;
    schema: ObjectSchema;
    values: Record<string, unknown>;
    record: Record<string, unknown>;
  } {
    if (!isRecord(input)) {
      throw workbenchError('INVALID_INPUT', `${operation} input must be an object`);
    }
    const name = requireNonEmptyString(input.name, 'name');
    const schema = this.getObjectSchema({ name });
    if (!schema.writable) {
      throw workbenchError('READ_ONLY', `Database object is read-only: ${name}`);
    }
    const values = isRecord(input.values) ? input.values : {};
    if (requireValues && !isRecord(input.values)) {
      throw workbenchError('INVALID_INPUT', `${operation} values must be an object`);
    }
    return { name, schema, values, record: input };
  }

  private parseColumnValue(schema: ObjectSchema, name: string, value: unknown): DatabaseValue {
    const column = schema.columns.find((item) => item.name === name);
    if (!column || column.hidden || column.generated) {
      throw workbenchError('INVALID_COLUMN', `Column is not editable: ${name}`);
    }
    if (/\bBLOB\b/i.test(column.type)) {
      throw workbenchError('READ_ONLY_TYPE', `BLOB column is preview-only: ${name}`);
    }
    try {
      return deserializeEditableValue(value);
    } catch (error) {
      throw workbenchError(
        'INVALID_VALUE',
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private runSingleRowMutation(sql: string, params: DatabaseValue[]): { changes: number } {
    const database = this.requireDatabase();
    try {
      return database.transaction(() => {
        const result = database.prepare(sql).run(...params);
        if (result.changes !== 1) {
          throw workbenchError('STALE_ROW', 'The row changed or no longer exists');
        }
        return { changes: result.changes };
      })();
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  private readIndexes(database: Database.Database, tableName: string): IndexSchema[] {
    const rows = database
      .prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`)
      .all() as IndexListRow[];
    return rows.map((row) => {
      const columns = database
        .prepare(`PRAGMA index_info(${quoteIdentifier(row.name)})`)
        .all() as IndexInfoRow[];
      return {
        name: row.name,
        unique: Number(row.unique) !== 0,
        origin: row.origin,
        partial: Number(row.partial) !== 0,
        columns: columns.flatMap((column) => column.name === null ? [] : [column.name]),
      };
    });
  }

  private requireDatabase(): Database.Database {
    if (!this.database) {
      throw workbenchError('NOT_CONNECTED', 'No SQLite database is connected');
    }
    return this.database;
  }
}

export function workbenchError(code: string, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

export function normalizeSqliteError(error: unknown): Error {
  if (error instanceof Error && /^\[[A-Z_]+\]/.test(error.message)) return error;
  const code = isRecord(error) && typeof error.code === 'string'
    ? error.code
    : 'SQLITE_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  return workbenchError(code, message);
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw workbenchError('INVALID_INPUT', `${name} must be a non-empty string`);
  }
  return value.trim();
}

function chooseRowidAlias(columnNames: string[]): string {
  const names = new Set(columnNames);
  let alias = '__ce_rowid__';
  while (names.has(alias)) alias = `_${alias}`;
  return alias;
}

function createRowIdentity(
  schema: ObjectSchema,
  record: Record<string, unknown>,
  rowidAlias: string | null,
): RowIdentity | null {
  if (!schema.writable) return null;
  if (schema.primaryKey.length > 0) {
    return {
      kind: 'primary-key',
      values: Object.fromEntries(
        schema.primaryKey.map((name) => [name, serializeValue(record[name])]),
      ),
    };
  }
  if (rowidAlias) {
    return { kind: 'rowid', value: serializeValue(record[rowidAlias]) };
  }
  return null;
}

function buildIdentityWhere(
  schema: ObjectSchema,
  identity: unknown,
): { sql: string; params: DatabaseValue[] } {
  if (!isRecord(identity) || typeof identity.kind !== 'string') {
    throw workbenchError('INVALID_IDENTITY', 'The row does not have a writable identity');
  }
  if (identity.kind === 'primary-key') {
    if (!isRecord(identity.values) || schema.primaryKey.length === 0) {
      throw workbenchError('INVALID_IDENTITY', 'Primary-key identity is invalid');
    }
    const identityValues = identity.values;
    return {
      sql: schema.primaryKey.map((name) => `${quoteIdentifier(name)} IS ?`).join(' AND '),
      params: schema.primaryKey.map((name) => {
        if (!(name in identityValues)) {
          throw workbenchError('INVALID_IDENTITY', `Primary-key identity is missing ${name}`);
        }
        return deserializeIdentityValue(identityValues[name]);
      }),
    };
  }
  if (identity.kind === 'rowid' && schema.hasRowid) {
    return {
      sql: 'rowid IS ?',
      params: [deserializeIdentityValue(identity.value)],
    };
  }
  throw workbenchError('INVALID_IDENTITY', 'The identity does not match this table');
}

function deserializeIdentityValue(value: unknown): DatabaseValue {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (isRecord(value) && value.type === 'integer' && typeof value.value === 'string') {
    if (!/^[+-]?\d+$/.test(value.value)) {
      throw workbenchError('INVALID_IDENTITY', 'Integer identity is malformed');
    }
    return BigInt(value.value);
  }
  throw workbenchError('INVALID_IDENTITY', 'Identity contains an unsupported value');
}

function elapsedSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
