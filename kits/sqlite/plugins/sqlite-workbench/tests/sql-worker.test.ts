import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteService } from '../main/src/sqlite-service';

describe('SQLite cancellable SQL worker', () => {
  let tempDir: string;
  let dbPath: string;
  let service: SqliteService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-worker-'));
    dbPath = path.join(tempDir, 'worker.sqlite');
    const fixture = new Database(dbPath);
    fixture.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);
      INSERT INTO items (label) VALUES ('first'), ('second');
    `);
    fixture.close();
    service = new SqliteService();
    service.openDatabase({ path: dbPath, create: false });
  });

  afterEach(async () => {
    await service.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('executes readonly rows in a worker with a fifty-row page cap', async () => {
    const result = await service.executeSql({
      executionId: 'rows',
      sql: `WITH RECURSIVE n(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 51
      ) SELECT value FROM n`,
    });

    expect(result.kind).toBe('rows');
    if (result.kind !== 'rows') throw new Error('Expected rows');
    expect(result.rows).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(result.page).toBe(1);

    const secondPage = await service.executeSql({
      executionId: 'rows-page-2',
      page: 2,
      sql: `WITH RECURSIVE n(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 51
      ) SELECT value FROM n`,
    });
    expect(secondPage).toMatchObject({ kind: 'rows', page: 2, truncated: false });
    if (secondPage.kind !== 'rows') throw new Error('Expected rows');
    expect(secondPage.rows).toEqual([[{ type: 'integer', value: '51' }]]);
  });

  it('requires readwrite mode and a matching analysis token for writes', async () => {
    const readonlyAnalysis = service.analyzeSql({
      sql: "UPDATE items SET label = 'blocked' WHERE id = 1",
    });
    expect(readonlyAnalysis.confirmationToken).toBeNull();
    await expect(service.executeSql({
      executionId: 'blocked',
      sql: "UPDATE items SET label = 'blocked' WHERE id = 1",
    })).rejects.toThrow(/READ_ONLY/);

    service.setConnectionMode({ mode: 'readwrite' });
    const analysis = service.analyzeSql({
      sql: "UPDATE items SET label = 'changed' WHERE id = 1",
    });
    expect(analysis.confirmationToken).toEqual(expect.any(String));
    await expect(service.executeSql({
      executionId: 'write',
      sql: "UPDATE items SET label = 'changed' WHERE id = 1",
      confirmationToken: analysis.confirmationToken,
    })).resolves.toMatchObject({ kind: 'mutation', changes: 1 });

    const pragmaSql = 'PRAGMA user_version(123)';
    const pragmaAnalysis = service.analyzeSql({ sql: pragmaSql });
    expect(pragmaAnalysis).toMatchObject({ readonly: false, confirmationToken: expect.any(String) });
    await expect(service.executeSql({ executionId: 'pragma-blocked', sql: pragmaSql }))
      .rejects.toThrow(/INVALID_SQL_CONFIRMATION/);
    await expect(service.executeSql({
      executionId: 'pragma-write',
      sql: pragmaSql,
      confirmationToken: pragmaAnalysis.confirmationToken,
    })).resolves.toMatchObject({ kind: 'mutation' });

    const optimizeSql = 'PRAGMA optimize';
    const optimizeAnalysis = service.analyzeSql({ sql: optimizeSql });
    expect(optimizeAnalysis).toMatchObject({ readonly: false, confirmationToken: expect.any(String) });
    await expect(service.executeSql({ executionId: 'optimize-blocked', sql: optimizeSql }))
      .rejects.toThrow(/INVALID_SQL_CONFIRMATION/);
  });

  it('returns EXPLAIN QUERY PLAN rows without mutating', async () => {
    const result = await service.explainSql({
      executionId: 'explain',
      sql: 'SELECT * FROM items WHERE id = 1',
    });
    expect(result.kind).toBe('rows');
    if (result.kind !== 'rows') throw new Error('Expected rows');
    expect(result.columns).toEqual(expect.arrayContaining(['detail']));
  });

  it('cancels a long query and allows a later execution', async () => {
    const running = service.executeSql({
      executionId: 'long',
      sql: `WITH RECURSIVE forever(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM forever
      ) SELECT count(*) FROM forever`,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const cancelledExecution = expect(running).rejects.toThrow(/CANCELLED/);
    await expect(service.cancelSql({ executionId: 'long' })).resolves.toEqual({ cancelled: true });
    await cancelledExecution;
    await expect(service.executeSql({
      executionId: 'after-cancel',
      sql: 'SELECT 42 AS answer',
    })).resolves.toMatchObject({ kind: 'rows', truncated: false });
  });

  it('blocks connection transitions until active worker termination completes', async () => {
    const running = service.executeSql({
      executionId: 'transition-lock',
      sql: `WITH RECURSIVE forever(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM forever
      ) SELECT count(*) FROM forever`,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(() => service.setConnectionMode({ mode: 'readwrite' })).toThrow(/SQL_BUSY/);
    expect(() => service.closeDatabase()).toThrow(/SQL_BUSY/);
    const cancelledExecution = expect(running).rejects.toThrow(/CANCELLED/);
    await expect(service.cancelSql({ executionId: 'transition-lock' })).resolves.toEqual({ cancelled: true });
    await cancelledExecution;
    expect(service.setConnectionMode({ mode: 'readwrite' })).toMatchObject({ mode: 'readwrite' });
  });
});
