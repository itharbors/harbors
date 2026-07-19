import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toPublicError, WorkbenchError } from '../main/src/protocol';
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
      CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE memberships (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id INTEGER NOT NULL REFERENCES teams(id),
        PRIMARY KEY (user_id, team_id)
      );
      CREATE TABLE user_events (user_id INTEGER, event TEXT);
      CREATE TABLE stable_items (
        code TEXT PRIMARY KEY,
        rank INTEGER NOT NULL,
        label TEXT,
        note TEXT
      );
      CREATE TABLE nullable_keys (
        code TEXT PRIMARY KEY,
        label TEXT NOT NULL
      );
      CREATE TABLE integer_desc_keys (
        id INTEGER PRIMARY KEY DESC,
        label TEXT NOT NULL
      );
      CREATE TRIGGER users_score_audit
        AFTER UPDATE OF score ON users
        BEGIN
          INSERT INTO user_events (user_id, event) VALUES (NEW.id, 'score-updated');
        END;
      CREATE VIRTUAL TABLE chunk_fts USING fts5(body);
      INSERT INTO users (id, email, score, note, payload) VALUES
        (1, 'a@example.com', 2.5, NULL, X'00FF'),
        (9007199254740993, 'big@example.com', 0, '', NULL);
      INSERT INTO keyed (region, code, value) VALUES
        ('north', 'A', 'first'),
        ('south', 'B', 'second');
      INSERT INTO loose_items (label, amount) VALUES ('loose', 7);
      INSERT INTO stable_items (code, rank, label, note) VALUES
        ('C', 2, 'Gamma', NULL),
        ('A', 1, 'Alpha', 'ready'),
        ('B', 1, 'Beta', NULL);
      INSERT INTO nullable_keys (code, label) VALUES
        (NULL, 'first-null'),
        (NULL, 'second-null'),
        ('A', 'named');
      INSERT INTO integer_desc_keys (id, label) VALUES
        (NULL, 'first-desc-null'),
        (NULL, 'second-desc-null'),
        (7, 'named');
    `);
    fixture.close();
    service = new SqliteService();
  });

  afterEach(async () => {
    await service.dispose();
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function openReadWrite(databasePath = dbPath): void {
    service.openDatabase({ path: databasePath, create: false });
    service.setConnectionMode({ mode: 'readwrite' });
  }

  it('opens a database and reports its connection state', () => {
    expect(service.getConnectionState()).toEqual({
      connected: false,
      path: null,
      fileName: null,
      mode: null,
      sqliteVersion: null,
      foreignKeys: null,
      busyTimeout: null,
    });

    const state = service.openDatabase({ path: dbPath, create: false });

    expect(state).toMatchObject({
      connected: true,
      path: fs.realpathSync(dbPath),
      fileName: 'fixture.sqlite',
      mode: 'readonly',
      foreignKeys: true,
      busyTimeout: 5000,
    });
    expect(state.sqliteVersion).toMatch(/^3\./);
    expect(service.getConnectionState()).toEqual(state);
  });

  it('classifies ordinary, view, virtual, and shadow objects in name order', () => {
    service.openDatabase({ path: dbPath, create: false });

    const objects = service.getSchema().objects;
    expect(objects.map((object) => object.name)).toEqual(
      objects.map((object) => object.name).sort((left, right) => (
        left.localeCompare(right, 'en', { sensitivity: 'base' })
      )),
    );
    expect(objects.find((object) => object.name === 'active_users')).toMatchObject({
      kind: 'view',
      type: 'view',
      writable: false,
      readOnlyReason: '视图不支持记录编辑。',
    });
    expect(objects.find((object) => object.name === 'chunk_fts')).toMatchObject({
      kind: 'virtual',
      writable: false,
      readOnlyReason: '虚拟表不支持记录编辑。',
    });
    expect(objects.find((object) => object.name === 'chunk_fts_config')).toMatchObject({
      kind: 'shadow',
      writable: false,
      readOnlyReason: 'SQLite 系统影子表不可编辑。',
    });
    expect(objects.find((object) => object.name === 'users')).toMatchObject({
      kind: 'table',
      writable: false,
      readOnlyReason: '当前连接为只读模式。',
    });
  });

  it('reopens the same database only after an explicit mode change', () => {
    service.openDatabase({ path: dbPath, create: false });

    expect(service.setConnectionMode({ mode: 'readwrite' })).toMatchObject({
      path: fs.realpathSync(dbPath),
      mode: 'readwrite',
    });
    expect(service.getSchema().objects.find((object) => object.name === 'users')).toMatchObject({
      writable: true,
      readOnlyReason: null,
    });
    expect(service.setConnectionMode({ mode: 'readonly' })).toMatchObject({ mode: 'readonly' });
  });

  it('preserves the current connection when a mode reopen fails', () => {
    service.openDatabase({ path: dbPath, create: false });
    const connectedPath = service.getConnectionState().path;
    const movedPath = path.join(tempDir, 'moved.sqlite');
    fs.renameSync(dbPath, movedPath);

    expect(() => service.setConnectionMode({ mode: 'readwrite' })).toThrow(/INVALID_PATH/);
    expect(service.getConnectionState()).toMatchObject({
      connected: true,
      path: connectedPath,
      mode: 'readonly',
    });
    expect(service.getSchema().objects.map((object) => object.name)).toContain('users');
  });

  it('returns columns, primary keys, indexes, and rowid capability', () => {
    openReadWrite();

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

  it('returns foreign keys and triggers with object details', () => {
    service.openDatabase({ path: dbPath, create: false });

    expect(service.getObjectSchema({ name: 'memberships' }).foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'user_id',
          table: 'users',
          to: 'id',
          onDelete: 'CASCADE',
        }),
      ]),
    );
    expect(service.getObjectSchema({ name: 'users' }).triggers).toEqual([
      expect.objectContaining({
        name: 'users_score_audit',
        sql: expect.stringContaining('AFTER UPDATE OF score'),
      }),
    ]);
  });

  it('creates a missing database only when explicitly requested', () => {
    const newPath = path.join(tempDir, 'new.sqlite');

    expect(() => service.openDatabase({ path: newPath, create: false })).toThrow(/INVALID_PATH/);
    expect(fs.existsSync(newPath)).toBe(false);

    expect(service.openDatabase({ path: newPath, create: true })).toMatchObject({
      connected: true,
      path: fs.realpathSync(newPath),
      mode: 'readwrite',
    });
    expect(fs.existsSync(newPath)).toBe(true);
    expect(() => service.openDatabase({ path: dbPath, create: true })).toThrow(/PATH_EXISTS/);
  });

  it('normalizes extensionless create targets through the controlled file policy', () => {
    const requestedPath = path.join(tempDir, 'notes');
    const normalizedPath = `${requestedPath}.sqlite`;

    expect(service.openDatabase({ path: requestedPath, create: true })).toMatchObject({
      connected: true,
      path: fs.realpathSync(normalizedPath),
      fileName: 'notes.sqlite',
      mode: 'readwrite',
    });
    expect(fs.existsSync(requestedPath)).toBe(false);
    expect(fs.existsSync(normalizedPath)).toBe(true);
  });

  it('never removes a file created by another process during create-target reservation', () => {
    const target = path.join(fs.realpathSync(tempDir), 'raced.sqlite');
    const originalOpen = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation((candidate, flags, mode) => {
      if (path.resolve(String(candidate)) === target && flags === 'wx') {
        fs.writeFileSync(target, 'owned-by-another-process');
      }
      return originalOpen(candidate, flags, mode);
    });

    expect(() => service.openDatabase({ path: target, create: true })).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('owned-by-another-process');
  });

  it('preserves the current connection when a switch fails', () => {
    service.openDatabase({ path: dbPath, create: false });
    const missingPath = path.join(tempDir, 'missing', 'new.sqlite');

    expect(() => service.openDatabase({ path: missingPath, create: true })).toThrow(/INVALID_PATH/);
    expect(service.getConnectionState().path).toBe(fs.realpathSync(dbPath));
    expect(service.getSchema().objects.map((item) => item.name)).toContain('users');
  });

  it('keeps normalized recent database paths for the current service session', () => {
    const secondPath = path.join(tempDir, 'second.sqlite');
    const second = new Database(secondPath);
    second.close();

    service.openDatabase({ path: dbPath, create: false });
    service.openDatabase({ path: secondPath, create: false });
    service.openDatabase({ path: dbPath, create: false });

    const recent = service.getRecentDatabases();
    expect(recent).toEqual([fs.realpathSync(dbPath), fs.realpathSync(secondPath)]);
    recent.push('/mutated/by/caller.sqlite');
    expect(service.getRecentDatabases()).toEqual([
      fs.realpathSync(dbPath),
      fs.realpathSync(secondPath),
    ]);
  });

  it('keeps only the ten most recently opened database paths', () => {
    const databasePaths = Array.from({ length: 11 }, (_, index) => {
      const databasePath = path.join(tempDir, `recent-${index}.sqlite`);
      new Database(databasePath).close();
      service.openDatabase({ path: databasePath, create: false });
      return fs.realpathSync(databasePath);
    });

    expect(service.getRecentDatabases()).toEqual(databasePaths.slice(1).reverse());
  });

  it('rejects directories and invalid database files', () => {
    expect(() => service.openDatabase({ path: tempDir, create: false })).toThrow(/INVALID_PATH/);

    const invalidPath = path.join(tempDir, 'invalid.sqlite');
    fs.writeFileSync(invalidPath, 'not a sqlite database');
    expect(() => service.openDatabase({ path: invalidPath, create: false })).toThrow(/SQLITE_NOTADB|database/i);
  });

  it('requires a connection and closes idempotently', () => {
    let error: unknown;
    try {
      service.getSchema();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkbenchError);
    expect(toPublicError(error)).toEqual({
      code: 'NOT_CONNECTED',
      message: '尚未连接 SQLite 数据库。',
    });

    service.openDatabase({ path: dbPath, create: false });
    expect(service.closeDatabase()).toMatchObject({ connected: false, path: null, mode: null });
    expect(service.closeDatabase()).toMatchObject({ connected: false, path: null, mode: null });
  });

  it('reads bounded pages with JSON-safe values and primary-key identities', () => {
    service.openDatabase({ path: dbPath, create: false });

    const page = service.getRows({ name: 'users', page: 1, pageSize: 25 });

    expect(page).toMatchObject({
      page: 1,
      pageSize: 25,
      total: 2,
      writable: false,
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

  it('uses the complete primary key as its stable default order', () => {
    service.openDatabase({ path: dbPath, create: false });

    const result = service.getRows({ name: 'stable_items', page: 1, pageSize: 25 });
    expect(result.rows.map((row) => row.values[0])).toEqual(['A', 'B', 'C']);
  });

  it('appends stable identity columns to a user-selected sort', () => {
    service.openDatabase({ path: dbPath, create: false });

    const result = service.getRows({
      name: 'stable_items',
      page: 1,
      pageSize: 25,
      sorts: [{ column: 'rank', direction: 'asc' }],
    });
    expect(result.rows.map((row) => row.values[0])).toEqual(['A', 'B', 'C']);
  });

  it('uses rowid to distinguish and stably mutate duplicate null primary keys', () => {
    openReadWrite();
    const result = service.getRows({ name: 'nullable_keys', page: 1, pageSize: 25 });

    expect(result.rows.slice(0, 2).map((row) => row.identity)).toEqual([
      { kind: 'rowid', value: { type: 'integer', value: '1' } },
      { kind: 'rowid', value: { type: 'integer', value: '2' } },
    ]);
    expect(service.updateRow({
      name: 'nullable_keys',
      identity: result.rows[0].identity,
      values: { label: { type: 'text', value: 'changed-only-first' } },
    })).toMatchObject({ changes: 1 });
    expect(service.getRows({ name: 'nullable_keys', page: 1, pageSize: 25 }).rows
      .map((row) => row.values[1])).toEqual(['changed-only-first', 'second-null', 'named']);
  });

  it('uses rowid for duplicate null INTEGER PRIMARY KEY DESC records', () => {
    openReadWrite();
    const schema = service.getObjectSchema({ name: 'integer_desc_keys' });
    const result = service.getRows({ name: 'integer_desc_keys', page: 1, pageSize: 25 });

    expect(schema.indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'pk', unique: true, columns: ['id'] }),
    ]));
    expect(result.rows.slice(0, 2).map((row) => row.identity)).toEqual([
      { kind: 'rowid', value: { type: 'integer', value: '1' } },
      { kind: 'rowid', value: { type: 'integer', value: '2' } },
    ]);
    expect(service.updateRow({
      name: 'integer_desc_keys',
      identity: result.rows[0].identity,
      values: { label: { type: 'text', value: 'changed-only-first-desc' } },
    })).toMatchObject({ changes: 1 });
    expect(service.getRows({ name: 'integer_desc_keys', page: 1, pageSize: 25 }).rows
      .map((row) => row.values[1])).toEqual(['changed-only-first-desc', 'second-desc-null', 'named']);
  });

  it('searches visible text and numeric columns with a contains query', () => {
    service.openDatabase({ path: dbPath, create: false });

    expect(service.getRows({
      name: 'stable_items',
      page: 1,
      pageSize: 25,
      search: 'lph',
    }).rows.map((row) => row.values[0])).toEqual(['A']);
    expect(service.getRows({
      name: 'stable_items',
      page: 1,
      pageSize: 25,
      search: '2',
    }).rows.map((row) => row.values[0])).toEqual(['C']);
  });

  it('supports contains, equals, null, and non-null column filters', () => {
    service.openDatabase({ path: dbPath, create: false });

    const base = { name: 'stable_items', page: 1, pageSize: 25 as const };
    expect(service.getRows({
      ...base,
      filters: [{ column: 'label', operator: 'contains', value: 'et' }],
    }).rows.map((row) => row.values[0])).toEqual(['B']);
    expect(service.getRows({
      ...base,
      filters: [{ column: 'rank', operator: 'equals', value: '1' }],
    }).rows.map((row) => row.values[0])).toEqual(['A', 'B']);
    expect(service.getRows({
      ...base,
      filters: [{ column: 'note', operator: 'is-null' }],
    }).rows.map((row) => row.values[0])).toEqual(['B', 'C']);
    expect(service.getRows({
      ...base,
      filters: [{ column: 'note', operator: 'is-not-null' }],
    }).rows.map((row) => row.values[0])).toEqual(['A']);
  });

  it('rejects unknown sort and filter columns before preparing SQL', () => {
    service.openDatabase({ path: dbPath, create: false });

    expect(() => service.getRows({
      name: 'stable_items',
      page: 1,
      pageSize: 25,
      sorts: [{ column: 'missing', direction: 'asc' }],
    })).toThrow(/INVALID_COLUMN/);
    expect(() => service.getRows({
      name: 'stable_items',
      page: 1,
      pageSize: 25,
      filters: [{ column: 'missing', operator: 'equals', value: 'x' }],
    })).toThrow(/INVALID_COLUMN/);
  });

  it('invalidates a cached filtered count after an insert', () => {
    openReadWrite();
    const query = {
      name: 'stable_items',
      page: 1,
      pageSize: 25 as const,
      filters: [{ column: 'rank', operator: 'equals' as const, value: '1' }],
    };
    expect(service.getRows(query).total).toBe(2);

    service.insertRow({
      name: 'stable_items',
      values: {
        code: { type: 'text', value: 'D' },
        rank: { type: 'integer', value: '1' },
        label: { type: 'text', value: 'Delta' },
      },
    });

    expect(service.getRows(query).total).toBe(3);
  });

  it('inserts, updates, and deletes a primary-key row', () => {
    openReadWrite();

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
    })).toMatchObject({ changes: 1 });
    expect(service.deleteRow({ name: 'users', identity: inserted!.identity })).toMatchObject({ changes: 1 });
    expect(service.getRows({ name: 'users', page: 1, pageSize: 25 }).total).toBe(2);
  });

  it('writes through composite-key and rowid identities', () => {
    openReadWrite();
    const keyed = service.getRows({ name: 'keyed', page: 1, pageSize: 25 }).rows[0];
    const loose = service.getRows({ name: 'loose_items', page: 1, pageSize: 25 }).rows[0];

    expect(service.updateRow({
      name: 'keyed',
      identity: keyed.identity,
      values: { value: { type: 'text', value: 'changed' } },
    })).toMatchObject({ changes: 1 });
    expect(service.deleteRow({ name: 'loose_items', identity: loose.identity })).toMatchObject({ changes: 1 });
  });

  it('supports DEFAULT VALUES inserts and rejects unsafe writes', () => {
    service.openDatabase({ path: dbPath, create: false });
    const defaultTablePath = path.join(tempDir, 'defaults.sqlite');
    const defaults = new Database(defaultTablePath);
    defaults.exec('CREATE TABLE defaults (id INTEGER PRIMARY KEY, label TEXT DEFAULT \'ready\')');
    defaults.close();
    openReadWrite(defaultTablePath);

    expect(service.insertRow({ name: 'defaults', values: {} })).toMatchObject({ changes: 1 });
    expect(service.getRows({ name: 'defaults', page: 1, pageSize: 25 }).rows[0].values[1]).toBe('ready');
    expect(() => service.insertRow({
      name: 'defaults',
      values: { missing: { type: 'text', value: 'nope' } },
    })).toThrow(/column/i);
  });

  it('rolls back constraint failures and rejects views, blobs, and stale identities', () => {
    openReadWrite();
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

    expect(service.deleteRow({ name: 'users', identity: first.identity })).toMatchObject({ changes: 1 });
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
    openReadWrite(relationalPath);

    expect(() => service.insertRow({
      name: 'tasks',
      values: { project_id: { type: 'integer', value: '404' } },
    })).toThrow(/SQLITE_CONSTRAINT_FOREIGNKEY/);
    expect(service.getRows({ name: 'tasks', page: 1, pageSize: 25 }).total).toBe(0);
  });

  it('reports a locked database without partially writing', () => {
    openReadWrite();
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

  it('executes a row-returning SQL statement with serialized values', async () => {
    service.openDatabase({ path: dbPath, create: false });

    const result = await service.executeSql({
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

  it('executes mutations and DDL with a change summary', async () => {
    openReadWrite();

    const updateSql = "UPDATE users SET score = 9 WHERE email = 'a@example.com'";
    const updateAnalysis = service.analyzeSql({ sql: updateSql });
    await expect(service.executeSql({
      sql: updateSql,
      confirmationToken: updateAnalysis.confirmationToken,
    })).resolves.toMatchObject({ kind: 'mutation', changes: 1 });
    const createSql = 'CREATE TABLE audit (id INTEGER)';
    const createAnalysis = service.analyzeSql({ sql: createSql });
    await expect(service.executeSql({
      sql: createSql,
      confirmationToken: createAnalysis.confirmationToken,
    })).resolves.toMatchObject({ kind: 'mutation', changes: 0 });
    expect(service.getSchema().objects.map((item) => item.name)).toContain('audit');
  });

  it('bounds SQL result sets at 50 rows', async () => {
    service.openDatabase({ path: dbPath, create: false });

    const result = await service.executeSql({
      sql: `
        WITH RECURSIVE numbers(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 501
        ) SELECT value FROM numbers
      `,
    });

    expect(result.kind).toBe('rows');
    if (result.kind !== 'rows') throw new Error('Expected rows result');
    expect(result.rows).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  it('rejects empty, malformed, and multiple SQL statements', async () => {
    service.openDatabase({ path: dbPath, create: false });

    await expect(service.executeSql({ sql: '' })).rejects.toThrow(/SQL/i);
    await expect(service.executeSql({ sql: 'SELECT FROM' })).rejects.toThrow(/SQLITE_ERROR/);
    await expect(service.executeSql({ sql: 'SELECT 1; SELECT 2' })).rejects.toThrow(/MULTIPLE_STATEMENTS/);
  });
});
