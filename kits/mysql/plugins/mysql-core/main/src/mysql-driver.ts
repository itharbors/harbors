import {
  createPool,
  type FieldPacket,
  type Pool as RawPool,
  type PoolConnection as RawConnection,
  type PoolOptions,
} from 'mysql2/promise';
import type { ConnectionInput } from './protocol.js';

export type DriverField = {
  name: string;
  mysqlType: string;
};

export type DriverResult =
  | { kind: 'rows'; rows: unknown[][]; fields: DriverField[] }
  | { kind: 'mutation'; affectedRows: number; insertId: string; warningStatus: number };

export interface MysqlExecutor {
  query(sql: string, values?: readonly unknown[]): Promise<DriverResult>;
}

export interface MysqlConnection extends MysqlExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface MysqlPool extends MysqlExecutor {
  getConnection(): Promise<MysqlConnection>;
  end(): Promise<void>;
}

export interface MysqlDriver {
  createPool(input: ConnectionInput): MysqlPool;
}

export type MysqlPoolFactory = (options: PoolOptions) => RawPool;

const MYSQL_TYPE_NAMES: Record<number, string> = {
  0x00: 'DECIMAL',
  0x01: 'TINY',
  0x02: 'SHORT',
  0x03: 'LONG',
  0x04: 'FLOAT',
  0x05: 'DOUBLE',
  0x06: 'NULL',
  0x07: 'TIMESTAMP',
  0x08: 'LONGLONG',
  0x09: 'INT24',
  0x0a: 'DATE',
  0x0b: 'TIME',
  0x0c: 'DATETIME',
  0x0d: 'YEAR',
  0x0e: 'NEWDATE',
  0x0f: 'VARCHAR',
  0x10: 'BIT',
  0xf2: 'VECTOR',
  0xf5: 'JSON',
  0xf6: 'NEWDECIMAL',
  0xf7: 'ENUM',
  0xf8: 'SET',
  0xf9: 'TINY_BLOB',
  0xfa: 'MEDIUM_BLOB',
  0xfb: 'LONG_BLOB',
  0xfc: 'BLOB',
  0xfd: 'VAR_STRING',
  0xfe: 'STRING',
  0xff: 'GEOMETRY',
};

const UNSIGNED_FLAG = 32;

export class Mysql2Driver implements MysqlDriver {
  constructor(private readonly poolFactory: MysqlPoolFactory = createPool) {}

  createPool(input: ConnectionInput): MysqlPool {
    const raw = this.poolFactory({
      host: input.host,
      port: input.port,
      user: input.user,
      password: input.password,
      ...(input.database === null ? {} : { database: input.database }),
      connectionLimit: 4,
      connectTimeout: 10_000,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      dateStrings: true,
      jsonStrings: true,
      rowsAsArray: true,
      ...(input.tls ? { ssl: { rejectUnauthorized: true } } : {}),
    });
    return new Mysql2PoolAdapter(raw);
  }
}

class Mysql2PoolAdapter implements MysqlPool {
  constructor(private readonly raw: RawPool) {}

  query(sql: string, values?: readonly unknown[]): Promise<DriverResult> {
    return runQuery(this.raw, sql, values);
  }

  async getConnection(): Promise<MysqlConnection> {
    return new Mysql2ConnectionAdapter(await this.raw.getConnection());
  }

  async end(): Promise<void> {
    await this.raw.end();
  }
}

class Mysql2ConnectionAdapter implements MysqlConnection {
  constructor(private readonly raw: RawConnection) {}

  query(sql: string, values?: readonly unknown[]): Promise<DriverResult> {
    return runQuery(this.raw, sql, values);
  }

  async beginTransaction(): Promise<void> {
    await this.raw.beginTransaction();
  }

  async commit(): Promise<void> {
    await this.raw.commit();
  }

  async rollback(): Promise<void> {
    await this.raw.rollback();
  }

  release(): void {
    this.raw.release();
  }
}

async function runQuery(
  executor: Pick<RawPool, 'query'> | Pick<RawConnection, 'query'>,
  sql: string,
  values?: readonly unknown[],
): Promise<DriverResult> {
  const [rows, fields] = await executor.query(
    { sql, rowsAsArray: true },
    values ? [...values] : undefined,
  );

  if (Array.isArray(rows)) {
    if (!Array.isArray(fields) || (fields.length > 0 && Array.isArray(fields[0]))) {
      throw new Error('MySQL multiple result sets are not supported');
    }
    return {
      kind: 'rows',
      rows: rows as unknown[][],
      fields: (fields as FieldPacket[]).map((field) => ({
        name: field.name,
        mysqlType: mysqlTypeName(field),
      })),
    };
  }

  const header = rows as {
    affectedRows?: number;
    insertId?: number | string;
    warningStatus?: number;
  };
  return {
    kind: 'mutation',
    affectedRows: header.affectedRows ?? 0,
    insertId: String(header.insertId ?? 0),
    warningStatus: header.warningStatus ?? 0,
  };
}

function mysqlTypeName(field: FieldPacket): string {
  const numericType = field.columnType ?? field.type;
  let typeName = field.typeName ?? (numericType === undefined ? undefined : MYSQL_TYPE_NAMES[numericType]);
  typeName ??= 'UNKNOWN';
  const unsigned = typeof field.flags === 'number'
    ? (field.flags & UNSIGNED_FLAG) !== 0
    : field.flags.includes('UNSIGNED');
  if (typeName === 'LONGLONG' && unsigned) typeName += ' UNSIGNED';
  return typeName;
}
