import type { ConnectionInput } from '../main/src/protocol.js';
import type {
  DriverField,
  DriverResult,
  MysqlConnection,
  MysqlDriver,
  MysqlPool,
} from '../main/src/mysql-driver.js';

export type QueryCall = {
  sql: string;
  values: readonly unknown[];
};

class FakeMysqlExecutor {
  readonly queries: QueryCall[] = [];
  private readonly results: Array<DriverResult | Error> = [];

  queueRows(rows: unknown[][], fields: DriverField[]): this {
    this.results.push({ kind: 'rows', rows, fields });
    return this;
  }

  queueMutation(affectedRows: number, insertId = '0', warningStatus = 0): this {
    this.results.push({ kind: 'mutation', affectedRows, insertId, warningStatus });
    return this;
  }

  queueError(error: Error): this {
    this.results.push(error);
    return this;
  }

  async query(sql: string, values: readonly unknown[] = []): Promise<DriverResult> {
    this.queries.push({ sql, values: [...values] });
    const result = this.results.shift();
    if (result === undefined) throw new Error(`No fake result queued for SQL: ${sql}`);
    if (result instanceof Error) throw result;
    return result;
  }
}

export class FakeMysqlDriver implements MysqlDriver {
  readonly inputs: ConnectionInput[] = [];
  readonly pools: FakeMysqlPool[] = [];
  private readonly queuedPools: FakeMysqlPool[] = [];

  queuePool(pool = new FakeMysqlPool()): FakeMysqlPool {
    this.queuedPools.push(pool);
    return pool;
  }

  createPool(input: ConnectionInput): MysqlPool {
    const pool = this.queuedPools.shift() ?? new FakeMysqlPool();
    this.inputs.push({ ...input });
    this.pools.push(pool);
    return pool;
  }
}

export class FakeMysqlPool extends FakeMysqlExecutor implements MysqlPool {
  endCalls = 0;
  endError: unknown;
  private readonly connections: FakeMysqlConnection[] = [];

  queueConnection(connection = new FakeMysqlConnection()): FakeMysqlConnection {
    this.connections.push(connection);
    return connection;
  }

  async getConnection(): Promise<MysqlConnection> {
    return this.connections.shift() ?? new FakeMysqlConnection();
  }

  async end(): Promise<void> {
    this.endCalls += 1;
    if (this.endError !== undefined) throw this.endError;
  }
}

export class FakeMysqlConnection extends FakeMysqlExecutor implements MysqlConnection {
  readonly transactionEvents: string[] = [];

  async beginTransaction(): Promise<void> {
    this.transactionEvents.push('begin');
  }

  async commit(): Promise<void> {
    this.transactionEvents.push('commit');
  }

  async rollback(): Promise<void> {
    this.transactionEvents.push('rollback');
  }

  release(): void {
    this.transactionEvents.push('release');
  }

  override async query(sql: string, values: readonly unknown[] = []): Promise<DriverResult> {
    this.transactionEvents.push('query');
    return super.query(sql, values);
  }
}
