import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteService } from '../main/src/sqlite-service';

describe('SqliteService connection and schema', () => {
  let tempDir: string;
  let dbPath: string;
  let service: SqliteService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-kit-'));
    dbPath = path.join(tempDir, 'fixture.sqlite');
    const fixture = new Database(dbPath);
    fixture.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        score REAL DEFAULT 0,
        note TEXT,
        payload BLOB
      );
      CREATE VIEW active_users AS
        SELECT id, email FROM users WHERE score > 0;
      CREATE INDEX users_score_idx ON users(score);
      CREATE TABLE keyed (
        region TEXT NOT NULL,
        code TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (region, code)
      ) WITHOUT ROWID;
      CREATE TABLE loose_items (label TEXT, amount INTEGER);
      INSERT INTO users (id, email, score, note, payload) VALUES
        (1, 'a@example.com', 2.5, NULL, X'00FF'),
        (9007199254740993, 'big@example.com', 0, '', NULL);
      INSERT INTO keyed (region, code, value) VALUES
        ('north', 'A', 'first'),
        ('south', 'B', 'second');
      INSERT INTO loose_items (label, amount) VALUES ('loose', 7);
    `);
    fixture.close();
    service = new SqliteService();
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('opens a database and reports its connection state', () => {
    expect(service.getConnectionState()).toEqual({
      connected: false,
      path: null,
      sqliteVersion: null,
    });

    const state = service.openDatabase({ path: dbPath, create: false });

    expect(state).toMatchObject({
      connected: true,
      path: path.resolve(dbPath),
    });
    expect(state.sqliteVersion).toMatch(/^3\./);
    expect(service.getConnectionState()).toEqual(state);
  });

  it('returns tables and views in name order', () => {
    service.openDatabase({ path: dbPath, create: false });

    expect(service.getSchema()).toEqual({
      objects: [
        expect.objectContaining({ name: 'active_users', type: 'view', writable: false }),
        expect.objectContaining({ name: 'keyed', type: 'table', writable: true }),
        expect.objectContaining({ name: 'loose_items', type: 'table', writable: true }),
        expect.objectContaining({ name: 'users', type: 'table', writable: true }),
      ],
    });
  });

  it('returns columns, primary keys, indexes, and rowid capability', () => {
    service.openDatabase({ path: dbPath, create: false });

    const users = service.getObjectSchema({ name: 'users' });
    expect(users).toMatchObject({
      name: 'users',
      type: 'table',
      writable: true,
      hasRowid: true,
      primaryKey: ['id'],
    });
    expect(users.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'email', type: 'TEXT', notNull: true, hidden: false }),
      expect.objectContaining({ name: 'score', type: 'REAL', defaultValue: '0' }),
    ]));
    expect(users.indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'users_score_idx', columns: ['score'], unique: false }),
      expect.objectContaining({ columns: ['email'], unique: true }),
    ]));

    const keyed = service.getObjectSchema({ name: 'keyed' });
    expect(keyed.primaryKey).toEqual(['region', 'code']);
    expect(keyed.hasRowid).toBe(false);

    const view = service.getObjectSchema({ name: 'active_users' });
    expect(view).toMatchObject({ type: 'view', writable: false, hasRowid: false });
    expect(view.sql).toContain('CREATE VIEW active_users');
  });

  it('creates a missing database only when explicitly requested', () => {
    const newPath = path.join(tempDir, 'new.sqlite');

    expect(() => service.openDatabase({ path: newPath, create: false })).toThrow(/does not exist/i);
    expect(fs.existsSync(newPath)).toBe(false);

    expect(service.openDatabase({ path: newPath, create: true })).toMatchObject({
      connected: true,
      path: path.resolve(newPath),
    });
    expect(fs.existsSync(newPath)).toBe(true);
    expect(() => service.openDatabase({ path: dbPath, create: true })).toThrow(/already exists/i);
  });

  it('preserves the current connection when a switch fails', () => {
    service.openDatabase({ path: dbPath, create: false });
    const missingPath = path.join(tempDir, 'missing', 'new.sqlite');

    expect(() => service.openDatabase({ path: missingPath, create: true })).toThrow(/parent directory/i);
    expect(service.getConnectionState().path).toBe(path.resolve(dbPath));
    expect(service.getSchema().objects.map((item) => item.name)).toContain('users');
  });

  it('rejects directories and invalid database files', () => {
    expect(() => service.openDatabase({ path: tempDir, create: false })).toThrow(/not a file/i);

    const invalidPath = path.join(tempDir, 'invalid.sqlite');
    fs.writeFileSync(invalidPath, 'not a sqlite database');
    expect(() => service.openDatabase({ path: invalidPath, create: false })).toThrow(/SQLITE_NOTADB|database/i);
  });

  it('requires a connection and closes idempotently', () => {
    expect(() => service.getSchema()).toThrow(/NOT_CONNECTED/);

    service.openDatabase({ path: dbPath, create: false });
    expect(service.closeDatabase()).toEqual({ connected: false, path: null, sqliteVersion: null });
    expect(service.closeDatabase()).toEqual({ connected: false, path: null, sqliteVersion: null });
  });

  it('reads bounded pages with JSON-safe values and primary-key identities', () => {
    service.openDatabase({ path: dbPath, create: false });

    const page = service.getRows({ name: 'users', page: 1, pageSize: 25 });

    expect(page).toMatchObject({
      page: 1,
      pageSize: 25,
      total: 2,
      writable: true,
      columns: ['id', 'email', 'score', 'note', 'payload'],
    });
    expect(page.rows[0]).toEqual({
      values: [
        { type: 'integer', value: '1' },
        'a@example.com',
        2.5,
        null,
        { type: 'blob', size: 2, previewHex: '00ff' },
      ],
      identity: {
        kind: 'primary-key',
        values: { id: { type: 'integer', value: '1' } },
      },
    });
    expect(page.rows[1].values[0]).toEqual({
      type: 'integer',
      value: '9007199254740993',
    });
  });

  it('uses composite keys and rowid identities, while keeping views read-only', () => {
    service.openDatabase({ path: dbPath, create: false });

    expect(service.getRows({ name: 'keyed', page: 1, pageSize: 25 }).rows[0].identity).toEqual({
      kind: 'primary-key',
      values: { region: 'north', code: 'A' },
    });
    expect(service.getRows({ name: 'loose_items', page: 1, pageSize: 25 }).rows[0].identity).toEqual({
      kind: 'rowid',
      value: { type: 'integer', value: '1' },
    });
    expect(service.getRows({ name: 'active_users', page: 1, pageSize: 25 })).toMatchObject({
      writable: false,
      rows: [{ identity: null }],
    });
  });

  it('paginates and returns schema columns for an empty page', () => {
    service.openDatabase({ path: dbPath, create: false });

    expect(service.getRows({ name: 'users', page: 2, pageSize: 25 })).toMatchObject({
      page: 2,
      total: 2,
      columns: ['id', 'email', 'score', 'note', 'payload'],
      rows: [],
    });
    expect(() => service.getRows({ name: 'users', page: 1, pageSize: 500 })).toThrow(/pageSize/);
  });

  it('inserts, updates, and deletes a primary-key row', () => {
    service.openDatabase({ path: dbPath, create: false });

    expect(service.insertRow({
      name: 'users',
      values: {
        email: { type: 'text', value: 'new@example.com' },
        score: { type: 'real', value: '3.5' },
        note: { type: 'null' },
      },
    })).toMatchObject({ changes: 1 });

    const inserted = service.getRows({ name: 'users', page: 1, pageSize: 25 }).rows
      .find((row) => row.values[1] === 'new@example.com');
    expect(inserted).toBeDefined();
    expect(service.updateRow({
      name: 'users',
      identity: inserted!.identity,
      values: { email: { type: 'text', value: 'changed@example.com' } },
    })).toEqual({ changes: 1 });
    expect(service.deleteRow({ name: 'users', identity: inserted!.identity })).toEqual({ changes: 1 });
    expect(service.getRows({ name: 'users', page: 1, pageSize: 25 }).total).toBe(2);
  });

  it('writes through composite-key and rowid identities', () => {
    service.openDatabase({ path: dbPath, create: false });
    const keyed = service.getRows({ name: 'keyed', page: 1, pageSize: 25 }).rows[0];
    const loose = service.getRows({ name: 'loose_items', page: 1, pageSize: 25 }).rows[0];

    expect(service.updateRow({
      name: 'keyed',
      identity: keyed.identity,
      values: { value: { type: 'text', value: 'changed' } },
    })).toEqual({ changes: 1 });
    expect(service.deleteRow({ name: 'loose_items', identity: loose.identity })).toEqual({ changes: 1 });
  });

  it('supports DEFAULT VALUES inserts and rejects unsafe writes', () => {
    service.openDatabase({ path: dbPath, create: false });
    const defaultTablePath = path.join(tempDir, 'defaults.sqlite');
    const defaults = new Database(defaultTablePath);
    defaults.exec('CREATE TABLE defaults (id INTEGER PRIMARY KEY, label TEXT DEFAULT \'ready\')');
    defaults.close();
    service.openDatabase({ path: defaultTablePath, create: false });

    expect(service.insertRow({ name: 'defaults', values: {} })).toMatchObject({ changes: 1 });
    expect(service.getRows({ name: 'defaults', page: 1, pageSize: 25 }).rows[0].values[1]).toBe('ready');
    expect(() => service.insertRow({
      name: 'defaults',
      values: { missing: { type: 'text', value: 'nope' } },
    })).toThrow(/column/i);
  });

  it('rolls back constraint failures and rejects views, blobs, and stale identities', () => {
    service.openDatabase({ path: dbPath, create: false });
    const first = service.getRows({ name: 'users', page: 1, pageSize: 25 }).rows[0];

    expect(() => service.insertRow({
      name: 'users',
      values: { email: { type: 'text', value: 'a@example.com' } },
    })).toThrow(/SQLITE_CONSTRAINT/);
    expect(service.getRows({ name: 'users', page: 1, pageSize: 25 }).total).toBe(2);
    expect(() => service.insertRow({
      name: 'users',
      values: { payload: { type: 'blob', value: '00ff' } },
    })).toThrow(/type/i);
    expect(() => service.insertRow({ name: 'active_users', values: {} })).toThrow(/READ_ONLY/);

    expect(service.deleteRow({ name: 'users', identity: first.identity })).toEqual({ changes: 1 });
    expect(() => service.deleteRow({ name: 'users', identity: first.identity })).toThrow(/STALE_ROW/);
  });

  it('rolls back foreign-key constraint failures', () => {
    const relationalPath = path.join(tempDir, 'relational.sqlite');
    const relational = new Database(relationalPath);
    relational.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE projects (id INTEGER PRIMARY KEY);
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id)
      );
    `);
    relational.close();
    service.openDatabase({ path: relationalPath, create: false });

    expect(() => service.insertRow({
      name: 'tasks',
      values: { project_id: { type: 'integer', value: '404' } },
    })).toThrow(/SQLITE_CONSTRAINT_FOREIGNKEY/);
    expect(service.getRows({ name: 'tasks', page: 1, pageSize: 25 }).total).toBe(0);
  });

  it('reports a locked database without partially writing', () => {
    service.openDatabase({ path: dbPath, create: false });
    service.executeSql({ sql: 'PRAGMA busy_timeout = 0' });
    const locker = new Database(dbPath);
    locker.exec('BEGIN EXCLUSIVE');

    try {
      expect(() => service.insertRow({
        name: 'users',
        values: { email: { type: 'text', value: 'locked@example.com' } },
      })).toThrow(/SQLITE_BUSY/);
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
    }

    expect(service.getRows({ name: 'users', page: 1, pageSize: 25 }).total).toBe(2);
  });

  it('executes a row-returning SQL statement with serialized values', () => {
    service.openDatabase({ path: dbPath, create: false });

    const result = service.executeSql({
      sql: 'SELECT id, email, payload FROM users ORDER BY id',
    });

    expect(result).toMatchObject({
      kind: 'rows',
      columns: ['id', 'email', 'payload'],
      truncated: false,
    });
    if (result.kind !== 'rows') throw new Error('Expected rows result');
    expect(result.rows[0]).toEqual([
      { type: 'integer', value: '1' },
      'a@example.com',
      { type: 'blob', size: 2, previewHex: '00ff' },
    ]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('executes mutations and DDL with a change summary', () => {
    service.openDatabase({ path: dbPath, create: false });

    expect(service.executeSql({
      sql: "UPDATE users SET score = 9 WHERE email = 'a@example.com'",
    })).toMatchObject({ kind: 'mutation', changes: 1 });
    expect(service.executeSql({
      sql: 'CREATE TABLE audit (id INTEGER)',
    })).toMatchObject({ kind: 'mutation', changes: 0 });
    expect(service.getSchema().objects.map((item) => item.name)).toContain('audit');
  });

  it('bounds SQL result sets at 500 rows', () => {
    service.openDatabase({ path: dbPath, create: false });

    const result = service.executeSql({
      sql: `
        WITH RECURSIVE numbers(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 501
        ) SELECT value FROM numbers
      `,
    });

    expect(result.kind).toBe('rows');
    if (result.kind !== 'rows') throw new Error('Expected rows result');
    expect(result.rows).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  it('rejects empty, malformed, and multiple SQL statements', () => {
    service.openDatabase({ path: dbPath, create: false });

    expect(() => service.executeSql({ sql: '' })).toThrow(/SQL/i);
    expect(() => service.executeSql({ sql: 'SELECT FROM' })).toThrow(/SQLITE_ERROR/);
    expect(() => service.executeSql({ sql: 'SELECT 1; SELECT 2' })).toThrow(/MULTIPLE_STATEMENTS/);
  });
});
