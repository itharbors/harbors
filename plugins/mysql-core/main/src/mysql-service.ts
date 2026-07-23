import {
  Mysql2Driver,
  type DriverResult,
  type MysqlConnection,
  type MysqlDriver,
  type MysqlPool,
} from './mysql-driver.js';
import {
  deserializeEditableValue,
  isRecord,
  parseConnectionInput,
  parsePageInput,
  quoteIdentifier,
  serializeMysqlValue,
  type DatabaseValue,
  type ConnectionInput,
  type SerializedValue,
} from './protocol.js';
import type { RelationshipGraph } from '@itharbors/mysql-contracts';

export type ConnectionState = {
  connected: boolean;
  endpoint: string | null;
  database: string | null;
  mysqlVersion: string | null;
  tls: boolean;
};

export type SchemaObject = {
  name: string;
  type: 'table' | 'view';
  insertable: boolean;
};

export type ColumnSchema = {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  extra: string;
  generatedExpression: string;
  generated: boolean;
  autoIncrement: boolean;
  binary: boolean;
};

export type IndexSchema = {
  name: string;
  unique: boolean;
  primary: boolean;
  type: string;
  columns: string[];
  prefixLengths: Array<number | null>;
};

export type ForeignKeySchema = {
  name: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
  onUpdate: string;
  onDelete: string;
};

export type ObjectSchema = SchemaObject & {
  rowEditable: boolean;
  columns: ColumnSchema[];
  primaryKey: string[];
  indexes: IndexSchema[];
  foreignKeys: ForeignKeySchema[];
  sql: string;
};

export type RowIdentity = {
  kind: 'primary-key';
  values: Record<string, SerializedValue>;
};

export type RowRecord = {
  values: SerializedValue[];
  identity: RowIdentity | null;
};

export type RowsResult = {
  name: string;
  page: number;
  pageSize: number;
  total: number;
  insertable: boolean;
  rowEditable: boolean;
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
  affectedRows: number;
  insertId: string;
  warningStatus: number;
  elapsedMs: number;
};

export type SqlExecutionResult = SqlRowsResult | SqlMutationResult;

type ResolvedObject = {
  name: string;
  type: 'table' | 'view';
};

export class MysqlWorkbenchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'MysqlWorkbenchError';
  }
}

export class MysqlService {
  private pool: MysqlPool | null = null;
  private endpoint: string | null = null;
  private database: string | null = null;
  private mysqlVersion: string | null = null;
  private tls = false;
  private connectionInput: ConnectionInput | null = null;

  constructor(private readonly driver: MysqlDriver = new Mysql2Driver()) {}

  getConnectionState(): ConnectionState {
    return {
      connected: this.pool !== null,
      endpoint: this.endpoint,
      database: this.database,
      mysqlVersion: this.mysqlVersion,
      tls: this.tls,
    };
  }

  async connect(input: unknown): Promise<ConnectionState> {
    let parsed;
    try {
      parsed = parseConnectionInput(input);
    } catch (error) {
      throw new MysqlWorkbenchError('INVALID_INPUT', errorMessage(error));
    }

    let candidate: MysqlPool | null = null;
    try {
      candidate = this.driver.createPool(parsed);
      const probe = await candidate.query('SELECT VERSION() AS version, DATABASE() AS database_name');
      const rows = expectRows(probe, 'Connection probe');
      const version = requireCellString(rows[0]?.[0], 'MySQL version');
      const database = nullableCellString(rows[0]?.[1], 'database');
      if (parsed.database !== null && database !== parsed.database) {
        throw new MysqlWorkbenchError('DATABASE_NOT_FOUND', 'MySQL did not select the requested database');
      }

      const previous = this.pool;
      this.pool = candidate;
      this.endpoint = `${parsed.host}:${parsed.port}`;
      this.database = database;
      this.mysqlVersion = version;
      this.tls = parsed.tls;
      this.connectionInput = { ...parsed };
      candidate = null;
      if (previous) await endQuietly(previous);
      return this.getConnectionState();
    } catch (error) {
      if (candidate) await endQuietly(candidate);
      throw normalizeMysqlError(error);
    }
  }

  async disconnect(): Promise<ConnectionState> {
    const previous = this.pool;
    this.pool = null;
    this.endpoint = null;
    this.database = null;
    this.mysqlVersion = null;
    this.tls = false;
    this.connectionInput = null;
    if (previous) {
      try {
        await previous.end();
      } catch (error) {
        throw normalizeMysqlError(error);
      }
    }
    return this.getConnectionState();
  }

  async dispose(): Promise<void> {
    await this.disconnect();
  }

  async getDatabases(): Promise<{ databases: string[] }> {
    const result = await this.requirePool().query(
      `SELECT SCHEMA_NAME
         FROM information_schema.SCHEMATA
        ORDER BY SCHEMA_NAME`,
    );
    return {
      databases: expectRows(result, 'Databases query')
        .map((row) => requireCellString(row[0], 'database name')),
    };
  }

  async selectDatabase(input: unknown): Promise<ConnectionState> {
    if (!isRecord(input) || typeof input.database !== 'string' || input.database.trim() === '') {
      throw new MysqlWorkbenchError('INVALID_INPUT', 'database must be a non-empty string');
    }
    this.requirePool();
    const activeInput = this.connectionInput;
    if (!activeInput) throw new MysqlWorkbenchError('NOT_CONNECTED', 'Connect to a MySQL server first');
    const database = input.database.trim();
    if (database === this.database) return this.getConnectionState();

    const nextInput: ConnectionInput = { ...activeInput, database };
    let candidate: MysqlPool | null = null;
    try {
      candidate = this.driver.createPool(nextInput);
      const probe = await candidate.query('SELECT VERSION() AS version, DATABASE() AS database_name');
      const rows = expectRows(probe, 'Connection probe');
      const version = requireCellString(rows[0]?.[0], 'MySQL version');
      const selectedDatabase = nullableCellString(rows[0]?.[1], 'database');
      if (selectedDatabase !== database) {
        throw new MysqlWorkbenchError('DATABASE_NOT_FOUND', 'MySQL did not select the requested database');
      }

      const previous = this.pool;
      this.pool = candidate;
      this.database = selectedDatabase;
      this.mysqlVersion = version;
      this.connectionInput = nextInput;
      candidate = null;
      if (previous) await endQuietly(previous);
      return this.getConnectionState();
    } catch (error) {
      if (candidate) await endQuietly(candidate);
      throw normalizeMysqlError(error);
    }
  }

  async getSchema(): Promise<{ objects: SchemaObject[] }> {
    const pool = this.requirePool();
    const database = this.requireDatabase();
    const result = await pool.query(
      `SELECT TABLE_NAME, TABLE_TYPE
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
          AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
        ORDER BY TABLE_NAME`,
      [database],
    );
    const rows = expectRows(result, 'Schema query');
    return {
      objects: rows.map((row) => {
        const name = requireCellString(row[0], 'table name');
        const type = row[1] === 'VIEW' ? 'view' : 'table';
        return { name, type, insertable: type === 'table' };
      }),
    };
  }

  async getObjectSchema(input: unknown): Promise<ObjectSchema> {
    if (!isRecord(input) || typeof input.name !== 'string' || input.name.trim() === '') {
      throw new MysqlWorkbenchError('INVALID_INPUT', 'name must be a non-empty string');
    }
    const name = input.name;
    const pool = this.requirePool();
    const database = this.requireDatabase();
    const object = await this.resolveObject(name);

    const columnsResult = await pool.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,
              GENERATION_EXPRESSION, ORDINAL_POSITION, DATA_TYPE, CHARACTER_SET_NAME
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [database, name],
    );
    const indexesResult = await pool.query(
      `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART, INDEX_TYPE
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [database, name],
    );
    const foreignKeysResult = await pool.query(
      `SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME,
              k.REFERENCED_COLUMN_NAME, k.ORDINAL_POSITION,
              r.UPDATE_RULE, r.DELETE_RULE
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
          AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?
          AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [database, name],
    );
    const ddlResult = await pool.query(
      `SHOW CREATE ${object.type === 'view' ? 'VIEW' : 'TABLE'} ${quoteIdentifier(name)}`,
    );

    const columns = normalizeColumns(expectRows(columnsResult, 'Columns query'));
    const indexes = normalizeIndexes(expectRows(indexesResult, 'Indexes query'));
    const primaryIndex = indexes.find((index) => index.primary);
    const primaryKey = primaryIndex?.columns ?? [];

    const primaryColumns = new Set(primaryKey);
    const hasBinaryPrimaryKey = columns.some(
      (column) => primaryColumns.has(column.name) && column.binary,
    );

    return {
      name,
      type: object.type,
      insertable: object.type === 'table',
      rowEditable: object.type === 'table' && primaryKey.length > 0 && !hasBinaryPrimaryKey,
      columns,
      primaryKey,
      indexes,
      foreignKeys: normalizeForeignKeys(expectRows(foreignKeysResult, 'Foreign keys query')),
      sql: requireCellString(expectRows(ddlResult, 'SHOW CREATE query')[0]?.[1], 'object SQL'),
    };
  }

  async getRelationshipGraph(): Promise<RelationshipGraph> {
    const pool = this.requirePool();
    const database = this.requireDatabase();
    const tablesResult = await pool.query(
      `SELECT TABLE_NAME, TABLE_TYPE
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME`,
      [database],
    );
    const columnsResult = await pool.query(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, ORDINAL_POSITION
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [database],
    );
    const primaryKeysResult = await pool.query(
      `SELECT TABLE_NAME, COLUMN_NAME, SEQ_IN_INDEX
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND INDEX_NAME = 'PRIMARY'
        ORDER BY TABLE_NAME, SEQ_IN_INDEX`,
      [database],
    );
    const relationshipsResult = await pool.query(
      `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME,
              k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, k.ORDINAL_POSITION,
              r.UPDATE_RULE, r.DELETE_RULE
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
          AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_SCHEMA = ?
          AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [database, database],
    );

    const tableRows = expectRows(tablesResult, 'Relationship tables query');
    const tableNames = new Set(tableRows
      .filter((row) => row[1] === 'BASE TABLE')
      .map((row) => requireCellString(row[0], 'table name')));
    const primaryKeyOrder = new Map<string, number>();
    for (const row of expectRows(primaryKeysResult, 'Relationship primary keys query')) {
      const tableName = requireCellString(row[0], 'primary key table');
      const columnName = requireCellString(row[1], 'primary key column');
      primaryKeyOrder.set(columnKey(tableName, columnName), requirePositiveInteger(row[2], 'primary key order'));
    }

    const relationshipRows = expectRows(relationshipsResult, 'Relationships query');
    const foreignColumns = new Set<string>();
    const relationships = new Map<string, RelationshipGraph['relationships'][number]>();
    for (const row of relationshipRows) {
      const fromTable = requireCellString(row[0], 'foreign key table');
      const constraintName = requireCellString(row[1], 'foreign key constraint');
      const from = requireCellString(row[2], 'foreign key column');
      const toTable = requireCellString(row[3], 'referenced table');
      const to = requireCellString(row[4], 'referenced column');
      if (!tableNames.has(fromTable) || !tableNames.has(toTable)) continue;
      foreignColumns.add(columnKey(fromTable, from));
      const id = `${fromTable}:${constraintName}`;
      const relationship = relationships.get(id) ?? {
        id,
        fromTable,
        toTable,
        columns: [],
        onUpdate: requireCellString(row[6], 'foreign key update rule'),
        onDelete: requireCellString(row[7], 'foreign key delete rule'),
      };
      relationship.columns.push({ from, to });
      relationships.set(id, relationship);
    }

    const columnsByTable = new Map<string, RelationshipGraph['tables'][number]['columns']>();
    for (const row of expectRows(columnsResult, 'Relationship columns query')) {
      const tableName = requireCellString(row[0], 'column table');
      if (!tableNames.has(tableName)) continue;
      const name = requireCellString(row[1], 'column name');
      const columns = columnsByTable.get(tableName) ?? [];
      columns.push({
        name,
        type: requireCellString(row[2], 'column type'),
        primaryKeyOrder: primaryKeyOrder.get(columnKey(tableName, name)) ?? 0,
        foreignKey: foreignColumns.has(columnKey(tableName, name)),
      });
      columnsByTable.set(tableName, columns);
    }

    return {
      tables: [...tableNames]
        .sort(compareNames)
        .map((name) => ({ name, kind: 'table' as const, columns: columnsByTable.get(name) ?? [] })),
      relationships: [...relationships.values()].sort((left, right) => compareNames(left.id, right.id)),
    };
  }

  async getRows(input: unknown): Promise<RowsResult> {
    if (!isRecord(input) || typeof input.name !== 'string' || input.name.trim() === '') {
      throw new MysqlWorkbenchError('INVALID_INPUT', 'name must be a non-empty string');
    }
    let pagination;
    try {
      pagination = parsePageInput(input);
    } catch (error) {
      throw new MysqlWorkbenchError('INVALID_INPUT', errorMessage(error));
    }

    const name = input.name;
    const schema = await this.getObjectSchema({ name });
    const tableName = quoteIdentifier(name);
    const countResult = await this.requirePool().query(`SELECT COUNT(*) AS total FROM ${tableName}`);
    const countRows = expectRows(countResult, 'Count query');
    const total = parseSafeCount(countRows[0]?.[0]);
    const orderBy = schema.primaryKey.length > 0
      ? ` ORDER BY ${schema.primaryKey.map(quoteIdentifier).join(', ')}`
      : '';
    const dataResult = await this.requirePool().query(
      `SELECT * FROM ${tableName}${orderBy} LIMIT ? OFFSET ?`,
      [pagination.pageSize, pagination.offset],
    );
    if (dataResult.kind !== 'rows') {
      throw new MysqlWorkbenchError('MYSQL_ERROR', 'Data query did not return rows');
    }
    const columns = dataResult.fields.map((field) => field.name);
    const primaryPositions = schema.primaryKey.map((key) => columns.indexOf(key));
    if (schema.rowEditable && primaryPositions.some((position) => position < 0)) {
      throw new MysqlWorkbenchError('MYSQL_ERROR', 'Data query did not return every primary-key column');
    }

    const rows = dataResult.rows.map((row) => {
      const values = row.map((value, index) => {
        const field = dataResult.fields[index];
        if (!field) throw new MysqlWorkbenchError('MYSQL_ERROR', 'MySQL returned an unnamed column');
        return serializeMysqlValue(value, field.mysqlType);
      });
      const identity = schema.rowEditable
        ? {
            kind: 'primary-key' as const,
            values: Object.fromEntries(
              schema.primaryKey.map((key, index) => [key, values[primaryPositions[index]]]),
            ),
          }
        : null;
      return { values, identity };
    });

    return {
      name,
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      insertable: schema.insertable,
      rowEditable: schema.rowEditable,
      columns,
      rows,
    };
  }

  async insertRow(input: unknown): Promise<{
    changes: number;
    insertId: string;
    warningStatus: number;
  }> {
    const parsed = await this.parseWriteInput(input, 'insertRow');
    if (!parsed.schema.insertable) {
      throw new MysqlWorkbenchError('READ_ONLY_OBJECT', 'Views do not accept generated inserts');
    }
    const entries = this.parseWriteValues(parsed.schema, parsed.values);
    const sql = entries.length === 0
      ? `INSERT INTO ${quoteIdentifier(parsed.name)} () VALUES ()`
      : `INSERT INTO ${quoteIdentifier(parsed.name)} (${entries.map(([name]) => quoteIdentifier(name)).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`;
    const result = await this.runTransaction((connection) =>
      connection.query(sql, entries.map(([, value]) => value)),
    );
    if (result.kind !== 'mutation') {
      throw new MysqlWorkbenchError('MYSQL_ERROR', 'INSERT did not return a mutation result');
    }
    return {
      changes: result.affectedRows,
      insertId: result.insertId,
      warningStatus: result.warningStatus,
    };
  }

  async updateRow(input: unknown): Promise<{ changes: number; warningStatus: number }> {
    const parsed = await this.parseWriteInput(input, 'updateRow');
    this.requireRowEditable(parsed.schema);
    const entries = this.parseWriteValues(parsed.schema, parsed.values);
    if (entries.length === 0) {
      throw new MysqlWorkbenchError('INVALID_INPUT', 'updateRow requires at least one value');
    }
    const identityValues = parseIdentity(input, parsed.schema);
    const sql = `UPDATE ${quoteIdentifier(parsed.name)} SET ${entries
      .map(([name]) => `${quoteIdentifier(name)} = ?`).join(', ')} WHERE ${parsed.schema.primaryKey
      .map((name) => `${quoteIdentifier(name)} = ?`).join(' AND ')}`;
    return this.runTransaction(async (connection) => {
      const result = await connection.query(sql, [
        ...entries.map(([, value]) => value),
        ...identityValues,
      ]);
      return mutationWithExactRow(result, 'UPDATE');
    });
  }

  async deleteRow(input: unknown): Promise<{ changes: number; warningStatus: number }> {
    const parsed = await this.parseWriteInput(input, 'deleteRow', false);
    this.requireRowEditable(parsed.schema);
    const identityValues = parseIdentity(input, parsed.schema);
    const sql = `DELETE FROM ${quoteIdentifier(parsed.name)} WHERE ${parsed.schema.primaryKey
      .map((name) => `${quoteIdentifier(name)} = ?`).join(' AND ')}`;
    return this.runTransaction(async (connection) => {
      const result = await connection.query(sql, identityValues);
      return mutationWithExactRow(result, 'DELETE');
    });
  }

  async executeSql(input: unknown): Promise<SqlExecutionResult> {
    if (!isRecord(input) || typeof input.sql !== 'string' || input.sql.trim() === '') {
      throw new MysqlWorkbenchError('INVALID_INPUT', 'sql must be a non-empty string');
    }
    const started = performance.now();
    try {
      const result = await this.requirePool().query(input.sql.trim());
      const elapsedMs = performance.now() - started;
      if (result.kind === 'mutation') {
        return {
          kind: 'mutation',
          affectedRows: result.affectedRows,
          insertId: result.insertId,
          warningStatus: result.warningStatus,
          elapsedMs,
        };
      }
      const serializedRows = result.rows.slice(0, 500).map((row) =>
        row.map((value, index) => {
          const field = result.fields[index];
          if (!field) throw new MysqlWorkbenchError('MYSQL_ERROR', 'MySQL returned an unnamed column');
          return serializeMysqlValue(value, field.mysqlType);
        }),
      );
      return {
        kind: 'rows',
        columns: result.fields.map((field) => field.name),
        rows: serializedRows,
        truncated: result.rows.length > 500,
        elapsedMs,
      };
    } catch (error) {
      throw normalizeMysqlError(error);
    }
  }

  private requirePool(): MysqlPool {
    if (!this.pool) throw new MysqlWorkbenchError('NOT_CONNECTED', 'Connect to a MySQL server first');
    return this.pool;
  }

  private async parseWriteInput(
    input: unknown,
    action: string,
    requireValues = true,
  ): Promise<{
    name: string;
    values: Record<string, unknown>;
    schema: ObjectSchema;
  }> {
    if (!isRecord(input) || typeof input.name !== 'string' || input.name.trim() === '') {
      throw new MysqlWorkbenchError('INVALID_INPUT', `${action} requires a non-empty name`);
    }
    if (requireValues && !isRecord(input.values)) {
      throw new MysqlWorkbenchError('INVALID_INPUT', `${action} values must be an object`);
    }
    return {
      name: input.name,
      values: isRecord(input.values) ? input.values : {},
      schema: await this.getObjectSchema({ name: input.name }),
    };
  }

  private parseWriteValues(
    schema: ObjectSchema,
    values: Record<string, unknown>,
  ): Array<[string, DatabaseValue]> {
    return Object.entries(values).map(([name, value]) => {
      const column = schema.columns.find((candidate) => candidate.name === name);
      if (!column) {
        throw new MysqlWorkbenchError('INVALID_INPUT', `Unknown column: ${name}`);
      }
      if (column.generated) {
        throw new MysqlWorkbenchError('INVALID_INPUT', `Generated column is not editable: ${name}`);
      }
      if (column.binary) {
        throw new MysqlWorkbenchError('INVALID_INPUT', `Binary column is preview-only: ${name}`);
      }
      try {
        return [name, deserializeEditableValue(value)];
      } catch (error) {
        throw new MysqlWorkbenchError('INVALID_INPUT', `${name}: ${errorMessage(error)}`);
      }
    });
  }

  private requireRowEditable(schema: ObjectSchema): void {
    if (!schema.rowEditable) {
      throw new MysqlWorkbenchError(
        'READ_ONLY_OBJECT',
        schema.type === 'view'
          ? 'Views are read-only'
          : 'Update and delete require a non-binary primary key',
      );
    }
  }

  private async runTransaction<T>(
    operation: (connection: MysqlConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.requirePool().getConnection();
    let began = false;
    try {
      await connection.beginTransaction();
      began = true;
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      if (began) {
        try {
          await connection.rollback();
        } catch {
          // Preserve the original operation error.
        }
      }
      throw normalizeMysqlError(error);
    } finally {
      connection.release();
    }
  }

  private requireDatabase(): string {
    if (!this.database) throw new MysqlWorkbenchError('NOT_CONNECTED', 'Select a MySQL database first');
    return this.database;
  }

  private async resolveObject(name: string): Promise<ResolvedObject> {
    const result = await this.requirePool().query(
      `SELECT TABLE_NAME, TABLE_TYPE
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
        LIMIT 1`,
      [this.requireDatabase(), name],
    );
    const row = expectRows(result, 'Object query')[0];
    if (!row) throw new MysqlWorkbenchError('INVALID_OBJECT', `MySQL object does not exist: ${name}`);
    return {
      name: requireCellString(row[0], 'object name'),
      type: row[1] === 'VIEW' ? 'view' : 'table',
    };
  }
}

function normalizeColumns(rows: unknown[][]): ColumnSchema[] {
  return rows.map((row) => {
    const extra = optionalCellString(row[4]);
    const generatedExpression = optionalCellString(row[5]);
    const dataType = requireCellString(row[7], 'column data type').toLowerCase();
    const characterSet = row[8] === null ? null : optionalCellString(row[8]).toLowerCase();
    return {
      name: requireCellString(row[0], 'column name'),
      type: requireCellString(row[1], 'column type'),
      nullable: row[2] === 'YES',
      defaultValue: row[3] === null ? null : String(row[3]),
      extra,
      generatedExpression,
      generated: generatedExpression !== '' || extra.toLowerCase().includes('generated'),
      autoIncrement: extra.toLowerCase().includes('auto_increment'),
      binary: characterSet === 'binary' || dataType.includes('binary') || dataType.includes('blob'),
    };
  });
}

function columnKey(tableName: string, columnName: string): string {
  return `${tableName}\u0000${columnName}`;
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, 'en', { sensitivity: 'base' }) || left.localeCompare(right, 'en');
}

function requirePositiveInteger(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new MysqlWorkbenchError('MYSQL_ERROR', `MySQL returned an invalid ${name}`);
  }
  return number;
}

function normalizeIndexes(rows: unknown[][]): IndexSchema[] {
  const grouped = new Map<string, IndexSchema>();
  for (const row of rows) {
    const name = requireCellString(row[0], 'index name');
    let index = grouped.get(name);
    if (!index) {
      index = {
        name,
        unique: Number(row[1]) === 0,
        primary: name === 'PRIMARY',
        type: optionalCellString(row[5]),
        columns: [],
        prefixLengths: [],
      };
      grouped.set(name, index);
    }
    index.columns.push(requireCellString(row[3], 'index column'));
    index.prefixLengths.push(row[4] === null ? null : Number(row[4]));
  }
  return [...grouped.values()];
}

function normalizeForeignKeys(rows: unknown[][]): ForeignKeySchema[] {
  return rows.map((row) => ({
    name: requireCellString(row[0], 'foreign key name'),
    column: requireCellString(row[1], 'foreign key column'),
    referencedTable: requireCellString(row[2], 'referenced table'),
    referencedColumn: requireCellString(row[3], 'referenced column'),
    onUpdate: requireCellString(row[5], 'foreign key update rule'),
    onDelete: requireCellString(row[6], 'foreign key delete rule'),
  }));
}

function parseIdentity(input: unknown, schema: ObjectSchema): DatabaseValue[] {
  if (!isRecord(input) || !isRecord(input.identity)) {
    throw new MysqlWorkbenchError('INVALID_INPUT', 'A primary-key identity is required');
  }
  const identity = input.identity;
  if (identity.kind !== 'primary-key' || !isRecord(identity.values)) {
    throw new MysqlWorkbenchError('INVALID_INPUT', 'A primary-key identity is required');
  }
  const values = identity.values;
  const suppliedKeys = Object.keys(values).sort();
  const expectedKeys = [...schema.primaryKey].sort();
  if (suppliedKeys.length !== expectedKeys.length
      || suppliedKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new MysqlWorkbenchError('INVALID_INPUT', 'Identity must contain every primary-key column');
  }
  return schema.primaryKey.map((name) => deserializeIdentityValue(values[name], name));
}

function deserializeIdentityValue(value: unknown, name: string): DatabaseValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MysqlWorkbenchError('INVALID_INPUT', `Identity ${name} must be finite`);
    }
    return value;
  }
  if (isRecord(value) && typeof value.type === 'string' && typeof value.value === 'string') {
    if (value.type === 'integer'
        || value.type === 'decimal'
        || value.type === 'date'
        || value.type === 'time'
        || value.type === 'datetime'
        || value.type === 'timestamp'
        || value.type === 'json') {
      return value.value;
    }
  }
  throw new MysqlWorkbenchError('INVALID_INPUT', `Identity ${name} is not editable`);
}

function mutationWithExactRow(
  result: DriverResult,
  operation: 'UPDATE' | 'DELETE',
): { changes: number; warningStatus: number } {
  if (result.kind !== 'mutation') {
    throw new MysqlWorkbenchError('MYSQL_ERROR', `${operation} did not return a mutation result`);
  }
  if (result.affectedRows !== 1) {
    throw new MysqlWorkbenchError(
      'STALE_ROW',
      `${operation} expected one row but changed ${result.affectedRows}`,
    );
  }
  return { changes: result.affectedRows, warningStatus: result.warningStatus };
}

function parseSafeCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new MysqlWorkbenchError('UNSUPPORTED_VALUE', 'Row count exceeds the supported range');
  }
  return parsed;
}

function expectRows(result: DriverResult, context: string): unknown[][] {
  if (result.kind !== 'rows') {
    throw new MysqlWorkbenchError('MYSQL_ERROR', `${context} did not return rows`);
  }
  return result.rows;
}

function requireCellString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new MysqlWorkbenchError('MYSQL_ERROR', `MySQL returned an invalid ${name}`);
  }
  return value;
}

function nullableCellString(value: unknown, name: string): string | null {
  return value === null ? null : requireCellString(value, name);
}

function optionalCellString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function normalizeMysqlError(error: unknown): MysqlWorkbenchError {
  if (error instanceof MysqlWorkbenchError) return error;
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  if (code === 'ER_ACCESS_DENIED_ERROR') {
    return new MysqlWorkbenchError('AUTH_FAILED', 'MySQL authentication failed');
  }
  if (code === 'ER_BAD_DB_ERROR') {
    return new MysqlWorkbenchError('DATABASE_NOT_FOUND', 'MySQL database does not exist');
  }
  if (code === 'ECONNREFUSED'
      || code === 'ENOTFOUND'
      || code === 'EHOSTUNREACH'
      || code === 'PROTOCOL_CONNECTION_LOST') {
    return new MysqlWorkbenchError('HOST_UNREACHABLE', 'MySQL host is unreachable');
  }
  if (code === 'ETIMEDOUT' || code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
    return new MysqlWorkbenchError('CONNECTION_TIMEOUT', 'MySQL connection timed out');
  }
  if (code.includes('CERT')
      || code.includes('SSL')
      || code.includes('TLS')
      || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
      || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return new MysqlWorkbenchError('TLS_FAILED', 'MySQL TLS verification failed');
  }
  if (code === 'ER_DBACCESS_DENIED_ERROR'
      || code === 'ER_TABLEACCESS_DENIED_ERROR'
      || code === 'ER_COLUMNACCESS_DENIED_ERROR'
      || code === 'ER_SPECIFIC_ACCESS_DENIED_ERROR'
      || code === 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR') {
    return new MysqlWorkbenchError('PERMISSION_DENIED', 'MySQL account does not have permission');
  }
  if (code === 'ER_DUP_ENTRY'
      || code === 'ER_NO_REFERENCED_ROW_2'
      || code === 'ER_ROW_IS_REFERENCED_2'
      || code === 'ER_CHECK_CONSTRAINT_VIOLATED'
      || code === 'ER_BAD_NULL_ERROR') {
    return new MysqlWorkbenchError('CONSTRAINT_FAILED', 'MySQL rejected the value because of a constraint');
  }
  if (code === 'ER_LOCK_DEADLOCK') {
    return new MysqlWorkbenchError('DEADLOCK', 'MySQL rolled back the transaction because of a deadlock');
  }
  if (code === 'ER_LOCK_WAIT_TIMEOUT') {
    return new MysqlWorkbenchError('LOCK_TIMEOUT', 'MySQL lock wait timed out');
  }
  if (code === 'ER_PARSE_ERROR' || code === 'ER_SYNTAX_ERROR') {
    return new MysqlWorkbenchError('SQL_SYNTAX_ERROR', 'MySQL could not parse the SQL statement');
  }
  return new MysqlWorkbenchError('MYSQL_ERROR', 'MySQL operation failed');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function endQuietly(pool: MysqlPool): Promise<void> {
  try {
    await pool.end();
  } catch {
    // The active replacement/previous connection state is already deterministic.
  }
}
