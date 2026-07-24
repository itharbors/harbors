import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { CsvQuery } from '@itharbors/csv-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsvService } from '../main/src/csv-service.js';

describe('CsvService safe streaming export', () => {
  let root: string;
  let temporaryRoot: string;
  let source: string;
  let service: CsvService;
  let revision: number;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-export-test-'));
    temporaryRoot = path.join(root, 'temporary');
    fs.mkdirSync(temporaryRoot);
    source = path.join(root, 'source.csv');
    fs.writeFileSync(
      source,
      '名称,备注\r\nB,"逗号,""引号"""\r\nA,"一行\r\n二行"\r\n',
      'utf8',
    );
    service = new CsvService({ temporaryRoot });
    revision = (await service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    })).connectionRevision;
  });

  afterEach(async () => {
    await service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes a UTF-8 BOM, displayed headers, RFC 4180 cells, and exact query order', async () => {
    const filteredOutput = path.join(root, 'filtered.csv');
    const filtered = await service.exportRows({
      ...query(),
      exportId: 'filtered',
      outputPath: filteredOutput,
      filters: [{ columnId: 'column-1', operator: 'equals', value: 'a' }],
    });
    expect(filtered).toMatchObject({
      connectionRevision: revision,
      exportId: 'filtered',
      outputPath: filteredOutput,
      rowCount: 1,
    });
    expect(await fsp.readFile(filteredOutput, 'utf8'))
      .toBe('\uFEFF名称,备注\r\nA,"一行\r\n二行"\r\n');

    const orderedOutput = path.join(root, 'ordered.csv');
    await service.exportRows({
      ...query(),
      exportId: 'ordered',
      outputPath: orderedOutput,
      sort: { columnId: 'column-1', direction: 'asc' },
    });
    expect(await fsp.readFile(orderedOutput, 'utf8')).toBe(
      '\uFEFF名称,备注\r\nA,"一行\r\n二行"\r\nB,"逗号,""引号"""\r\n',
    );
  });

  it('uses disambiguated display headers without changing stored source names', async () => {
    await service.dispose();
    source = path.join(root, 'display-headers.csv');
    fs.writeFileSync(source, '名称,,名称\nA,x,y\n', 'utf8');
    service = new CsvService({ temporaryRoot });
    revision = (await service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    })).connectionRevision;
    const outputPath = path.join(root, 'displayed.csv');

    await service.exportRows({ ...query(), exportId: 'headers', outputPath });

    expect(await fsp.readFile(outputPath, 'utf8'))
      .toBe('\uFEFF名称,未命名列 2,名称 (2)\r\nA,x,y\r\n');
    expect(service.getSchema().columns.map((column) => column.name)).toEqual(['名称', '', '名称']);
  });

  it('refuses an existing destination and the source path without changing either file', async () => {
    const existing = path.join(root, 'existing.csv');
    fs.writeFileSync(existing, 'keep me', 'utf8');

    await expect(service.exportRows({
      ...query(),
      exportId: 'existing',
      outputPath: existing,
    })).rejects.toMatchObject({ code: 'EXPORT_TARGET_EXISTS' });
    expect(await fsp.readFile(existing, 'utf8')).toBe('keep me');

    const sourceBefore = await fsp.readFile(source);
    await expect(service.exportRows({
      ...query(),
      exportId: 'source',
      outputPath: source,
    })).rejects.toMatchObject({ code: 'UNSAFE_EXPORT' });
    expect(await fsp.readFile(source)).toEqual(sourceBefore);
  });

  it('cancels between batches and removes only the partial output it created', async () => {
    await service.dispose();
    source = path.join(root, 'many.csv');
    fs.writeFileSync(
      source,
      `value\n${Array.from({ length: 600 }, (_, index) => `row-${index + 1}`).join('\n')}\n`,
      'utf8',
    );
    let progressEvents = 0;
    service = new CsvService({
      temporaryRoot,
      onExportProgress: (progress) => {
        progressEvents += 1;
        service.cancelExport({
          connectionRevision: progress.connectionRevision,
          exportId: progress.exportId,
        });
      },
    });
    revision = (await service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    })).connectionRevision;
    const outputPath = path.join(root, 'cancelled.csv');

    await expect(service.exportRows({
      ...query(),
      exportId: 'cancel-me',
      outputPath,
    })).rejects.toMatchObject({ code: 'EXPORT_CANCELLED' });
    expect(progressEvents).toBe(1);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it('observes writer errors, awaits writer closure, and removes the created partial file', async () => {
    await service.dispose();
    let writes = 0;
    let writerClosed = false;
    const writerError = new Error('controlled export writer failure');
    service = new CsvService({
      temporaryRoot,
      createExportWriteStream: () => new Writable({
        write(_chunk, _encoding, callback) {
          writes += 1;
          setImmediate(() => callback(writes === 3 ? writerError : null));
        },
        destroy(error, callback) {
          writerClosed = true;
          callback(error);
        },
      }),
    });
    revision = (await service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    })).connectionRevision;
    const outputPath = path.join(root, 'failed.csv');

    await expect(service.exportRows({
      ...query(),
      exportId: 'writer-failure',
      outputPath,
    })).rejects.toBe(writerError);
    expect(writerClosed).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it('treats cancellation during delayed file-handle close as failure and removes the output', async () => {
    const outputPath = path.join(root, 'late-cancel.csv');
    const closeStarted = deferred();
    const allowClose = deferred();
    const realOpen = fsp.open.bind(fsp);
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const realClose = handle.close.bind(handle);
      handle.close = async () => {
        closeStarted.resolve();
        await allowClose.promise;
        await realClose();
      };
      return handle;
    });

    try {
      const exporting = service.exportRows({
        ...query(),
        exportId: 'late-cancel',
        outputPath,
      });
      await closeStarted.promise;
      service.cancelExport({ connectionRevision: revision, exportId: 'late-cancel' });
      allowClose.resolve();

      await expect(exporting).rejects.toMatchObject({ code: 'EXPORT_CANCELLED' });
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      allowClose.resolve();
      openSpy.mockRestore();
    }
  });

  function query(): CsvQuery {
    return {
      connectionRevision: revision,
      page: 1,
      pageSize: 25,
      search: '',
      filters: [],
      sort: null,
    };
  }
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
