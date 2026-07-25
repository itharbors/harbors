import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import Database from 'better-sqlite3';
import type { CsvQuery } from '@itharbors/csv-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CsvIndex,
  CSV_INDEX_MARKER,
  CSV_INDEX_OWNER,
  CSV_INDEX_SCHEMA_VERSION,
} from '../main/src/csv-index.js';
import { CsvService } from '../main/src/csv-service.js';
import { CsvServiceError } from '../main/src/protocol.js';

describe('CsvService streaming index lifecycle', () => {
  let root: string;
  let sources: string;
  let temporaryRoot: string;
  let service: CsvService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-service-test-'));
    sources = path.join(root, 'sources');
    temporaryRoot = path.join(root, 'temporary');
    fs.mkdirSync(sources);
    fs.mkdirSync(temporaryRoot);
    service = new CsvService({ temporaryRoot });
  });

  afterEach(async () => {
    await service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('samples through the validated read-only path and returns deterministic suggestions', async () => {
    const source = writeSource('sample.txt', '\uFEFFname\tvalue\nA\t1\n');

    await expect(service.sampleFile({ path: source })).resolves.toMatchObject({
      path: source,
      fileName: 'sample.txt',
      suggestion: { encoding: 'utf8', delimiter: '\t', hasHeader: true },
      preview: { cells: ['name', 'value'], truncated: false },
    });
    expect(service.getConnectionState().phase).toBe('closed');
  });

  it('keeps a UTF-8 suggestion when the bounded sample ends inside a multibyte character', async () => {
    const prefix = Buffer.from(`name,value\n${'a'.repeat((64 * 1024) - 12)}`);
    expect(prefix).toHaveLength((64 * 1024) - 1);
    const source = writeBufferSource(
      'sample-boundary.csv',
      Buffer.concat([prefix, Buffer.from('中,b\n')]),
    );

    await expect(service.sampleFile({ path: source })).resolves.toMatchObject({
      suggestion: { encoding: 'utf8' },
    });
  });

  it('keeps detection suggestions while generating a preview for explicit parse choices', async () => {
    const source = writeSource('semicolon.csv', 'name;city\nAda;Shanghai\n');

    await expect(service.sampleFile({ path: source })).resolves.toMatchObject({
      suggestion: { delimiter: ';' },
      preview: { cells: ['name', 'city'] },
    });
    await expect(service.sampleFile({ path: source, encoding: 'utf8', delimiter: ',' })).resolves.toMatchObject({
      suggestion: { delimiter: ';' },
      preview: { cells: ['name;city'] },
    });
  });

  it('streams quoted records into SQLite while preserving raw strings and display headers', async () => {
    const source = writeSource(
      'quoted.csv',
      '编号,,编号\r\n001,"a,b","line 1\nline 2"\r\n002,"He said ""hi""",\r\n',
    );

    await service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    });

    expect(service.getSchema().columns.map((column) => column.displayName)).toEqual([
      '编号',
      '未命名列 2',
      '编号 (2)',
    ]);
    expect(service.getConnectionState()).toMatchObject({
      phase: 'ready', byteSize: fs.statSync(source).size, rowCount: 2, columnCount: 3, irregularRowCount: 0,
    });
    const database = openOwnedDatabase();
    expect(database.prepare('SELECT c1, c2, c3 FROM rows ORDER BY record_number').all()).toEqual([
      { c1: '001', c2: 'a,b', c3: 'line 1\nline 2' },
      { c1: '002', c2: 'He said "hi"', c3: '' },
    ]);
    database.close();
  });

  it('generates headerless columns and normalizes irregular record widths', async () => {
    const source = writeSource('headerless.data', 'a,b\nc\nd,e,f\n');

    await service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    });

    expect(service.getSchema()).toMatchObject({ irregularRecordCount: 2 });
    expect(service.getSchema().columns.map((column) => column.displayName)).toEqual([
      '列 1',
      '列 2',
      '列 3',
    ]);
    const database = openOwnedDatabase();
    expect(database.prepare('SELECT c1, c2, c3 FROM rows ORDER BY record_number').all()).toEqual([
      { c1: 'a', c2: 'b', c3: '' },
      { c1: 'c', c2: '', c3: '' },
      { c1: 'd', c2: 'e', c3: 'f' },
    ]);
    database.close();
  });

  it('opens empty and header-only files without inventing records', async () => {
    const empty = writeSource('empty.csv', '');
    await service.openFile({
      path: empty,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    });
    expect(service.getConnectionState()).toMatchObject({
      phase: 'ready', rowCount: 0, columnCount: 0, irregularRowCount: 0,
    });
    expect(service.getSchema().columns).toEqual([]);

    await service.closeFile();
    const headerOnly = writeSource('header-only.csv', '编号,名称\r\n');
    await service.openFile({
      path: headerOnly,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    });
    expect(service.getConnectionState()).toMatchObject({
      phase: 'ready', rowCount: 0, columnCount: 2, irregularRowCount: 0,
    });
    expect(service.getSchema().columns.map((column) => column.name)).toEqual(['编号', '名称']);
  });

  it('rejects an unclosed quoted field without changing the source or retaining an index', async () => {
    const source = writeSource('unclosed.csv', 'name,note\nA,\"unfinished\n');
    const before = fs.readFileSync(source);

    await expect(service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    })).rejects.toMatchObject({ code: 'CSV_PARSE_FAILED' });

    expect(fs.readFileSync(source)).toEqual(before);
    expect(fs.readdirSync(temporaryRoot)).toEqual([]);
  });

  it('partitions wide indexes so the documented 10,000-column boundary exceeds SQLite limits', async () => {
    const values = Array.from({ length: 10_000 }, (_, index) => `v${index + 1}`);
    const source = writeSource('sqlite-wide.csv', `${values.join(',')}\n`);

    await service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    });

    expect(service.getSchema().columns).toHaveLength(10_000);
    const database = openOwnedDatabase();
    expect(database.prepare('SELECT c9996, c10000 FROM rows_6').get()).toEqual({
      c9996: 'v9996',
      c10000: 'v10000',
    });
    database.close();
  });

  it('rejects more than 10,000 columns and fields larger than 16 MiB', async () => {
    const tooWide = writeSource('wide.csv', `${Array.from({ length: 10_001 }, () => 'x').join(',')}\n`);
    await expect(service.openFile({
      path: tooWide,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    })).rejects.toMatchObject({ code: 'TOO_MANY_COLUMNS' });

    const tooLarge = writeSource('large-field.csv', `${'x'.repeat((16 * 1024 * 1024) + 1)}\n`);
    await expect(service.openFile({
      path: tooLarge,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    })).rejects.toMatchObject({ code: 'FIELD_TOO_LARGE' });
    expect(fs.readdirSync(temporaryRoot)).toEqual([]);
  }, 30_000);

  it('rejects records larger than 16 MiB even when every individual field is within its limit', async () => {
    const field = 'x'.repeat(9 * 1024 * 1024);
    const source = writeSource('large-record.csv', `small\r\n${field},${field}\r\n`);

    await expect(service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    })).rejects.toMatchObject({ code: 'RECORD_TOO_LARGE', record: 2 });

    expect(service.getConnectionState()).toMatchObject({
      phase: 'error',
      error: {
        code: 'RECORD_TOO_LARGE',
        message: 'CSV 记录超过 16 MiB 上限。',
        record: 2,
      },
    });
    expect(fs.readdirSync(temporaryRoot)).toEqual([]);
  }, 30_000);

  it('counts multibyte field content toward the decoded 16 MiB record limit', async () => {
    const field = '中'.repeat(3 * 1024 * 1024);
    expect(Buffer.byteLength(field, 'utf8')).toBe(9 * 1024 * 1024);
    expect(Buffer.byteLength(`${field}${field}`, 'utf8')).toBeGreaterThan(16 * 1024 * 1024);
    const source = writeSource('multibyte-large-record.csv', `${field},${field}\n`);

    await expect(service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    })).rejects.toMatchObject({ code: 'RECORD_TOO_LARGE', record: 1 });

    expect(service.getConnectionState()).toMatchObject({
      phase: 'error',
      error: { code: 'RECORD_TOO_LARGE', record: 1 },
    });
    expect(fs.readdirSync(temporaryRoot)).toEqual([]);
  }, 30_000);

  it('resets decoded record bytes between LF-terminated records', async () => {
    const field = 'x'.repeat(9 * 1024 * 1024);
    const source = writeSource('large-separate-records.csv', `${field}\n${field}\n`);

    await expect(service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    })).resolves.toMatchObject({ phase: 'ready', rowCount: 2 });

    const database = openOwnedDatabase();
    expect(database.prepare('SELECT COUNT(*) AS count, MAX(LENGTH(c1)) AS maximum FROM rows').get())
      .toEqual({ count: 2, maximum: field.length });
    database.close();
  }, 30_000);

  it('observes spool failures, closes the stream, and cleans before removing the index', async () => {
    await service.dispose();
    const originalError = new CsvServiceError('TEST_SPOOL_FAILURE', '受控临时写入失败。');
    const unhandled: unknown[] = [];
    let spoolClosed = false;
    let cleanupSawClosedSpool = false;
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    service = new CsvService({
      temporaryRoot,
      createSpoolWriteStream: () => new Writable({
        write(_chunk, _encoding, callback) {
          setImmediate(() => callback(originalError));
        },
        destroy(error, callback) {
          spoolClosed = true;
          callback(error);
        },
      }),
      disposeIndex: async (index) => {
        cleanupSawClosedSpool = spoolClosed;
        await index.dispose();
      },
    });
    const source = writeSource('spool-failure.csv', 'a,b\n1,2\n');

    try {
      await expect(service.openFile({
        path: source,
        encoding: 'utf8',
        delimiter: ',',
        hasHeader: false,
      })).rejects.toBe(originalError);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(cleanupSawClosedSpool).toBe(true);
    expect(fs.readdirSync(temporaryRoot)).toEqual([]);
  });

  it('does not retry an explicitly invalid UTF-8 open with the detected fallback', async () => {
    const source = path.join(sources, 'gb18030.csv');
    fs.writeFileSync(source, Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]));

    await expect(service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    })).rejects.toMatchObject({ code: 'INVALID_ENCODING' });
    expect(service.getConnectionState().phase).toBe('error');
    expect(fs.readdirSync(temporaryRoot)).toEqual([]);
  });

  it('rejects illegal or truncated GB18030 while streaming an explicit open', async () => {
    const illegal = writeBufferSource('illegal-gb18030.csv', Buffer.from([0x61, 0x2c, 0xff, 0x0a]));
    await expect(service.openFile({
      path: illegal,
      encoding: 'gb18030',
      delimiter: ',',
      hasHeader: false,
    })).rejects.toMatchObject({ code: 'INVALID_ENCODING' });

    const truncated = writeBufferSource('truncated-gb18030.csv', Buffer.from([0x61, 0x2c, 0x81]));
    await expect(service.openFile({
      path: truncated,
      encoding: 'gb18030',
      delimiter: ',',
      hasHeader: false,
    })).rejects.toMatchObject({ code: 'INVALID_ENCODING' });
    expect(fs.readdirSync(temporaryRoot)).toEqual([]);
  });

  it('checks temporary free space before parsing and cleans the candidate index', async () => {
    await service.dispose();
    service = new CsvService({
      temporaryRoot,
      filePolicy: { statfs: async () => ({ bavail: 0, bsize: 4096 }) },
    });
    const source = writeSource('no-space.csv', 'a,b\n1,2\n');

    await expect(service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    })).rejects.toMatchObject({ code: 'INSUFFICIENT_TEMP_SPACE' });
    expect(fs.readdirSync(temporaryRoot)).toEqual([]);
  });

  it('cancels an active open and removes its temporary directory', async () => {
    await service.dispose();
    service = new CsvService({ temporaryRoot, yieldEveryRecords: 1 });
    const source = writeSource(
      'cancel.csv',
      Array.from({ length: 5_000 }, (_, index) => `${index},value-${index}`).join('\n'),
    );

    const opening = service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    });
    await waitFor(() => service.getConnectionState().phase === 'indexing');
    service.cancelOpen({
      connectionRevision: service.getConnectionState().connectionRevision,
    });

    await expect(opening).rejects.toMatchObject({ code: 'OPEN_CANCELLED' });
    expect(service.getConnectionState().phase).toBe('closed');
    expect(fs.readdirSync(temporaryRoot)).toEqual([]);
  });

  it('keeps the old ready connection until a replacement succeeds', async () => {
    const first = writeSource('first.csv', 'name\nold\n');
    const oldRevision = (await service.openFile({
      path: first,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    })).connectionRevision;
    const oldDirectory = fs.readdirSync(temporaryRoot)[0];
    const broken = writeSource('broken.csv', 'name\n"not closed\n');

    await expect(service.openFile({
      path: broken,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    })).rejects.toMatchObject({ code: 'CSV_PARSE_FAILED' });

    expect(service.getConnectionState()).toMatchObject({
      connectionRevision: oldRevision,
      phase: 'ready',
      path: first,
      rowCount: 1,
    });
    expect(service.getSchema().connectionRevision).toBe(oldRevision);
    expect(service.getRows(query(oldRevision)).rows).toEqual([
      { record: 1, values: ['old'] },
    ]);
    expect(fs.readdirSync(temporaryRoot)).toEqual([oldDirectory]);

    const replacement = writeSource('replacement.csv', 'name\nnew\n');
    await service.openFile({
      path: replacement,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    });
    expect(service.getConnectionState()).toMatchObject({ phase: 'ready', path: replacement });
    expect(fs.readdirSync(temporaryRoot)).toHaveLength(1);
    expect(fs.readdirSync(temporaryRoot)[0]).not.toBe(oldDirectory);
  });

  it('restores the old ready state even when failed-candidate disposal reports an error', async () => {
    await service.dispose();
    const cleanupError = new Error('candidate cleanup failed after removal');
    const cleanupErrors: unknown[] = [];
    service = new CsvService({
      temporaryRoot,
      disposeIndex: async (index) => {
        await index.dispose();
        throw cleanupError;
      },
      onCleanupError: (error) => cleanupErrors.push(error),
    });
    const first = writeSource('cleanup-stable.csv', 'name\nstable\n');
    await service.openFile({
      path: first,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    });
    const broken = writeSource('cleanup-broken.csv', 'name\n"not closed\n');

    await expect(service.openFile({
      path: broken,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    })).rejects.toMatchObject({ code: 'CSV_PARSE_FAILED' });

    expect(service.getConnectionState()).toMatchObject({ phase: 'ready', path: first });
    expect(cleanupErrors).toEqual([cleanupError]);
    expect(fs.readdirSync(temporaryRoot)).toHaveLength(1);
  });

  it('keeps a successful replacement ready when old-index disposal reports an error', async () => {
    await service.dispose();
    const cleanupError = new Error('old cleanup failed after removal');
    const cleanupErrors: unknown[] = [];
    service = new CsvService({
      temporaryRoot,
      disposeIndex: async (index) => {
        await index.dispose();
        throw cleanupError;
      },
      onCleanupError: (error) => cleanupErrors.push(error),
    });
    const first = writeSource('old-index.csv', 'name\nold\n');
    await service.openFile({
      path: first,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    });
    const replacement = writeSource('new-index.csv', 'name\nnew\n');

    await expect(service.openFile({
      path: replacement,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    })).resolves.toMatchObject({ phase: 'ready', path: replacement });

    expect(service.getConnectionState()).toMatchObject({ phase: 'ready', path: replacement });
    expect(cleanupErrors).toEqual([cleanupError]);
    expect(fs.readdirSync(temporaryRoot)).toHaveLength(1);
  });

  it('rejects a post-open path swap and closes the bound source descriptor', async () => {
    await service.dispose();
    const source = writeSource('race.csv', 'a,b\n1,2\n');
    const originalStat = await fsp.lstat(source);
    let lstatCalls = 0;
    let descriptorClosed = false;
    service = new CsvService({
      temporaryRoot,
      filePolicy: {
        lstat: async () => {
          lstatCalls += 1;
          return lstatCalls === 1
            ? originalStat
            : {
              ...originalStat,
              isFile: () => true,
              isSymbolicLink: () => true,
            };
        },
      },
      openSource: async (filePath) => {
        const handle = await fsp.open(filePath, fs.constants.O_RDONLY);
        return {
          fd: handle.fd,
          stat: () => handle.stat(),
          close: async () => {
            descriptorClosed = true;
            await handle.close();
          },
        };
      },
    });

    await expect(service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });

    expect(lstatCalls).toBe(2);
    expect(descriptorClosed).toBe(true);
    expect(fs.readdirSync(temporaryRoot)).toEqual([]);
  });

  it('rejects descriptor growth without reading more than one probe byte past the approved size', async () => {
    await service.dispose();
    const source = writeSource('growing.csv', 'a,b\n1,2\n');
    const approved = await fsp.stat(source);
    const bytes = Buffer.concat([fs.readFileSync(source), Buffer.from('unexpected')]);
    const requestedEnds: number[] = [];
    service = new CsvService({
      temporaryRoot,
      openSource: async () => ({
        fd: 1,
        stat: async () => approved,
        close: async () => undefined,
        read: async (buffer, offset, length, position) => {
          requestedEnds.push(position + length);
          const bytesRead = Math.min(length, Math.max(0, bytes.length - position));
          bytes.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead };
        },
      }),
    });

    await expect(service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });

    expect(Math.max(...requestedEnds)).toBe(approved.size + 1);
    expect(fs.readdirSync(temporaryRoot)).toEqual([]);
  });

  it('rejects an early descriptor EOF before the approved size', async () => {
    await service.dispose();
    const source = writeSource('shrinking.csv', 'a,b\n1,2\n');
    const approved = await fsp.stat(source);
    const bytes = fs.readFileSync(source).subarray(0, approved.size - 2);
    service = new CsvService({
      temporaryRoot,
      openSource: async () => ({
        fd: 1,
        stat: async () => approved,
        close: async () => undefined,
        read: async (buffer, offset, length, position) => {
          const bytesRead = Math.min(length, Math.max(0, bytes.length - position));
          bytes.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead };
        },
      }),
    });

    await expect(service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(fs.readdirSync(temporaryRoot)).toEqual([]);
  });

  it('rejects same-size descriptor metadata drift during a bounded read', async () => {
    await service.dispose();
    const source = writeSource('drifting.csv', 'a,b\n1,2\n');
    const approved = await fsp.stat(source);
    const bytes = fs.readFileSync(source);
    let statCalls = 0;
    service = new CsvService({
      temporaryRoot,
      openSource: async () => ({
        fd: 1,
        stat: async () => {
          statCalls += 1;
          if (statCalls === 1) return approved;
          return {
            ...approved,
            isFile: () => true,
            mtimeMs: approved.mtimeMs + 1,
            mtime: new Date(approved.mtimeMs + 1),
          } as fs.Stats;
        },
        close: async () => undefined,
        read: async (buffer, offset, length, position) => {
          const bytesRead = Math.min(length, Math.max(0, bytes.length - position));
          bytes.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead };
        },
      }),
    });

    await expect(service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(statCalls).toBe(2);
    expect(fs.readdirSync(temporaryRoot)).toEqual([]);
  });

  it('restores the ready connection when a later replacement supersedes an active one', async () => {
    await service.dispose();
    service = new CsvService({ temporaryRoot, yieldEveryRecords: 1 });
    const first = writeSource('stable.csv', 'name\nstable\n');
    await service.openFile({
      path: first,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    });
    const slow = writeSource(
      'slow.csv',
      Array.from({ length: 5_000 }, (_, index) => `value-${index}`).join('\n'),
    );
    const superseded = service.openFile({
      path: slow,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    });
    const supersededError = superseded.catch((error: unknown) => error);
    await waitFor(() => service.getConnectionState().phase === 'indexing');
    const broken = writeSource('later-broken.csv', '"not closed\n');

    await expect(service.openFile({
      path: broken,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    })).rejects.toMatchObject({ code: 'CSV_PARSE_FAILED' });
    await expect(supersededError).resolves.toMatchObject({ code: 'OPEN_CANCELLED' });

    expect(service.getConnectionState()).toMatchObject({
      phase: 'ready',
      path: first,
      rowCount: 1,
    });
  });

  it('keeps queries bound to the old ready revision until a replacement swaps atomically', async () => {
    await service.dispose();
    service = new CsvService({ temporaryRoot, yieldEveryRecords: 1 });
    const first = writeSource('query-old.csv', 'name\nold\n');
    const oldRevision = (await service.openFile({
      path: first,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    })).connectionRevision;
    const replacement = writeSource(
      'query-new.csv',
      `name\n${Array.from({ length: 2_000 }, (_, index) => `new-${index + 1}`).join('\n')}\n`,
    );

    const opening = service.openFile({
      path: replacement,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    });
    await waitFor(() => service.getConnectionState().phase === 'indexing');
    const pendingRevision = service.getConnectionState().connectionRevision;

    const pendingOutcome = capture(() => service.getRows(query(pendingRevision)));
    const oldOutcome = capture(() => service.getRows(query(oldRevision)));
    const indexingSchemaRevision = service.getSchema().connectionRevision;

    await opening;

    expect(pendingOutcome).toMatchObject({ code: 'STALE_CONNECTION' });
    expect(oldOutcome).toMatchObject({
      rows: [{ record: 1, values: ['old'] }],
    });
    expect(indexingSchemaRevision).toBe(oldRevision);
    expect(() => service.getRows(query(oldRevision)))
      .toThrowError(expect.objectContaining({ code: 'STALE_CONNECTION' }));
    expect(service.getRows(query(pendingRevision)).rows[0]).toEqual({
      record: 1,
      values: ['new-1'],
    });
  });

  it('blocks export registration during swap and settles bound exports before index disposal', async () => {
    await service.dispose();
    let exportWriterCall = 0;
    let writerDestroyCompleted = false;
    let pendingWrite: ((error?: Error | null) => void) | undefined;
    let disposedWhileWriterActive = false;
    let signalWriterDestroyStarted!: () => void;
    const writerDestroyStarted = new Promise<void>((resolve) => {
      signalWriterDestroyStarted = resolve;
    });
    let releaseWriterDestroy!: () => void;
    const writerDestroyReleased = new Promise<void>((resolve) => {
      releaseWriterDestroy = resolve;
    });
    service = new CsvService({
      temporaryRoot,
      yieldEveryRecords: 1,
      createExportWriteStream: (outputPath, descriptor) => {
        exportWriterCall += 1;
        if (exportWriterCall > 1) {
          return fs.createWriteStream(outputPath, {
            autoClose: false,
            encoding: 'utf8',
            fd: descriptor,
          });
        }
        let writes = 0;
        return new Writable({
          write(_chunk, _encoding, callback) {
            writes += 1;
            if (writes === 3) pendingWrite = callback;
            else callback();
          },
          destroy(error, callback) {
            signalWriterDestroyStarted();
            void writerDestroyReleased.then(() => {
              writerDestroyCompleted = true;
              pendingWrite?.(error);
              callback(error);
            });
          },
        });
      },
      disposeIndex: async (index) => {
        if (!writerDestroyCompleted) disposedWhileWriterActive = true;
        await index.dispose();
      },
    });
    const first = writeSource('export-old.csv', 'name\nold\n');
    const oldRevision = (await service.openFile({
      path: first,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    })).connectionRevision;
    const firstOutput = path.join(root, 'active-export.csv');
    const activeExport = service.exportRows({
      ...query(oldRevision),
      exportId: 'active-old-export',
      outputPath: firstOutput,
    });
    const activeExportError = activeExport.catch((error: unknown) => error);
    await waitFor(() => pendingWrite !== undefined);
    const replacement = writeSource(
      'export-new.csv',
      `name\n${Array.from({ length: 2_000 }, (_, index) => `new-${index + 1}`).join('\n')}\n`,
    );
    const opening = service.openFile({
      path: replacement,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    });
    try {
      await waitForSignal(writerDestroyStarted, 5_000, 'writer destroy did not start');

      const lateOutput = path.join(root, 'late-export.csv');
      const lateOutcome = await service.exportRows({
        ...query(oldRevision),
        exportId: 'late-old-export',
        outputPath: lateOutput,
      }).then(
        () => ({ code: 'RESOLVED' }),
        (error: unknown) => error,
      );
      const disposedBeforeRelease = disposedWhileWriterActive;
      releaseWriterDestroy();
      await expect(activeExportError).resolves.toMatchObject({ code: 'EXPORT_CANCELLED' });
      await opening;

      expect(lateOutcome).toMatchObject({ code: 'EXPORT_UNAVAILABLE' });
      expect(fs.existsSync(lateOutput)).toBe(false);
      expect(disposedBeforeRelease).toBe(false);
      expect(disposedWhileWriterActive).toBe(false);
    } finally {
      releaseWriterDestroy();
      await Promise.allSettled([activeExportError, opening]);
    }
  });

  it('makes close and dispose idempotent and removes the owned index', async () => {
    const source = writeSource('close.csv', 'a\n1\n');
    await service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    });

    await service.closeFile();
    await service.closeFile();
    await service.dispose();

    expect(service.getConnectionState().phase).toBe('closed');
    expect(fs.readdirSync(temporaryRoot)).toEqual([]);
  });

  it('waits for an active open to release its candidate before close resolves', async () => {
    await service.dispose();
    service = new CsvService({ temporaryRoot, yieldEveryRecords: 1 });
    const source = writeSource(
      'close-active.csv',
      Array.from({ length: 5_000 }, (_, index) => `${index},value`).join('\n'),
    );
    const opening = service.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: false,
    });
    const openingError = opening.catch((error: unknown) => error);
    await waitFor(() => service.getConnectionState().phase === 'indexing');

    await service.closeFile();
    await expect(openingError).resolves.toMatchObject({ code: 'OPEN_CANCELLED' });

    expect(service.getConnectionState().phase).toBe('closed');
    expect(fs.readdirSync(temporaryRoot)).toEqual([]);
  });

  it('removes only expired marker-owned harbors-csv directories during startup cleanup', async () => {
    await service.dispose();
    const now = Date.parse('2026-07-24T00:00:00.000Z');
    createMarkedDirectory('harbors-csv-expired', {
      schemaVersion: CSV_INDEX_SCHEMA_VERSION,
      owner: CSV_INDEX_OWNER,
      expiresAt: now - 1,
      pid: 2_147_483_647,
    });
    createMarkedDirectory('harbors-csv-expired-live-owner', {
      schemaVersion: CSV_INDEX_SCHEMA_VERSION,
      owner: CSV_INDEX_OWNER,
      expiresAt: now - 1,
      pid: process.pid,
    });
    createMarkedDirectory('harbors-csv-fresh', {
      schemaVersion: CSV_INDEX_SCHEMA_VERSION,
      owner: CSV_INDEX_OWNER,
      expiresAt: now + 1,
      pid: process.pid,
    });
    createMarkedDirectory('harbors-csv-foreign', {
      schemaVersion: CSV_INDEX_SCHEMA_VERSION,
      owner: 'someone-else',
      expiresAt: now - 1,
      pid: 2_147_483_647,
    });
    createMarkedDirectory('unrelated-expired', {
      schemaVersion: CSV_INDEX_SCHEMA_VERSION,
      owner: CSV_INDEX_OWNER,
      expiresAt: now - 1,
      pid: 2_147_483_647,
    });

    service = new CsvService({ temporaryRoot, now: () => now });

    expect(fs.readdirSync(temporaryRoot).sort()).toEqual([
      'harbors-csv-expired-live-owner',
      'harbors-csv-foreign',
      'harbors-csv-fresh',
      'unrelated-expired',
    ]);
  });

  it('does not clean an expired index that is still live in this process', async () => {
    const now = Date.parse('2026-07-24T00:00:00.000Z');
    const live = CsvIndex.create(temporaryRoot, now);

    CsvIndex.cleanupExpired(temporaryRoot, now + (25 * 60 * 60 * 1000));

    expect(fs.existsSync(live.directory)).toBe(true);
    await live.dispose();
  });

  function writeSource(name: string, contents: string): string {
    const source = path.join(sources, name);
    fs.writeFileSync(source, contents);
    return source;
  }

  function writeBufferSource(name: string, contents: Buffer): string {
    const source = path.join(sources, name);
    fs.writeFileSync(source, contents);
    return source;
  }

  function openOwnedDatabase(): Database.Database {
    const [ownedDirectory] = fs.readdirSync(temporaryRoot);
    return new Database(path.join(temporaryRoot, ownedDirectory, 'index.sqlite'), { readonly: true });
  }

  function query(connectionRevision: number): CsvQuery {
    return {
      connectionRevision,
      page: 1,
      pageSize: 25,
      search: '',
      filters: [],
      sort: null,
    };
  }

  function capture<T>(operation: () => T): T | unknown {
    try {
      return operation();
    } catch (error) {
      return error;
    }
  }

  function createMarkedDirectory(
    name: string,
    marker: { schemaVersion: number; owner: string; expiresAt: number; pid: number },
  ): void {
    const directory = path.join(temporaryRoot, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, CSV_INDEX_MARKER), JSON.stringify(marker));
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not reached');
}

async function waitForSignal<T>(signal: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
