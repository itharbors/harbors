import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toPublicError } from '../main/src/protocol';
import { SqliteService } from '../main/src/sqlite-service';

describe('SQLite guarded and reversible mutations', () => {
  let tempDir: string;
  let dbPath: string;
  let now: number;
  let tokenIndex: number;
  let service: SqliteService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-mutations-'));
    dbPath = path.join(tempDir, 'mutations.sqlite');
    const fixture = new Database(dbPath);
    fixture.exec(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL,
        payload BLOB
      );
      CREATE VIEW item_labels AS SELECT id, label FROM items;
      CREATE VIRTUAL TABLE item_fts USING fts5(label);
      CREATE TABLE inaccessible_identity (
        rowid TEXT,
        _rowid_ TEXT,
        oid TEXT,
        value TEXT
      );
      INSERT INTO items (id, label, payload) VALUES
        (1, 'first', X'00FF'),
        (2, 'second', NULL);
      INSERT INTO inaccessible_identity VALUES ('a', 'b', 'c', 'hidden-rowid');
    `);
    fixture.close();
    now = Date.UTC(2026, 6, 19, 8, 0, 0);
    tokenIndex = 0;
    service = new SqliteService({
      now: () => now,
      createToken: () => `undo-${++tokenIndex}`,
    });
  });

  afterEach(async () => {
    await service.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects CRUD at the service boundary while the connection is readonly', () => {
    service.openDatabase({ path: dbPath, create: false });

    let error: unknown;
    try {
      service.insertRow({
        name: 'items',
        values: { label: { type: 'text', value: 'blocked' } },
      });
    } catch (caught) {
      error = caught;
    }
    expect(toPublicError(error)).toEqual({
      code: 'READ_ONLY',
      message: '当前连接为只读模式，无法修改记录。',
    });
    const verifier = new Database(dbPath, { readonly: true });
    expect(verifier.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(2);
    verifier.close();
  });

  it('keeps views, virtual tables, shadow tables, and unstable tables readonly', () => {
    service.openDatabase({ path: dbPath, create: false });
    service.setConnectionMode({ mode: 'readwrite' });

    for (const name of ['item_labels', 'item_fts', 'item_fts_config', 'inaccessible_identity']) {
      expect(service.getObjectSchema({ name })).toMatchObject({ writable: false });
      expect(() => service.insertRow({ name, values: {} })).toThrow(/READ_ONLY/);
    }
    expect(service.getRows({
      name: 'inaccessible_identity',
      page: 1,
      pageSize: 25,
    }).rows[0].identity).toBeNull();
  });

  it('undoes an insert with a single-use ten-second receipt', () => {
    openReadWrite();

    const receipt = service.insertRow({
      name: 'items',
      values: { label: { type: 'text', value: 'new' } },
    });
    expect(receipt).toMatchObject({
      changes: 1,
      undoToken: 'undo-1',
      undoExpiresAt: '2026-07-19T08:00:10.000Z',
      identity: { kind: 'primary-key' },
    });
    expect(service.getRows({ name: 'items', page: 1, pageSize: 25 }).total).toBe(3);

    expect(service.undoLastMutation({ token: receipt.undoToken })).toEqual({
      undone: true,
      operation: 'insert',
    });
    expect(service.getRows({ name: 'items', page: 1, pageSize: 25 }).total).toBe(2);
    expect(() => service.undoLastMutation({ token: receipt.undoToken })).toThrow(/NO_UNDO/);
  });

  it('undoes an update that changed the primary key', () => {
    openReadWrite();
    const row = service.getRows({ name: 'items', page: 1, pageSize: 25 }).rows[0];

    const receipt = service.updateRow({
      name: 'items',
      identity: row.identity,
      values: {
        id: { type: 'integer', value: '10' },
        label: { type: 'text', value: 'changed' },
      },
    });
    expect(receipt.identity).toEqual({
      kind: 'primary-key',
      values: { id: { type: 'integer', value: '10' } },
    });

    expect(service.undoLastMutation({ token: receipt.undoToken })).toMatchObject({
      undone: true,
      operation: 'update',
    });
    expect(service.getRows({ name: 'items', page: 1, pageSize: 25 }).rows[0].values).toEqual([
      { type: 'integer', value: '1' },
      'first',
      { type: 'blob', size: 2, previewHex: '00ff' },
    ]);
  });

  it('undoes a delete and restores the complete BLOB value', () => {
    openReadWrite();
    const row = service.getRows({ name: 'items', page: 1, pageSize: 25 }).rows[0];

    const receipt = service.deleteRow({ name: 'items', identity: row.identity });
    expect(service.undoLastMutation({ token: receipt.undoToken })).toMatchObject({
      operation: 'delete',
    });

    service.closeDatabase();
    const verifier = new Database(dbPath, { readonly: true });
    const restored = verifier.prepare('SELECT payload FROM items WHERE id = 1').get() as {
      payload: Buffer;
    };
    expect(restored.payload.equals(Buffer.from([0, 255]))).toBe(true);
    verifier.close();
  });

  it('retains the snapshot after a wrong token but rejects it after expiry', () => {
    openReadWrite();
    const receipt = service.insertRow({
      name: 'items',
      values: { label: { type: 'text', value: 'temporary' } },
    });

    expect(() => service.undoLastMutation({ token: 'wrong' })).toThrow(/INVALID_UNDO_TOKEN/);
    now += 10_001;
    expect(() => service.undoLastMutation({ token: receipt.undoToken })).toThrow(/UNDO_EXPIRED/);
  });

  it('refuses undo when the affected row changed concurrently', () => {
    openReadWrite();
    const row = service.getRows({ name: 'items', page: 1, pageSize: 25 }).rows[0];
    const receipt = service.updateRow({
      name: 'items',
      identity: row.identity,
      values: { label: { type: 'text', value: 'service-change' } },
    });
    const concurrent = new Database(dbPath);
    concurrent.prepare("UPDATE items SET label = 'concurrent-change' WHERE id = 1").run();
    concurrent.close();

    expect(() => service.undoLastMutation({ token: receipt.undoToken })).toThrow(/STALE_ROW/);
  });

  function openReadWrite(): void {
    service.openDatabase({ path: dbPath, create: false });
    service.setConnectionMode({ mode: 'readwrite' });
  }
});
