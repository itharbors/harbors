import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteService } from '../main/src/sqlite-service';

describe('SQLite row export', () => {
  let tempDir: string;
  let dbPath: string;
  let service: SqliteService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-export-'));
    dbPath = path.join(tempDir, 'export.sqlite');
    const fixture = new Database(dbPath);
    fixture.exec(`
      CREATE TABLE records (
        id INTEGER PRIMARY KEY,
        label TEXT,
        note TEXT,
        payload BLOB
      );
      INSERT INTO records (id, label, note, payload) VALUES
        (2, 'Beta', 'line 1\nline 2', X'00FF'),
        (1, 'Alpha, "quoted"', NULL, NULL),
        (3, 'Other', 'hidden', NULL);
    `);
    fixture.close();
    service = new SqliteService();
    service.openDatabase({ path: dbPath, create: false });
  });

  afterEach(async () => {
    await service.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('exports the active filter and stable sort as UTF-8 CSV', () => {
    const result = service.exportRows({
      name: 'records',
      format: 'csv',
      filters: [{ column: 'id', operator: 'equals', value: '2' }],
      sorts: [{ column: 'label', direction: 'desc' }],
    });

    expect(result).toEqual({
      format: 'csv',
      fileName: 'records.csv',
      mimeType: 'text/csv;charset=utf-8',
      content: 'id,label,note,payload\r\n2,Beta,"line 1\nline 2",00ff',
      rows: 1,
      truncated: false,
      warning: null,
    });
  });

  it('exports JSON-safe integers and blobs without data loss', () => {
    const result = service.exportRows({
      name: 'records',
      format: 'json',
      search: 'Beta',
    });

    expect(JSON.parse(result.content)).toEqual([{
      id: { type: 'integer', value: '2' },
      label: 'Beta',
      note: 'line 1\nline 2',
      payload: { type: 'blob', size: 2, previewHex: '00ff' },
    }]);
    expect(result).toMatchObject({
      fileName: 'records.json',
      mimeType: 'application/json;charset=utf-8',
      rows: 1,
      truncated: false,
    });
  });

  it('caps exports at ten thousand rows with a localized warning', () => {
    service.closeDatabase();
    const fixture = new Database(dbPath);
    fixture.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 10
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 10010
      )
      INSERT INTO records (id, label) SELECT value, 'bulk' FROM sequence;
    `);
    fixture.close();
    service.openDatabase({ path: dbPath, create: false });

    const result = service.exportRows({ name: 'records', format: 'json' });
    expect(result.rows).toBe(10_000);
    expect(result.truncated).toBe(true);
    expect(result.warning).toBe('结果超过 10,000 行，仅导出前 10,000 行。');
    expect(JSON.parse(result.content)).toHaveLength(10_000);
  });
});
