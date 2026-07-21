import { describe, expect, it, vi } from 'vitest';
import { Mysql2Driver } from '../main/src/mysql-driver';

describe('Mysql2Driver', () => {
  it('creates a safe pool and normalizes row results', async () => {
    const rawPool = createRawPool();
    rawPool.query.mockResolvedValueOnce([
      [[1, 'a']],
      [
        { name: 'id', columnType: 3, flags: 0 },
        { name: 'label', columnType: 253, flags: 0 },
      ],
    ]);
    const createPool = vi.fn(() => rawPool);
    const driver = new Mysql2Driver(createPool as never);

    const pool = driver.createPool({
      host: 'db.local',
      port: 3306,
      user: 'reader',
      password: 'secret',
      database: 'app',
      tls: true,
    });

    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
      host: 'db.local',
      port: 3306,
      user: 'reader',
      password: 'secret',
      database: 'app',
      connectionLimit: 4,
      connectTimeout: 10_000,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      dateStrings: true,
      jsonStrings: true,
      rowsAsArray: true,
      ssl: { rejectUnauthorized: true },
    }));
    await expect(pool.query('SELECT id, label FROM users')).resolves.toEqual({
      kind: 'rows',
      rows: [[1, 'a']],
      fields: [
        { name: 'id', mysqlType: 'LONG' },
        { name: 'label', mysqlType: 'VAR_STRING' },
      ],
    });
  });

  it('normalizes mutation results and delegates connection transactions', async () => {
    const rawPool = createRawPool();
    rawPool.query.mockResolvedValueOnce([
      { affectedRows: 2, insertId: 7, warningStatus: 1 },
      undefined,
    ]);
    const rawConnection = createRawConnection();
    rawPool.getConnection.mockResolvedValueOnce(rawConnection);
    const driver = new Mysql2Driver((() => rawPool) as never);
    const pool = driver.createPool({
      host: 'db', port: 3306, user: 'u', password: '', database: 'app', tls: false,
    });

    await expect(pool.query('UPDATE users SET active = 1')).resolves.toEqual({
      kind: 'mutation',
      affectedRows: 2,
      insertId: '7',
      warningStatus: 1,
    });
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.commit();
    await connection.rollback();
    connection.release();
    await pool.end();

    expect(rawConnection.beginTransaction).toHaveBeenCalledOnce();
    expect(rawConnection.commit).toHaveBeenCalledOnce();
    expect(rawConnection.rollback).toHaveBeenCalledOnce();
    expect(rawConnection.release).toHaveBeenCalledOnce();
    expect(rawPool.end).toHaveBeenCalledOnce();
  });

  it('omits the mysql2 database option for a server-level connection', () => {
    const rawPool = createRawPool();
    const createPool = vi.fn(() => rawPool);
    const driver = new Mysql2Driver(createPool as never);

    driver.createPool({
      host: 'db', port: 3306, user: 'u', password: 'secret', database: null, tls: false,
    });

    expect(createPool.mock.calls[0]?.[0]).not.toHaveProperty('database');
  });
});

function createRawPool() {
  return {
    query: vi.fn(),
    getConnection: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

function createRawConnection() {
  return {
    query: vi.fn(),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
}
