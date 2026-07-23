import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import { listDirectory, validateCreateTarget, type DirectoryListing } from './file-browser.js';
import { analyzeSqlText, type SqlTextAnalysis } from './sql-analysis.js';
import { SqlWorker } from './sql-worker.js';
import {
  deserializeEditableValue,
  isRecord,
  parseConnectionMode,
  parseExportRequest,
  parseRowQuery,
  quoteIdentifier,
  serializeValue,
  WorkbenchError,
  type ConnectionMode,
  type DatabaseValue,
  type ExportFormat,
  type FilterInput,
  type ObjectKind,
  type SerializedValue,
  type SortInput,
} from './protocol.js';

export type ConnectionState = {
  connected: boolean;
  path: string | null;
  fileIdentity: string | null;
  fileName: string | null;
  mode: ConnectionMode | null;
  sqliteVersion: string | null;
  foreignKeys: boolean | null;
  busyTimeout: number | null;
};

export type SchemaObject = {
  name: string;
  kind: ObjectKind;
  type: 'table' | 'view';
  writable: boolean;
  readOnlyReason: string | null;
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
  foreignKeys: ForeignKeySchema[];
  triggers: TriggerSchema[];
  hasRowid: boolean;
};

export type ForeignKeySchema = {
  id: number;
  sequence: number;
  table: string;
  from: string;
  to: string | null;
  onUpdate: string;
  onDelete: string;
  match: string;
};

export type RelationshipColumn = {
  name: string;
  type: string;
  primaryKeyOrder: number;
  foreignKey: boolean;
};

export type RelationshipTable = {
  name: string;
  kind: 'table' | 'virtual';
  columns: RelationshipColumn[];
};

export type Relationship = {
  id: string;
  fromTable: string;
  toTable: string;
  columns: Array<{ from: string; to: string | null }>;
  onUpdate: string;
  onDelete: string;
};

export type RelationshipGraph = {
  tables: RelationshipTable[];
  relationships: Relationship[];
};

export type TriggerSchema = {
  name: string;
  sql: string;
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

export type ExportRowsResult = {
  format: ExportFormat;
  fileName: string;
  mimeType: string;
  content: string;
  rows: number;
  truncated: boolean;
  warning: string | null;
};

export type SqlRowsResult = {
  kind: 'rows';
  columns: string[];
  rows: SerializedValue[][];
  truncated: boolean;
  page: number;
  elapsedMs: number;
};

export type SqlMutationResult = {
  kind: 'mutation';
  changes: number;
  lastInsertRowid: SerializedValue;
  elapsedMs: number;
};

export type SqlExecutionResult = SqlRowsResult | SqlMutationResult;

export type MutationReceipt = {
  changes: number;
  undoToken: string;
  undoExpiresAt: string;
  identity: RowIdentity;
};

type MutationOperation = 'insert' | 'update' | 'delete';

type MutationSnapshot = {
  token: string;
  expiresAt: number;
  databaseGeneration: number;
  operation: MutationOperation;
  objectName: string;
  identity: RowIdentity;
  afterFingerprint: string | null;
  beforeValues: Record<string, unknown> | null;
  columns: string[];
};

type SqliteServiceOptions = {
  now?: () => number;
  createToken?: () => string;
};

type SqlConfirmation = {
  token: string;
  sql: string;
  databaseGeneration: number;
  expiresAt: number;
};

export type SqlAnalysis = SqlTextAnalysis & {
  confirmationToken: string | null;
};

type SchemaSqlRow = {
  name: string;
  sql: string | null;
};

type SchemaOwnerRow = {
  name: string;
  tbl_name: string;
};

type TableListRow = {
  schema: string;
  name: string;
  type: ObjectKind;
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

type ForeignKeyRow = {
  id: number | bigint;
  seq: number | bigint;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
  match: string;
};

type TriggerRow = {
  name: string;
  sql: string | null;
};

type BuiltRowQuery = {
  whereSql: string;
  orderSql: string;
  parameters: DatabaseValue[];
  rowidSource: string | null;
};

type FileIdentity = {
  device: number;
  inode: number;
};

type RelationshipTableMetadata = {
  name: string;
  kind: 'table' | 'virtual';
  columns: ColumnSchema[];
  foreignKeys: ForeignKeySchema[];
};

export class SqliteService {
  private database: Database.Database | null = null;
  private databasePath: string | null = null;
  private fileIdentity: string | null = null;
  private connectionMode: ConnectionMode | null = null;
  private sqliteVersion: string | null = null;
  private foreignKeys: boolean | null = null;
  private busyTimeout: number | null = null;
  private recentDatabasePaths: string[] = [];
  private databaseGeneration = 0;
  private countCache = new Map<string, number>();
  private lastMutation: MutationSnapshot | null = null;
  private readonly now: () => number;
  private readonly createToken: () => string;
  private readonly sqlWorker = new SqlWorker();
  private sqlConfirmation: SqlConfirmation | null = null;

  constructor(options: SqliteServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createToken = options.createToken ?? randomUUID;
  }

  listDirectory(input: unknown): DirectoryListing {
    return listDirectory(input);
  }

  getDefaultDirectory(): string {
    return homedir();
  }

  getRecentDatabases(): string[] {
    return [...this.recentDatabasePaths];
  }

  getConnectionState(): ConnectionState {
    return {
      connected: this.database !== null,
      path: this.databasePath,
      fileIdentity: this.fileIdentity,
      fileName: this.databasePath === null ? null : path.basename(this.databasePath),
      mode: this.connectionMode,
      sqliteVersion: this.sqliteVersion,
      foreignKeys: this.foreignKeys,
      busyTimeout: this.busyTimeout,
    };
  }

  openDatabase(input: unknown): ConnectionState {
    this.assertNoActiveSql();
    if (!isRecord(input)) {
      throw workbenchError('INVALID_INPUT', 'openDatabase input must be an object');
    }
    const requestedPath = requireNonEmptyString(input.path, 'path');
    if (typeof input.create !== 'boolean') {
      throw workbenchError('INVALID_INPUT', 'create must be a boolean');
    }
    const mode = input.mode === undefined
      ? input.create ? 'readwrite' : 'readonly'
      : parseConnectionMode(input.mode);
    if (input.create && mode === 'readonly') {
      throw workbenchError('INVALID_INPUT', '新建数据库必须使用可写模式。');
    }

    let absolutePath = path.resolve(requestedPath);
    let createdIdentity: FileIdentity | null = null;
    if (input.create) {
      absolutePath = validateCreateTarget({
        directory: path.dirname(absolutePath),
        fileName: path.basename(absolutePath),
      });
      let descriptor: number | null = null;
      try {
        descriptor = fs.openSync(absolutePath, 'wx', 0o600);
        const stat = fs.fstatSync(descriptor);
        createdIdentity = { device: stat.dev, inode: stat.ino };
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          throw workbenchError('PATH_EXISTS', '数据库文件已经存在。');
        }
        throw new WorkbenchError('INVALID_PATH', '无法在所选文件夹中新建数据库。', errorMessage(error));
      } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
      }
    }
    const exists = fs.existsSync(absolutePath);
    if (input.create) {
      if (!exists) throw workbenchError('INVALID_PATH', '新建数据库的保留文件意外丢失。');
    } else {
      if (!exists) {
        throw workbenchError('INVALID_PATH', '数据库文件不存在。');
      }
      if (!fs.statSync(absolutePath).isFile()) {
        throw workbenchError('INVALID_PATH', '所选数据库路径不是文件。');
      }
      absolutePath = fs.realpathSync(absolutePath);
    }

    let candidate: Database.Database | null = null;
    try {
      const connection = this.createConnection(absolutePath, mode, true);
      candidate = connection.database;
      if (createdIdentity !== null && !matchesFileIdentity(absolutePath, createdIdentity)) {
        throw workbenchError('CREATE_TARGET_CHANGED', '新建数据库路径在连接期间发生变化，操作已取消。');
      }
      absolutePath = fs.realpathSync(absolutePath);
      const fileIdentity = formatFileIdentity(fs.statSync(absolutePath));

      const previous = this.database;
      this.database = candidate;
      this.databasePath = absolutePath;
      this.fileIdentity = fileIdentity;
      this.connectionMode = mode;
      this.sqliteVersion = connection.sqliteVersion;
      this.foreignKeys = connection.foreignKeys;
      this.busyTimeout = connection.busyTimeout;
      this.resetQueryCache();
      this.rememberDatabasePath(absolutePath);
      candidate = null;
      previous?.close();
      return this.getConnectionState();
    } catch (error) {
      candidate?.close();
      if (createdIdentity !== null && matchesFileIdentity(absolutePath, createdIdentity)) {
        fs.unlinkSync(absolutePath);
      }
      throw normalizeSqliteError(error);
    }
  }

  setConnectionMode(input: unknown): ConnectionState {
    this.assertNoActiveSql();
    if (!isRecord(input)) {
      throw workbenchError('INVALID_INPUT', '连接模式参数无效。');
    }
    const mode = parseConnectionMode(input.mode);
    const current = this.requireDatabase();
    const databasePath = this.databasePath;
    if (databasePath === null) {
      throw workbenchError('NOT_CONNECTED', '尚未连接 SQLite 数据库。');
    }
    if (mode === this.connectionMode) return this.getConnectionState();
    if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
      throw workbenchError('INVALID_PATH', '当前数据库文件已不存在，无法切换模式。');
    }

    let candidate: Database.Database | null = null;
    try {
      const connection = this.createConnection(databasePath, mode, true);
      candidate = connection.database;
      this.database = candidate;
      this.connectionMode = mode;
      this.sqliteVersion = connection.sqliteVersion;
      this.foreignKeys = connection.foreignKeys;
      this.busyTimeout = connection.busyTimeout;
      this.resetQueryCache();
      candidate = null;
      current.close();
      return this.getConnectionState();
    } catch (error) {
      candidate?.close();
      throw normalizeSqliteError(error);
    }
  }

  closeDatabase(): ConnectionState {
    this.assertNoActiveSql();
    const database = this.database;
    this.database = null;
    this.databasePath = null;
    this.fileIdentity = null;
    this.connectionMode = null;
    this.sqliteVersion = null;
    this.foreignKeys = null;
    this.busyTimeout = null;
    this.resetQueryCache();
    database?.close();
    return this.getConnectionState();
  }

  async dispose(): Promise<void> {
    await this.sqlWorker.dispose();
    this.closeDatabase();
  }

  getSchema(): { objects: SchemaObject[] } {
    const database = this.requireDatabase();
    const rows = (database.prepare('PRAGMA table_list').all() as TableListRow[])
      .filter((row) => (
        row.schema === 'main'
        && !row.name.toLowerCase().startsWith('sqlite_')
        && ['table', 'view', 'virtual', 'shadow'].includes(row.type)
      ))
      .sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }));
    const sqlStatement = database.prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE name = ?
      LIMIT 1
    `);

    return {
      objects: rows.map((row) => {
        const schemaSql = sqlStatement.get(row.name) as SchemaSqlRow | undefined;
        const readOnlyReason = this.getReadOnlyReason(row.type);
        return {
          name: row.name,
          kind: row.type,
          type: row.type === 'view' ? 'view' : 'table',
          writable: readOnlyReason === null,
          readOnlyReason,
          sql: schemaSql?.sql ?? '',
        };
      }),
    };
  }

  getRelationshipGraph(): RelationshipGraph {
    const database = this.requireDatabase();
    const objects = (database.prepare('PRAGMA table_list').all() as TableListRow[])
      .filter((row): row is TableListRow & { type: 'table' | 'virtual' } => (
        row.schema === 'main'
        && !row.name.toLowerCase().startsWith('sqlite_')
        && (row.type === 'table' || row.type === 'virtual')
      ))
      .sort((left, right) => compareSqliteNames(left.name, right.name));
    const schemas = objects.map((object) => this.readRelationshipTable(database, object));
    const schemaByIdentifier = new Map(
      schemas.map((schema) => [sqliteIdentifierKey(schema.name), schema]),
    );
    const visibleColumnsByIdentifier = new Map(
      schemas.map((schema) => [
        sqliteIdentifierKey(schema.name),
        canonicalVisibleColumnNames(schema.columns),
      ]),
    );
    const tables = schemas.map((schema) => {
      const foreignColumns = new Set(
        schema.foreignKeys.map((key) => sqliteIdentifierKey(key.from)),
      );
      return {
        name: schema.name,
        kind: schema.kind,
        columns: schema.columns
          .filter((column) => !column.hidden || column.generated)
          .map((column) => ({
            name: column.name,
            type: column.type,
            primaryKeyOrder: column.primaryKeyOrder,
            foreignKey: foreignColumns.has(sqliteIdentifierKey(column.name)),
          })),
      };
    });
    const relationships = schemas.flatMap((schema) => {
      const groups = new Map<number, ForeignKeySchema[]>();
      for (const key of schema.foreignKeys) {
        const group = groups.get(key.id) ?? [];
        group.push(key);
        groups.set(key.id, group);
      }
      return [...groups.entries()]
        .sort(([left], [right]) => left - right)
        .flatMap(([id, keys]) => {
          const ordered = [...keys].sort((left, right) => left.sequence - right.sequence);
          const first = ordered[0];
          if (!first) return [];
          const target = schemaByIdentifier.get(sqliteIdentifierKey(first.table));
          if (!target) return [];
          const sourceColumns = visibleColumnsByIdentifier.get(sqliteIdentifierKey(schema.name))!;
          const targetColumns = visibleColumnsByIdentifier.get(sqliteIdentifierKey(target.name))!;
          return [{
            id: `${schema.name}:${id}`,
            fromTable: schema.name,
            toTable: target.name,
            columns: ordered.map((key) => ({
              from: sourceColumns.get(sqliteIdentifierKey(key.from)) ?? key.from,
              to: key.to === null
                ? null
                : targetColumns.get(sqliteIdentifierKey(key.to)) ?? key.to,
            })),
            onUpdate: first.onUpdate,
            onDelete: first.onDelete,
          }];
        });
    });
    return { tables, relationships };
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

      const columns = tableInfo.map(columnSchemaFromTableInfo);
      const primaryKey = [...columns]
        .filter((column) => column.primaryKeyOrder > 0)
        .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder)
        .map((column) => column.name);
      const indexes = object.kind === 'table'
        ? this.readIndexes(database, name)
        : [];
      const foreignKeys = object.kind === 'table'
        ? this.readForeignKeys(database, name)
        : [];
      const triggers = this.readTriggers(database, name);
      const hasRowid = object.kind === 'table' && !/\bWITHOUT\s+ROWID\b/i.test(object.sql);
      const stablePrimaryKey = hasGuaranteedPrimaryKey({ primaryKey, columns, indexes, hasRowid });
      const stableIdentity = stablePrimaryKey
        || (hasRowid && chooseRowidSource(columns.map((column) => column.name)) !== null);
      const writable = object.writable && stableIdentity;
      const readOnlyReason = object.readOnlyReason
        ?? (stableIdentity ? null : '该表没有可安全使用的记录标识。');

      return {
        ...object,
        writable,
        readOnlyReason,
        columns,
        primaryKey,
        indexes,
        foreignKeys,
        triggers,
        hasRowid,
      };
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  getRows(input: unknown): RowsResult {
    const query = parseRowQuery(input);
    const { name, page, pageSize, offset } = query;
    const database = this.requireDatabase();
    const schema = this.getObjectSchema({ name });
    const displayColumns = getDisplayColumns(schema);
    const built = this.buildRowQuery(schema, displayColumns, query.search, query.filters, query.sorts);
    const cacheKey = JSON.stringify([
      this.databaseGeneration,
      name,
      query.search ?? null,
      query.filters,
    ]);
    let total = this.countCache.get(cacheKey);
    if (total === undefined) {
      const totalValue = database
        .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}${built.whereSql}`)
        .pluck()
        .get(...built.parameters) as number | bigint;
      total = Number(totalValue);
      if (!Number.isSafeInteger(total)) {
        throw workbenchError('RESULT_TOO_LARGE', `记录总数超出支持范围：${totalValue}`);
      }
      this.countCache.set(cacheKey, total);
    }

    const rowidAlias = built.rowidSource === null
      ? null
      : chooseRowidAlias(schema.columns.map((column) => column.name));
    const projection = rowidAlias === null
      ? '*'
      : `${quoteIdentifier(built.rowidSource!)} AS ${quoteIdentifier(rowidAlias)}, *`;
    const records = database
      .prepare(`SELECT ${projection} FROM ${quoteIdentifier(name)}${built.whereSql}${built.orderSql} LIMIT ? OFFSET ?`)
      .all(...built.parameters, BigInt(pageSize), BigInt(offset)) as Record<string, unknown>[];

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

  exportRows(input: unknown): ExportRowsResult {
    const query = parseExportRequest(input);
    const database = this.requireDatabase();
    const schema = this.getObjectSchema({ name: query.name });
    const columns = getDisplayColumns(schema);
    const built = this.buildRowQuery(
      schema,
      columns,
      query.search,
      query.filters,
      query.sorts,
    );
    const collected: Record<string, SerializedValue>[] = [];
    const batchSize = 500;
    const exportLimit = 10_000;

    for (let offset = 0; collected.length <= exportLimit; offset += batchSize) {
      const remaining = exportLimit + 1 - collected.length;
      const limit = Math.min(batchSize, remaining);
      const records = database.prepare(`
        SELECT ${columns.map(quoteIdentifier).join(', ')}
        FROM ${quoteIdentifier(query.name)}${built.whereSql}${built.orderSql}
        LIMIT ? OFFSET ?
      `).all(...built.parameters, BigInt(limit), BigInt(offset)) as Record<string, unknown>[];
      collected.push(...records.map((record) => Object.fromEntries(
        columns.map((column) => [column, serializeValue(record[column])]),
      )));
      if (records.length < limit) break;
    }

    const truncated = collected.length > exportLimit;
    const exported = truncated ? collected.slice(0, exportLimit) : collected;
    const baseName = safeExportName(query.name);
    const content = query.format === 'csv'
      ? toCsv(columns, exported)
      : JSON.stringify(exported, null, 2);
    return {
      format: query.format,
      fileName: `${baseName}.${query.format}`,
      mimeType: query.format === 'csv'
        ? 'text/csv;charset=utf-8'
        : 'application/json;charset=utf-8',
      content,
      rows: exported.length,
      truncated,
      warning: truncated ? '结果超过 10,000 行，仅导出前 10,000 行。' : null,
    };
  }

  insertRow(input: unknown): MutationReceipt & { lastInsertRowid: SerializedValue } {
    const { name, schema, values } = this.parseWriteInput(input, 'insertRow');
    const columns = Object.keys(values);
    const databaseValues = columns.map((column) => this.parseColumnValue(schema, column, values[column]));
    const sql = columns.length === 0
      ? `INSERT INTO ${quoteIdentifier(name)} DEFAULT VALUES`
      : `INSERT INTO ${quoteIdentifier(name)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    const database = this.requireDatabase();

    try {
      const outcome = database.transaction(() => {
        const result = database.prepare(sql).run(...databaseValues);
        const record = this.readInsertedRecord(schema, result.lastInsertRowid, columns, databaseValues);
        if (record === null) {
          throw workbenchError('STALE_ROW', '新增记录后无法确认其记录标识。');
        }
        const identity = this.identityForRecord(schema, record);
        if (identity === null) {
          throw workbenchError('READ_ONLY', '该表没有可安全使用的记录标识。');
        }
        return {
          result,
          identity,
          record,
        };
      })();
      this.countCache.clear();
      const mutableColumns = getMutableColumns(schema);
      const undo = this.saveMutation({
        operation: 'insert',
        objectName: name,
        identity: outcome.identity,
        afterFingerprint: fingerprintRecord(pickValues(outcome.record, mutableColumns)),
        beforeValues: null,
        columns: mutableColumns,
      });
      return {
        changes: outcome.result.changes,
        lastInsertRowid: serializeValue(outcome.result.lastInsertRowid),
        identity: outcome.identity,
        ...undo,
      };
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  updateRow(input: unknown): MutationReceipt {
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
    const database = this.requireDatabase();
    try {
      const outcome = database.transaction(() => {
        const before = this.readRecord(schema, record.identity);
        if (before === null) throw workbenchError('STALE_ROW', '记录已变化或不存在。');
        const result = database.prepare(sql).run(...databaseValues, ...identity.params);
        if (result.changes !== 1) throw workbenchError('STALE_ROW', '记录已变化或不存在。');
        const nextIdentity = updatedIdentity(schema, record.identity, columns, databaseValues);
        const after = this.readRecord(schema, nextIdentity);
        if (after === null) throw workbenchError('STALE_ROW', '修改后无法确认记录状态。');
        return { result, before, after, identity: nextIdentity };
      })();
      this.countCache.clear();
      const mutableColumns = getMutableColumns(schema);
      const undo = this.saveMutation({
        operation: 'update',
        objectName: name,
        identity: outcome.identity,
        afterFingerprint: fingerprintRecord(pickValues(outcome.after, mutableColumns)),
        beforeValues: pickValues(outcome.before, mutableColumns),
        columns: mutableColumns,
      });
      return { changes: outcome.result.changes, identity: outcome.identity, ...undo };
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  deleteRow(input: unknown): MutationReceipt {
    const { name, schema, record } = this.parseWriteInput(input, 'deleteRow', false);
    const identity = buildIdentityWhere(schema, record.identity);
    const sql = `DELETE FROM ${quoteIdentifier(name)} WHERE ${identity.sql}`;
    const database = this.requireDatabase();
    try {
      const outcome = database.transaction(() => {
        const before = this.readRecord(schema, record.identity);
        if (before === null) throw workbenchError('STALE_ROW', '记录已变化或不存在。');
        const result = database.prepare(sql).run(...identity.params);
        if (result.changes !== 1) throw workbenchError('STALE_ROW', '记录已变化或不存在。');
        return { result, before };
      })();
      this.countCache.clear();
      const rowIdentity = record.identity as RowIdentity;
      const columns = getMutableColumns(schema);
      const undo = this.saveMutation({
        operation: 'delete',
        objectName: name,
        identity: rowIdentity,
        afterFingerprint: null,
        beforeValues: pickValues(outcome.before, columns),
        columns,
      });
      return { changes: outcome.result.changes, identity: rowIdentity, ...undo };
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  undoLastMutation(input: unknown): { undone: true; operation: MutationOperation } {
    if (!isRecord(input) || typeof input.token !== 'string' || input.token === '') {
      throw workbenchError('INVALID_INPUT', '撤销凭证无效。');
    }
    const snapshot = this.lastMutation;
    if (snapshot === null) throw workbenchError('NO_UNDO', '当前没有可撤销的记录操作。');
    if (snapshot.token !== input.token) {
      throw workbenchError('INVALID_UNDO_TOKEN', '撤销凭证与最近一次操作不匹配。');
    }
    if (snapshot.databaseGeneration !== this.databaseGeneration) {
      this.lastMutation = null;
      throw workbenchError('NO_UNDO', '数据库连接已变化，无法撤销。');
    }
    if (this.now() > snapshot.expiresAt) {
      this.lastMutation = null;
      throw workbenchError('UNDO_EXPIRED', '撤销时间已超过 10 秒。');
    }
    const database = this.requireDatabase();
    const schema = this.getObjectSchema({ name: snapshot.objectName });
    if (!schema.writable) throw workbenchError('READ_ONLY', '当前对象不可写，无法撤销。');

    try {
      database.transaction(() => {
        const current = this.readRecord(schema, snapshot.identity);
        if (snapshot.operation === 'insert') {
          if (
            current === null
            || fingerprintRecord(pickValues(current, snapshot.columns)) !== snapshot.afterFingerprint
          ) {
            throw workbenchError('STALE_ROW', '记录已被其他操作修改，无法安全撤销。');
          }
          const where = buildIdentityWhere(schema, snapshot.identity);
          const result = database.prepare(
            `DELETE FROM ${quoteIdentifier(snapshot.objectName)} WHERE ${where.sql}`,
          ).run(...where.params);
          if (result.changes !== 1) throw workbenchError('STALE_ROW', '记录已变化或不存在。');
          return;
        }
        if (snapshot.operation === 'update') {
          if (
            current === null
            || fingerprintRecord(pickValues(current, snapshot.columns)) !== snapshot.afterFingerprint
          ) {
            throw workbenchError('STALE_ROW', '记录已被其他操作修改，无法安全撤销。');
          }
          const where = buildIdentityWhere(schema, snapshot.identity);
          const assignments = snapshot.columns.map((column) => `${quoteIdentifier(column)} = ?`);
          const values = snapshot.columns.map((column) => snapshot.beforeValues![column] as DatabaseValue);
          const result = database.prepare(
            `UPDATE ${quoteIdentifier(snapshot.objectName)} SET ${assignments.join(', ')} WHERE ${where.sql}`,
          ).run(...values, ...where.params);
          if (result.changes !== 1) throw workbenchError('STALE_ROW', '记录已变化或不存在。');
          return;
        }
        if (current !== null) {
          throw workbenchError('STALE_ROW', '原记录标识已被占用，无法安全撤销。');
        }
        const placeholders = snapshot.columns.map(() => '?').join(', ');
        const values = snapshot.columns.map((column) => snapshot.beforeValues![column] as DatabaseValue);
        database.prepare(
          `INSERT INTO ${quoteIdentifier(snapshot.objectName)} (${snapshot.columns.map(quoteIdentifier).join(', ')}) VALUES (${placeholders})`,
        ).run(...values);
      })();
      this.lastMutation = null;
      this.countCache.clear();
      return { undone: true, operation: snapshot.operation };
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  analyzeSql(input: unknown): SqlAnalysis {
    if (!isRecord(input)) throw workbenchError('INVALID_INPUT', 'SQL 分析参数无效。');
    const sql = requireNonEmptyString(input.sql, 'SQL');
    const parsedAnalysis = analyzeSqlText(sql);
    const analysis = !parsedAnalysis.readonly && this.connectionMode === 'readwrite'
      ? { ...parsedAnalysis, targetObjects: this.authorizeSqlTargets(parsedAnalysis) }
      : parsedAnalysis;
    let confirmationToken: string | null = null;
    if (!analysis.readonly && this.connectionMode === 'readwrite') {
      confirmationToken = this.createToken();
      this.sqlConfirmation = {
        token: confirmationToken,
        sql,
        databaseGeneration: this.databaseGeneration,
        expiresAt: this.now() + 30_000,
      };
    } else {
      this.sqlConfirmation = null;
    }
    return { ...analysis, confirmationToken };
  }

  async executeSql(input: unknown): Promise<SqlExecutionResult> {
    const request = this.parseSqlExecution(input);
    const analysis = analyzeSqlText(request.sql);
    if (!analysis.readonly) {
      this.consumeSqlConfirmation(request.sql, request.confirmationToken);
      this.authorizeSqlTargets(analysis);
    }
    const databasePath = this.databasePath;
    const mode = this.connectionMode;
    this.requireDatabase();
    if (databasePath === null || mode === null) {
      throw workbenchError('NOT_CONNECTED', '尚未连接 SQLite 数据库。');
    }
    const result = await this.sqlWorker.execute({
      executionId: request.executionId,
      databasePath,
      mode,
      sql: request.sql,
      maxRows: 50,
      offset: (request.page - 1) * 50,
    });
    if (result.kind === 'mutation') {
      this.countCache.clear();
      this.lastMutation = null;
    }
    return result;
  }

  async explainSql(input: unknown): Promise<SqlExecutionResult> {
    const request = this.parseSqlExecution(input);
    analyzeSqlText(request.sql);
    const databasePath = this.databasePath;
    const mode = this.connectionMode;
    this.requireDatabase();
    if (databasePath === null || mode === null) {
      throw workbenchError('NOT_CONNECTED', '尚未连接 SQLite 数据库。');
    }
    return this.sqlWorker.execute({
      executionId: request.executionId,
      databasePath,
      mode,
      sql: request.sql,
      explain: true,
      maxRows: 50,
      offset: (request.page - 1) * 50,
    });
  }

  async cancelSql(input: unknown): Promise<{ cancelled: boolean }> {
    if (!isRecord(input) || typeof input.executionId !== 'string' || input.executionId === '') {
      throw workbenchError('INVALID_INPUT', 'SQL 执行标识无效。');
    }
    return { cancelled: await this.sqlWorker.cancel(input.executionId) };
  }

  private assertNoActiveSql(): void {
    if (this.sqlWorker.isActive()) {
      throw workbenchError('SQL_BUSY', 'SQL 正在执行，请先取消或等待完成。');
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
      const message = this.connectionMode === 'readonly'
        ? '当前连接为只读模式，无法修改记录。'
        : schema.readOnlyReason ?? '该数据库对象不可修改。';
      throw workbenchError('READ_ONLY', message);
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

  private buildRowQuery(
    schema: ObjectSchema,
    columns: string[],
    search: string | undefined,
    filters: FilterInput[],
    sorts: SortInput[],
  ): BuiltRowQuery {
    const columnSet = new Set(columns);
    const conditions: string[] = [];
    const parameters: DatabaseValue[] = [];
    const searchableColumns = schema.columns
      .filter((column) => columnSet.has(column.name) && !/\bBLOB\b/i.test(column.type))
      .map((column) => column.name);

    if (search !== undefined && searchableColumns.length > 0) {
      conditions.push(`(${searchableColumns.map((column) => (
        `CAST(${quoteIdentifier(column)} AS TEXT) LIKE ? ESCAPE '\\'`
      )).join(' OR ')})`);
      parameters.push(...searchableColumns.map(() => `%${escapeLike(search)}%`));
    }

    for (const filter of filters) {
      if (!columnSet.has(filter.column)) {
        throw workbenchError('INVALID_COLUMN', `筛选列不存在：${filter.column}`);
      }
      const column = quoteIdentifier(filter.column);
      switch (filter.operator) {
        case 'contains':
          conditions.push(`CAST(${column} AS TEXT) LIKE ? ESCAPE '\\'`);
          parameters.push(`%${escapeLike(filter.value ?? '')}%`);
          break;
        case 'equals':
          conditions.push(`CAST(${column} AS TEXT) = ?`);
          parameters.push(filter.value ?? '');
          break;
        case 'is-null':
          conditions.push(`${column} IS NULL`);
          break;
        case 'is-not-null':
          conditions.push(`${column} IS NOT NULL`);
          break;
      }
    }

    for (const sort of sorts) {
      if (!columnSet.has(sort.column)) {
        throw workbenchError('INVALID_COLUMN', `排序列不存在：${sort.column}`);
      }
    }
    const rowidSource = schema.kind === 'table'
      && schema.hasRowid
      && !hasGuaranteedPrimaryKey(schema)
      ? chooseRowidSource(columns)
      : null;
    const stableColumns = schema.primaryKey.length > 0
      ? schema.primaryKey
      : rowidSource === null ? columns : [];
    const requestedColumns = new Set(sorts.map((sort) => sort.column));
    const orderParts = sorts.map((sort) => (
      `${quoteIdentifier(sort.column)} ${sort.direction.toUpperCase()}`
    ));
    orderParts.push(...stableColumns
      .filter((column) => !requestedColumns.has(column))
      .map((column) => `${quoteIdentifier(column)} ASC`));
    if (rowidSource !== null) {
      orderParts.push(`${quoteIdentifier(rowidSource)} ASC`);
    }

    return {
      whereSql: conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`,
      orderSql: orderParts.length === 0 ? '' : ` ORDER BY ${orderParts.join(', ')}`,
      parameters,
      rowidSource,
    };
  }

  private readForeignKeys(database: Database.Database, tableName: string): ForeignKeySchema[] {
    const rows = database
      .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`)
      .all() as ForeignKeyRow[];
    return rows.map((row) => ({
      id: Number(row.id),
      sequence: Number(row.seq),
      table: row.table,
      from: row.from,
      to: row.to,
      onUpdate: row.on_update,
      onDelete: row.on_delete,
      match: row.match,
    }));
  }

  private readRelationshipTable(
    database: Database.Database,
    object: Pick<TableListRow, 'name' | 'type'> & { type: 'table' | 'virtual' },
  ): RelationshipTableMetadata {
    const rows = database
      .prepare(`PRAGMA table_xinfo(${quoteIdentifier(object.name)})`)
      .all() as TableInfoRow[];
    return {
      name: object.name,
      kind: object.type,
      columns: rows.map(columnSchemaFromTableInfo),
      foreignKeys: object.type === 'table' ? this.readForeignKeys(database, object.name) : [],
    };
  }

  private readTriggers(database: Database.Database, tableName: string): TriggerSchema[] {
    const rows = database.prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'trigger' AND tbl_name = ?
      ORDER BY name COLLATE NOCASE, name
    `).all(tableName) as TriggerRow[];
    return rows.map((row) => ({ name: row.name, sql: row.sql ?? '' }));
  }

  private requireDatabase(): Database.Database {
    if (!this.database) {
      throw workbenchError('NOT_CONNECTED', '尚未连接 SQLite 数据库。');
    }
    return this.database;
  }

  private rememberDatabasePath(databasePath: string): void {
    this.recentDatabasePaths = [
      databasePath,
      ...this.recentDatabasePaths.filter((item) => item !== databasePath),
    ].slice(0, 10);
  }

  private createConnection(
    databasePath: string,
    mode: ConnectionMode,
    fileMustExist: boolean,
  ): {
    database: Database.Database;
    sqliteVersion: string;
    foreignKeys: boolean;
    busyTimeout: number;
  } {
    const database = new Database(databasePath, {
      readonly: mode === 'readonly',
      fileMustExist,
    });
    try {
      database.defaultSafeIntegers(true);
      database.pragma('schema_version', { simple: true });
      database.pragma('foreign_keys = ON');
      database.pragma('busy_timeout = 5000');
      const versionRow = database.prepare('SELECT sqlite_version() AS version').get() as {
        version: string;
      };
      const foreignKeys = Number(database.pragma('foreign_keys', { simple: true })) !== 0;
      const busyTimeout = Number(database.pragma('busy_timeout', { simple: true }));
      return {
        database,
        sqliteVersion: versionRow.version,
        foreignKeys,
        busyTimeout,
      };
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private getReadOnlyReason(kind: ObjectKind): string | null {
    if (kind === 'view') return '视图不支持记录编辑。';
    if (kind === 'virtual') return '虚拟表不支持记录编辑。';
    if (kind === 'shadow') return 'SQLite 系统影子表不可编辑。';
    if (this.connectionMode === 'readonly') return '当前连接为只读模式。';
    return null;
  }

  private resetQueryCache(): void {
    this.databaseGeneration += 1;
    this.countCache.clear();
    this.lastMutation = null;
    this.sqlConfirmation = null;
  }

  private parseSqlExecution(input: unknown): {
    executionId: string;
    sql: string;
    confirmationToken: string | null;
    page: number;
  } {
    if (!isRecord(input)) throw workbenchError('INVALID_INPUT', 'SQL 执行参数无效。');
    const sql = requireNonEmptyString(input.sql, 'SQL');
    const executionId = input.executionId === undefined
      ? randomUUID()
      : requireNonEmptyString(input.executionId, 'executionId');
    if (input.confirmationToken !== undefined && typeof input.confirmationToken !== 'string') {
      throw workbenchError('INVALID_INPUT', 'SQL 确认凭证无效。');
    }
    const page = input.page === undefined ? 1 : input.page;
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 10_000) {
      throw workbenchError('INVALID_INPUT', 'SQL 结果页码无效。');
    }
    return {
      executionId,
      sql,
      confirmationToken: typeof input.confirmationToken === 'string' ? input.confirmationToken : null,
      page,
    };
  }

  private consumeSqlConfirmation(sql: string, token: string | null): void {
    if (this.connectionMode !== 'readwrite') {
      throw workbenchError('READ_ONLY', '当前连接为只读模式，无法执行写 SQL。');
    }
    const confirmation = this.sqlConfirmation;
    if (
      confirmation === null
      || token === null
      || confirmation.token !== token
      || confirmation.sql !== sql
      || confirmation.databaseGeneration !== this.databaseGeneration
      || confirmation.expiresAt < this.now()
    ) {
      throw workbenchError('INVALID_SQL_CONFIRMATION', '写 SQL 的确认凭证无效或已过期。');
    }
    this.sqlConfirmation = null;
  }

  private authorizeSqlTargets(analysis: SqlTextAnalysis): string[] {
    const database = this.requireDatabase();
    const objects = this.getSchema().objects;
    const resolvedTargets: string[] = [];

    for (const requestedTarget of analysis.targetObjects) {
      const schemaOwner = database.prepare(`
        SELECT name, tbl_name
        FROM sqlite_schema
        WHERE name = ? COLLATE NOCASE
        LIMIT 1
      `).get(requestedTarget) as SchemaOwnerRow | undefined;
      const protectedName = schemaOwner?.tbl_name ?? requestedTarget;
      const object = objects.find((candidate) => (
        candidate.name.localeCompare(protectedName, 'en', { sensitivity: 'base' }) === 0
      ));

      if (!object) {
        if (analysis.statementType !== 'CREATE' && analysis.statementType !== 'DROP') {
          throw workbenchError('OBJECT_NOT_FOUND', `SQL 目标对象不存在：${requestedTarget}`);
        }
        resolvedTargets.push(requestedTarget);
        continue;
      }

      const schema = this.getObjectSchema({ name: object.name });
      if (!schema.writable) {
        throw workbenchError(
          'READ_ONLY_OBJECT',
          `SQL 目标对象不可写：${object.name}。${schema.readOnlyReason ?? '该对象受只读策略保护。'}`,
        );
      }
      resolvedTargets.push(object.name);
    }

    return [...new Set(resolvedTargets)];
  }

  private readInsertedRecord(
    schema: ObjectSchema,
    lastInsertRowid: number | bigint,
    insertedColumns: string[],
    insertedValues: DatabaseValue[],
  ): Record<string, unknown> | null {
    const rowidSource = schema.hasRowid
      ? chooseRowidSource(schema.columns.map((column) => column.name))
      : null;
    if (rowidSource !== null) {
      const alias = chooseRowidAlias(schema.columns.map((column) => column.name));
      return this.requireDatabase().prepare(
        `SELECT ${quoteIdentifier(rowidSource)} AS ${quoteIdentifier(alias)}, * FROM ${quoteIdentifier(schema.name)} WHERE ${quoteIdentifier(rowidSource)} IS ?`,
      ).get(lastInsertRowid) as Record<string, unknown> | undefined ?? null;
    }
    if (schema.primaryKey.every((column) => insertedColumns.includes(column))) {
      const values = Object.fromEntries(schema.primaryKey.map((column) => {
        const index = insertedColumns.indexOf(column);
        return [column, serializeValue(insertedValues[index])];
      }));
      return this.readRecord(schema, { kind: 'primary-key', values });
    }
    return null;
  }

  private readRecord(schema: ObjectSchema, identity: unknown): Record<string, unknown> | null {
    const where = buildIdentityWhere(schema, identity);
    const record = this.requireDatabase().prepare(
      `SELECT * FROM ${quoteIdentifier(schema.name)} WHERE ${where.sql} LIMIT 1`,
    ).get(...where.params) as Record<string, unknown> | undefined;
    return record ?? null;
  }

  private identityForRecord(schema: ObjectSchema, record: Record<string, unknown>): RowIdentity | null {
    if (hasGuaranteedPrimaryKey(schema)) {
      return {
        kind: 'primary-key',
        values: Object.fromEntries(
          schema.primaryKey.map((column) => [column, serializeValue(record[column])]),
        ),
      };
    }
    const alias = chooseRowidAlias(schema.columns.map((column) => column.name));
    return alias in record ? { kind: 'rowid', value: serializeValue(record[alias]) } : null;
  }

  private saveMutation(
    snapshot: Omit<MutationSnapshot, 'token' | 'expiresAt' | 'databaseGeneration'>,
  ): { undoToken: string; undoExpiresAt: string } {
    const token = this.createToken();
    const expiresAt = this.now() + 10_000;
    this.lastMutation = {
      ...snapshot,
      token,
      expiresAt,
      databaseGeneration: this.databaseGeneration,
    };
    return { undoToken: token, undoExpiresAt: new Date(expiresAt).toISOString() };
  }
}

export function workbenchError(code: string, message: string): Error {
  return new WorkbenchError(code, message);
}

export function normalizeSqliteError(error: unknown): Error {
  if (error instanceof WorkbenchError) return error;
  const code = isRecord(error) && typeof error.code === 'string'
    ? error.code
    : 'SQLITE_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  return new WorkbenchError(code, '数据库操作失败，请查看详情。', message);
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw workbenchError('INVALID_INPUT', `${name} must be a non-empty string`);
  }
  return value.trim();
}

function columnSchemaFromTableInfo(row: TableInfoRow): ColumnSchema {
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
}

function sqliteIdentifierKey(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function canonicalVisibleColumnNames(columns: ColumnSchema[]): Map<string, string> {
  return new Map(columns
    .filter((column) => !column.hidden || column.generated)
    .map((column) => [sqliteIdentifierKey(column.name), column.name]));
}

function compareSqliteNames(left: string, right: string): number {
  return left.localeCompare(right, 'en', { sensitivity: 'base' })
    || left.localeCompare(right, 'en');
}

function chooseRowidAlias(columnNames: string[]): string {
  const names = new Set(columnNames);
  let alias = '__ce_rowid__';
  while (names.has(alias)) alias = `_${alias}`;
  return alias;
}

function chooseRowidSource(columnNames: string[]): string | null {
  const names = new Set(columnNames.map((name) => name.toLowerCase()));
  return ['rowid', '_rowid_', 'oid'].find((name) => !names.has(name)) ?? null;
}

function createRowIdentity(
  schema: ObjectSchema,
  record: Record<string, unknown>,
  rowidAlias: string | null,
): RowIdentity | null {
  if (schema.kind !== 'table') return null;
  if (hasGuaranteedPrimaryKey(schema)) {
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

function hasGuaranteedPrimaryKey(
  schema: Pick<ObjectSchema, 'primaryKey' | 'columns' | 'indexes' | 'hasRowid'>,
): boolean {
  if (schema.primaryKey.length === 0) return false;
  if (!schema.hasRowid) return true;
  const primaryColumns = schema.primaryKey.map((name) => (
    schema.columns.find((column) => column.name === name)
  ));
  if (primaryColumns.some((column) => column === undefined)) return false;
  if (
    primaryColumns.length === 1
    && primaryColumns[0]!.type.trim().toUpperCase() === 'INTEGER'
    && !schema.indexes.some((index) => index.origin === 'pk')
  ) return true;
  return primaryColumns.every((column) => column!.notNull);
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

function updatedIdentity(
  schema: ObjectSchema,
  identity: unknown,
  updatedColumns: string[],
  updatedValues: DatabaseValue[],
): RowIdentity {
  if (!isRecord(identity) || typeof identity.kind !== 'string') {
    throw workbenchError('INVALID_IDENTITY', '记录标识无效。');
  }
  if (identity.kind === 'rowid') return identity as RowIdentity;
  if (identity.kind !== 'primary-key' || !isRecord(identity.values)) {
    throw workbenchError('INVALID_IDENTITY', '主键记录标识无效。');
  }
  return {
    kind: 'primary-key',
    values: Object.fromEntries(schema.primaryKey.map((column) => {
      const updatedIndex = updatedColumns.indexOf(column);
      return [
        column,
        updatedIndex === -1 ? identity.values![column] : serializeValue(updatedValues[updatedIndex]),
      ];
    })),
  };
}

function getMutableColumns(schema: ObjectSchema): string[] {
  return schema.columns
    .filter((column) => !column.hidden && !column.generated)
    .map((column) => column.name);
}

function pickValues(record: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((column) => [column, record[column]]));
}

function fingerprintRecord(record: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(record).sort().map((key) => [key, fingerprintValue(record[key])]));
}

function fingerprintValue(value: unknown): unknown {
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  if (Buffer.isBuffer(value)) return { type: 'blob', value: value.toString('base64') };
  return value;
}

function getDisplayColumns(schema: ObjectSchema): string[] {
  return schema.columns
    .filter((column) => !column.hidden || column.generated)
    .map((column) => column.name);
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function safeExportName(value: string): string {
  const safe = value.replaceAll(/[\\/:*?"<>|]/g, '_').trim();
  return safe === '' ? 'sqlite-export' : safe;
}

function toCsv(columns: string[], rows: Record<string, SerializedValue>[]): string {
  return [
    columns.map(csvCell).join(','),
    ...rows.map((row) => columns.map((column) => csvCell(csvValue(row[column]))).join(',')),
  ].join('\r\n');
}

function csvValue(value: SerializedValue): string {
  if (value === null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value.type === 'integer') return value.value;
  return value.previewHex;
}

function csvCell(value: unknown): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function matchesFileIdentity(filePath: string, identity: FileIdentity): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.dev === identity.device && stat.ino === identity.inode;
  } catch {
    return false;
  }
}

function formatFileIdentity(stat: fs.Stats): string | null {
  if (Number.isSafeInteger(stat.dev) && Number.isSafeInteger(stat.ino) && stat.ino > 0) {
    return `dev:${stat.dev}:ino:${stat.ino}`;
  }
  return Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
    ? `birth:${stat.birthtimeMs}`
    : null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
