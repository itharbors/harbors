import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import type {
  CsvConnectionSnapshot,
  CsvColumnStats,
  CsvDelimiter,
  CsvEncoding,
  CsvOpenInput,
  CsvCancelExportInput,
  CsvCancelOpenInput,
  CsvPublicError,
  CsvQuery,
  CsvRowsResult,
  CsvSchema,
  CsvSampleResult,
  CsvSampleInput,
} from '@itharbors/csv-contracts';
import { parse } from 'csv-parse';
import { CsvIndex } from './csv-index.js';
import { exportCsvRows } from './exporter.js';
import {
  assertTemporarySpace,
  MAX_SOURCE_SIZE,
  validateSourcePath,
  type FilePolicyAdapters,
  type StatLike,
} from './file-policy.js';
import { detectSample, previewSample } from './detection.js';
import {
  CsvCoreError,
  type CsvExportInput,
  type CsvExportProgress,
  type CsvExportResult,
  requireNonEmptyString,
  requireNonNegativeInteger,
  requireRecord,
  toPublicError,
} from './protocol.js';

const SAMPLE_SIZE = 64 * 1024;
const MAX_COLUMNS = 10_000;
const MAX_FIELD_SIZE = 16 * 1024 * 1024;
const MAX_RECORD_SIZE = 16 * 1024 * 1024;
const DEFAULT_YIELD_EVERY_RECORDS = 256;

export type CsvServiceColumn = CsvSchema['columns'][number] & {
  displayName: string;
};

export type CsvServiceSchema = Omit<CsvSchema, 'columns'> & {
  columns: CsvServiceColumn[];
};

export type CsvServiceConnectionSnapshot = CsvConnectionSnapshot;

export type CsvServiceColumnStats = CsvColumnStats & {
  nonEmptyCount: number;
};

type SourceHandle = {
  fd: number;
  stat(): Promise<fs.Stats>;
  close(): Promise<void>;
  read?(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
};

type BoundSourceIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export type CsvServiceOptions = {
  temporaryRoot?: string;
  now?: () => number;
  filePolicy?: FilePolicyAdapters;
  yieldEveryRecords?: number;
  createSpoolWriteStream?: (spoolPath: string) => Writable;
  createExportWriteStream?: (outputPath: string, descriptor: number) => Writable;
  onExportProgress?: (progress: CsvExportProgress) => void;
  onConnectionStateChange?: (state: CsvServiceConnectionSnapshot) => void;
  disposeIndex?: (index: CsvIndex) => Promise<void>;
  onCleanupError?: (error: unknown) => void;
  openSource?: (sourcePath: string, flags: number) => Promise<SourceHandle>;
};

type ActiveOpen = {
  revision: number;
  controller: AbortController;
  completion: Promise<void>;
  complete(): void;
};

type ActiveExport = {
  revision: number;
  index: CsvIndex;
  controller: AbortController;
  completion: Promise<unknown>;
};

type ReadyBinding = {
  revision: number;
  index: CsvIndex;
  schema: CsvServiceSchema;
  state: CsvServiceConnectionSnapshot;
};

type ParsedFile = {
  header: string[];
  maximumWidth: number;
  rowCount: number;
  irregularRecordCount: number;
};

export class CsvService {
  private readonly temporaryRoot: string;
  private readonly now: () => number;
  private readonly filePolicy: FilePolicyAdapters;
  private readonly yieldEveryRecords: number;
  private readonly createSpoolWriteStream: (spoolPath: string) => Writable;
  private readonly createExportWriteStream:
    | ((outputPath: string, descriptor: number) => Writable)
    | undefined;
  private readonly onExportProgress: ((progress: CsvExportProgress) => void) | undefined;
  private readonly onConnectionStateChange: ((state: CsvServiceConnectionSnapshot) => void) | undefined;
  private readonly disposeIndex: (index: CsvIndex) => Promise<void>;
  private readonly onCleanupError: (error: unknown) => void;
  private readonly openSource: (sourcePath: string, flags: number) => Promise<SourceHandle>;
  private currentIndex: CsvIndex | null = null;
  private schema: CsvServiceSchema | null = null;
  private readyRevision: number | null = null;
  private activeOpen: ActiveOpen | null = null;
  private readonly activeExports = new Map<string, ActiveExport>();
  private readonly exportBarriers = new Map<CsvIndex, number>();
  private connectionRevision = 0;
  private state: CsvServiceConnectionSnapshot = closedState(0);
  private readyState: CsvServiceConnectionSnapshot | null = null;

  constructor(options: CsvServiceOptions = {}) {
    this.temporaryRoot = options.temporaryRoot ?? os.tmpdir();
    this.now = options.now ?? Date.now;
    this.filePolicy = options.filePolicy ?? {};
    this.yieldEveryRecords = options.yieldEveryRecords ?? DEFAULT_YIELD_EVERY_RECORDS;
    this.createSpoolWriteStream = options.createSpoolWriteStream
      ?? ((spoolPath) => fs.createWriteStream(spoolPath, { encoding: 'utf8', flags: 'wx' }));
    this.createExportWriteStream = options.createExportWriteStream;
    this.onExportProgress = options.onExportProgress;
    this.onConnectionStateChange = options.onConnectionStateChange;
    this.disposeIndex = options.disposeIndex ?? ((index) => index.dispose());
    this.onCleanupError = options.onCleanupError ?? (() => undefined);
    this.openSource = options.openSource ?? ((sourcePath, flags) => fsp.open(sourcePath, flags));
    if (!Number.isInteger(this.yieldEveryRecords) || this.yieldEveryRecords < 1) {
      throw new CsvCoreError('INVALID_OPTIONS', 'yieldEveryRecords 必须是正整数。');
    }
    CsvIndex.cleanupExpired(this.temporaryRoot, this.now());
  }

  async sampleFile(input: unknown): Promise<CsvSampleResult> {
    const requested = parseSampleInput(input);
    const source = await this.openBoundSource(
      requested.path,
    );
    try {
      const buffer = Buffer.alloc(Math.min(source.size, SAMPLE_SIZE));
      if (typeof source.handle.read !== 'function') {
        throw new CsvCoreError('SOURCE_READ_FAILED', '无法读取所选文件。');
      }
      const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, 0);
      const sampledBytes = buffer.subarray(0, bytesRead);
      const sampleIsTruncated = bytesRead < source.size;
      const detected = detectSample(sampledBytes, sampleIsTruncated);
      const previewEncoding = requested.encoding ?? detected.encoding;
      const previewDelimiter = requested.delimiter ?? detected.delimiter;
      return {
        path: source.path,
        size: source.size,
        modifiedAt: source.modifiedAt,
        fileName: path.basename(source.path),
        suggestion: {
          encoding: detected.encoding,
          delimiter: detected.delimiter,
          hasHeader: detected.hasHeader,
        },
        preview: requested.encoding === undefined && requested.delimiter === undefined
          ? detected.preview
          : previewSample(
            sampledBytes,
            previewEncoding,
            previewDelimiter,
            sampleIsTruncated,
          ),
      };
    } finally {
      await closeSourceHandle(source.handle);
    }
  }

  async openFile(input: CsvOpenInput): Promise<CsvServiceConnectionSnapshot> {
    const requested = parseOpenInput(input);
    this.activeOpen?.controller.abort();
    const revision = this.nextConnectionRevision();
    const oldIndex = this.currentIndex;
    const oldSchema = this.schema;
    const oldReadyRevision = this.readyRevision;
    const oldState = oldIndex === null ? null : this.readyState;
    const completion = deferred();
    const active: ActiveOpen = {
      revision,
      controller: new AbortController(),
      completion: completion.promise,
      complete: completion.resolve,
    };
    this.activeOpen = active;
    this.state = {
      connectionRevision: revision,
      phase: 'indexing',
      path: path.resolve(requested.path),
      fileName: path.basename(requested.path),
      encoding: requested.encoding,
      delimiter: requested.delimiter,
      hasHeader: requested.hasHeader,
      progress: 0,
      error: null,
      byteSize: null,
      rowCount: null,
      columnCount: null,
      irregularRowCount: null,
    };
    this.notifyConnectionStateChange();

    let candidate: CsvIndex | null = null;
    let releaseExportBarrier: (() => void) | null = null;
    let sourceHandle: SourceHandle | null = null;
    const closeSource = async (): Promise<void> => {
      const handle = sourceHandle;
      sourceHandle = null;
      if (handle !== null) await closeSourceHandle(handle);
    };
    try {
      const source = await this.openBoundSource(requested.path);
      sourceHandle = source.handle;
      this.state = { ...this.state, byteSize: source.size };
      this.notifyConnectionStateChange();
      assertActive(active, this.activeOpen);
      candidate = CsvIndex.create(this.temporaryRoot, this.now());
      await assertTemporarySpace(candidate.directory, source.size, this.filePolicy);
      const parsed = await this.parseToSpool(
        source.handle,
        source.identity,
        requested,
        candidate,
        active,
      );
      await closeSource();
      assertActive(active, this.activeOpen);
      candidate.initialize(parsed.maximumWidth);
      await candidate.importSpool(
        parsed.maximumWidth,
        active.controller.signal,
        (insertedRows) => {
          if (this.activeOpen === active) {
            this.state = {
              ...this.state,
              progress: parsed.rowCount === 0 ? 1 : insertedRows / parsed.rowCount,
            };
            this.notifyConnectionStateChange();
          }
        },
      );
      await candidate.removeSpool();
      assertActive(active, this.activeOpen);

      const schema = buildSchema(
        revision,
        requested.hasHeader,
        parsed.header,
        parsed.maximumWidth,
        parsed.irregularRecordCount,
      );
      if (oldIndex !== null) {
        releaseExportBarrier = this.blockExportRegistration(oldIndex);
        await this.cancelExportsBoundTo(oldIndex);
        assertActive(active, this.activeOpen);
      }
      this.currentIndex = candidate;
      this.schema = schema;
      this.readyRevision = revision;
      this.state = {
        connectionRevision: revision,
        phase: 'ready',
        path: source.path,
        fileName: path.basename(source.path),
        encoding: requested.encoding,
        delimiter: requested.delimiter,
        hasHeader: requested.hasHeader,
        progress: 1,
        error: null,
        byteSize: source.size,
        rowCount: parsed.rowCount,
        columnCount: parsed.maximumWidth,
        irregularRowCount: parsed.irregularRecordCount,
      };
      this.readyState = this.getConnectionState();
      this.notifyConnectionStateChange();
      candidate = null;
      this.activeOpen = null;
      releaseExportBarrier?.();
      releaseExportBarrier = null;
      if (oldIndex !== null) await this.disposeIndexSafely(oldIndex);
      return this.getConnectionState();
    } catch (error) {
      const normalized = normalizeOpenError(error, active.controller.signal);
      releaseExportBarrier?.();
      releaseExportBarrier = null;
      try {
        await closeSource();
      } catch (cleanupError) {
        this.reportCleanupError(cleanupError);
      }
      if (candidate !== null) await this.disposeIndexSafely(candidate);
      if (this.activeOpen === active) {
        this.activeOpen = null;
        if (
          oldIndex !== null
          && oldState !== null
          && oldSchema !== null
          && oldReadyRevision !== null
        ) {
          this.currentIndex = oldIndex;
          this.schema = oldSchema;
          this.readyRevision = oldReadyRevision;
          this.state = {
            ...oldState,
            error: toPublicError(normalized),
          };
          this.readyState = this.getConnectionState();
        } else if (normalized.code === 'OPEN_CANCELLED') {
          this.currentIndex = null;
          this.schema = null;
          this.readyRevision = null;
          this.readyState = null;
          this.state = closedState(revision);
        } else {
          this.currentIndex = null;
          this.schema = null;
          this.readyRevision = null;
          this.readyState = null;
          this.state = {
            ...this.state,
            phase: 'error',
            progress: null,
            error: toPublicError(normalized),
          };
        }
        this.notifyConnectionStateChange();
      }
      throw normalized;
    } finally {
      active.complete();
    }
  }

  getConnectionState(): CsvServiceConnectionSnapshot {
    return {
      ...this.state,
      error: this.state.error === null ? null : { ...this.state.error },
    };
  }

  getSchema(): CsvServiceSchema {
    if (this.schema === null) {
      throw new CsvCoreError('NO_CONNECTION', '尚未打开 CSV 文件。');
    }
    return {
      ...this.schema,
      columns: this.schema.columns.map((column) => ({ ...column })),
    };
  }

  getRows(query: CsvQuery): CsvRowsResult {
    const record = requireRecord(query, 'CSV 查询参数无效。');
    const revision = requireNonNegativeInteger(
      record.connectionRevision,
      'connectionRevision 必须是非负整数。',
    );
    const binding = this.requireReadyBinding(revision);
    const result = binding.index.getRows(query);
    return {
      connectionRevision: revision,
      page: result.page,
      pageSize: result.pageSize,
      totalRows: result.total,
      rows: result.rows.map((row) => ({
        record: row.recordNumber,
        values: row.values,
      })),
    };
  }

  getColumnStats(input: unknown): CsvServiceColumnStats {
    const record = requireRecord(input, 'CSV 列统计参数无效。');
    const revision = requireNonNegativeInteger(
      record.connectionRevision,
      'connectionRevision 必须是非负整数。',
    );
    if (typeof record.columnId !== 'string') {
      throw new CsvCoreError('INVALID_COLUMN', 'CSV 列标识无效。');
    }
    const stats = this.requireReadyBinding(revision).index.getColumnStats(record.columnId);
    return { connectionRevision: revision, ...stats };
  }

  async exportRows(input: unknown): Promise<CsvExportResult> {
    const exportInput = parseExportInput(input);
    const binding = this.requireReadyBinding(exportInput.connectionRevision);
    if (this.exportBarriers.has(binding.index)) {
      throw new CsvCoreError('EXPORT_UNAVAILABLE', 'CSV 正在切换文件，请稍后重试导出。');
    }
    binding.index.validateQuery(exportInput);
    if (this.activeExports.has(exportInput.exportId)) {
      throw new CsvCoreError('EXPORT_ALREADY_RUNNING', '相同导出任务正在运行。');
    }
    const controller = new AbortController();
    const operation = exportCsvRows(
      exportInput,
      binding.state.path!,
      binding.schema.columns.map((column) => column.displayName),
      controller.signal,
      (page, pageSize, knownTotalRows) => {
        const result = binding.index.getRows(
          { ...exportInput, page, pageSize },
          knownTotalRows,
        );
        return {
          connectionRevision: exportInput.connectionRevision,
          page: result.page,
          pageSize: result.pageSize,
          totalRows: result.total,
          rows: result.rows.map((row) => ({
            record: row.recordNumber,
            values: row.values,
          })),
        };
      },
      {
        now: this.now,
        createWriteStream: this.createExportWriteStream,
        onProgress: this.onExportProgress,
        onCleanupError: (error) => this.reportCleanupError(error),
      },
    );
    const active: ActiveExport = {
      revision: exportInput.connectionRevision,
      index: binding.index,
      controller,
      completion: operation,
    };
    this.activeExports.set(exportInput.exportId, active);
    try {
      return await operation;
    } finally {
      if (this.activeExports.get(exportInput.exportId) === active) {
        this.activeExports.delete(exportInput.exportId);
      }
    }
  }

  cancelExport(input: CsvCancelExportInput): void {
    const record = requireRecord(input, '取消导出参数无效。');
    const revision = requireNonNegativeInteger(
      record.connectionRevision,
      'connectionRevision 必须是非负整数。',
    );
    const exportId = requireNonEmptyString(record.exportId, 'exportId 不能为空。');
    if (this.readyRevision !== revision) {
      throw new CsvCoreError('STALE_CONNECTION', 'CSV 连接已更新，请刷新后重试。');
    }
    const active = this.activeExports.get(exportId);
    if (active?.revision === revision) active.controller.abort();
  }

  cancelOpen(input: CsvCancelOpenInput): void {
    const record = requireRecord(input, '取消参数无效。');
    if (!Number.isInteger(record.connectionRevision) || (record.connectionRevision as number) < 0) {
      throw new CsvCoreError('INVALID_INPUT', 'connectionRevision 必须是整数。');
    }
    if (this.activeOpen?.revision !== record.connectionRevision) {
      throw new CsvCoreError('STALE_CONNECTION', 'CSV 连接已更新，请刷新后重试。');
    }
    this.activeOpen.controller.abort();
  }

  async closeFile(): Promise<void> {
    const revision = this.nextConnectionRevision();
    const active = this.activeOpen;
    active?.controller.abort();
    this.activeOpen = null;
    const index = this.currentIndex;
    this.currentIndex = null;
    this.schema = null;
    this.readyRevision = null;
    this.readyState = null;
    this.state = closedState(revision);
    this.notifyConnectionStateChange();
    await active?.completion;
    if (index === null) await this.cancelActiveExports();
    else await this.cancelExportsBoundTo(index);
    if (index !== null) await this.disposeIndexSafely(index);
  }

  async dispose(): Promise<void> {
    await this.closeFile();
  }

  private async parseToSpool(
    sourceHandle: SourceHandle,
    sourceIdentity: BoundSourceIdentity,
    input: CsvOpenInput,
    index: CsvIndex,
    active: ActiveOpen,
  ): Promise<ParsedFile> {
    const sourceReader = createBoundSourceReader(
      sourceHandle,
      sourceIdentity,
      active.controller.signal,
    );
    const source = sourceReader.stream;
    const decoder = createDecodeStream(input.encoding);
    const fieldSizeGuard = new FieldSizeGuard(
      input.delimiter,
      MAX_FIELD_SIZE,
      MAX_RECORD_SIZE,
    );
    const parser = parse({
      bom: true,
      delimiter: input.delimiter,
      relax_column_count: true,
      // Bound parser-owned record buffering in addition to the per-field streaming guard.
      max_record_size: MAX_RECORD_SIZE,
      quote: '"',
      cast: false,
    });
    const spool = new ObservedSpoolWriter(this.createSpoolWriteStream(index.spoolPath));
    const parsing = pipeline(source, decoder, fieldSizeGuard, parser);

    let header: string[] = [];
    let maximumWidth = 0;
    let rowCount = 0;
    let parsedRecordCount = 0;
    const widthCounts = new Map<number, number>();
    try {
      for await (const value of parser) {
        assertActive(active, this.activeOpen);
        const record = value as string[];
        parsedRecordCount += 1;
        if (record.length > MAX_COLUMNS) {
          throw new CsvCoreError('TOO_MANY_COLUMNS', 'CSV 记录不能超过 10,000 列.', {
            record: parsedRecordCount,
          });
        }
        for (let column = 0; column < record.length; column += 1) {
          if (Buffer.byteLength(record[column], 'utf8') > MAX_FIELD_SIZE) {
            throw new CsvCoreError('FIELD_TOO_LARGE', 'CSV 字段不能超过 16 MiB。', {
              record: parsedRecordCount,
              column: column + 1,
            });
          }
        }
        maximumWidth = Math.max(maximumWidth, record.length);
        if (input.hasHeader && parsedRecordCount === 1) {
          header = record;
        } else {
          rowCount += 1;
          widthCounts.set(record.length, (widthCounts.get(record.length) ?? 0) + 1);
          await spool.write(`${JSON.stringify(record)}\n`);
        }
        if (this.activeOpen === active) {
          this.state = {
            ...this.state,
            progress: sourceIdentity.size === 0
              ? 0.5
              : Math.min(0.5, sourceReader.bytesRead() / sourceIdentity.size / 2),
          };
          this.notifyConnectionStateChange();
        }
        if (parsedRecordCount % this.yieldEveryRecords === 0) {
          await yieldToEventLoop();
        }
      }
      await parsing;
      await spool.close();
      assertActive(active, this.activeOpen);
      const regularCount = widthCounts.get(maximumWidth) ?? 0;
      return {
        header,
        maximumWidth,
        rowCount,
        irregularRecordCount: rowCount - regularCount,
      };
    } catch (error) {
      source.destroy();
      decoder.destroy();
      fieldSizeGuard.destroy();
      parser.destroy();
      await parsing.catch(() => undefined);
      const spoolFailure = spool.failure;
      await spool.abort();
      throw spoolFailure ?? error;
    }
  }

  private async openBoundSource(requestedPath: string): Promise<{
    path: string;
    size: number;
    modifiedAt: string;
    identity: BoundSourceIdentity;
    handle: SourceHandle;
  }> {
    const source = await validateSourcePath(requestedPath, this.filePolicy);
    const handle = await this.openSource(
      source.path,
      fs.constants.O_RDONLY | noFollowFlag(),
    );
    try {
      const descriptorStat = await handle.stat();
      const postOpenStat = await (this.filePolicy.lstat ?? fsp.lstat)(source.path);
      assertBoundSource(descriptorStat, postOpenStat);
      return {
        path: source.path,
        size: descriptorStat.size,
        modifiedAt: descriptorStat.mtime.toISOString(),
        identity: snapshotSourceIdentity(descriptorStat),
        handle,
      };
    } catch (error) {
      await closeSourceHandle(handle).catch((cleanupError) => this.reportCleanupError(cleanupError));
      throw error;
    }
  }

  private requireReadyBinding(connectionRevision: number): ReadyBinding {
    if (
      this.currentIndex === null
      || this.schema === null
      || this.readyRevision === null
      || this.readyState === null
      || this.readyState.path === null
    ) {
      throw new CsvCoreError('NO_CONNECTION', '尚未打开 CSV 文件。');
    }
    if (connectionRevision !== this.readyRevision) {
      throw new CsvCoreError('STALE_CONNECTION', 'CSV 连接已更新，请刷新后重试。');
    }
    return {
      revision: this.readyRevision,
      index: this.currentIndex,
      schema: this.schema,
      state: this.readyState,
    };
  }

  private async cancelActiveExports(): Promise<void> {
    const active = [...this.activeExports.values()];
    active.forEach((exportTask) => exportTask.controller.abort());
    await Promise.allSettled(active.map((exportTask) => exportTask.completion));
  }

  private async cancelExportsBoundTo(index: CsvIndex): Promise<void> {
    const active = [...this.activeExports.values()]
      .filter((exportTask) => exportTask.index === index);
    active.forEach((exportTask) => exportTask.controller.abort());
    await Promise.allSettled(active.map((exportTask) => exportTask.completion));
  }

  private blockExportRegistration(index: CsvIndex): () => void {
    this.exportBarriers.set(index, (this.exportBarriers.get(index) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.exportBarriers.get(index) ?? 1) - 1;
      if (remaining === 0) this.exportBarriers.delete(index);
      else this.exportBarriers.set(index, remaining);
    };
  }

  private nextConnectionRevision(): number {
    this.connectionRevision += 1;
    return this.connectionRevision;
  }

  private async disposeIndexSafely(index: CsvIndex): Promise<void> {
    try {
      await this.disposeIndex(index);
    } catch (error) {
      this.reportCleanupError(error);
    }
  }

  private reportCleanupError(error: unknown): void {
    try {
      this.onCleanupError(error);
    } catch {
      // Cleanup reporting is diagnostic and must never alter the primary state transition.
    }
  }

  private notifyConnectionStateChange(): void {
    try {
      this.onConnectionStateChange?.(this.getConnectionState());
    } catch {
      // Observers are diagnostic and cannot alter file lifecycle transitions.
    }
  }
}

function parseExportInput(input: unknown): CsvExportInput {
  const record = requireRecord(input, 'CSV 导出参数无效。');
  return {
    connectionRevision: requireNonNegativeInteger(
      record.connectionRevision,
      'connectionRevision 必须是非负整数。',
    ),
    page: record.page as CsvQuery['page'],
    pageSize: record.pageSize as CsvQuery['pageSize'],
    search: record.search as CsvQuery['search'],
    filters: record.filters as CsvQuery['filters'],
    sort: record.sort as CsvQuery['sort'],
    exportId: requireNonEmptyString(record.exportId, 'exportId 不能为空。'),
    outputPath: requireNonEmptyString(record.outputPath, '请选择导出路径。'),
  };
}

function parseOpenInput(input: CsvOpenInput): CsvOpenInput {
  const record = requireRecord(input, '打开参数无效。');
  const encoding = record.encoding;
  const delimiter = record.delimiter;
  if (encoding !== 'utf8' && encoding !== 'gb18030') {
    throw new CsvCoreError('INVALID_INPUT', 'encoding 必须是 utf8 或 gb18030。');
  }
  if (delimiter !== ',' && delimiter !== '\t' && delimiter !== ';') {
    throw new CsvCoreError('INVALID_INPUT', 'delimiter 必须是逗号、制表符或分号。');
  }
  if (typeof record.hasHeader !== 'boolean') {
    throw new CsvCoreError('INVALID_INPUT', 'hasHeader 必须是布尔值。');
  }
  return {
    path: requireNonEmptyString(record.path, '请选择 CSV 文件。'),
    encoding: encoding as CsvEncoding,
    delimiter: delimiter as CsvDelimiter,
    hasHeader: record.hasHeader,
  };
}

function parseSampleInput(input: unknown): CsvSampleInput {
  const record = requireRecord(input, '采样参数无效。');
  const encoding = record.encoding;
  const delimiter = record.delimiter;
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'gb18030') {
    throw new CsvCoreError('INVALID_INPUT', '采样 encoding 必须是 utf8 或 gb18030。');
  }
  if (delimiter !== undefined && delimiter !== ',' && delimiter !== '\t' && delimiter !== ';') {
    throw new CsvCoreError('INVALID_INPUT', '采样 delimiter 必须是逗号、制表符或分号。');
  }
  return {
    path: requireNonEmptyString(record.path, '请选择 CSV 文件。'),
    ...(encoding === undefined ? {} : { encoding: encoding as CsvEncoding }),
    ...(delimiter === undefined ? {} : { delimiter: delimiter as CsvDelimiter }),
  };
}

function buildSchema(
  revision: number,
  hasHeader: boolean,
  header: string[],
  width: number,
  irregularRecordCount: number,
): CsvServiceSchema {
  const seen = new Map<string, number>();
  const columns = Array.from({ length: width }, (_, index): CsvServiceColumn => {
    const rawName = hasHeader ? header[index] ?? '' : `列 ${index + 1}`;
    let displayName: string;
    if (!hasHeader) {
      displayName = rawName;
    } else if (rawName === '') {
      displayName = `未命名列 ${index + 1}`;
    } else {
      const occurrence = (seen.get(rawName) ?? 0) + 1;
      seen.set(rawName, occurrence);
      displayName = occurrence === 1 ? rawName : `${rawName} (${occurrence})`;
    }
    return {
      id: `column-${index + 1}`,
      index,
      name: rawName,
      displayName,
    };
  });
  return { connectionRevision: revision, columns, irregularRecordCount };
}

function createDecodeStream(encoding: CsvEncoding): Transform {
  const label = encoding === 'utf8' ? 'UTF-8' : 'GB18030';
  const decoder = new TextDecoder(encoding === 'utf8' ? 'utf-8' : 'gb18030', { fatal: true });
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        callback(null, decoder.decode(chunk, { stream: true }));
      } catch (error) {
        callback(new CsvCoreError('INVALID_ENCODING', `文件不是有效的 ${label}。`, {}, {
          cause: error,
        }));
      }
    },
    flush(callback) {
      try {
        callback(null, decoder.decode());
      } catch (error) {
        callback(new CsvCoreError('INVALID_ENCODING', `文件不是有效的 ${label}。`, {}, {
          cause: error,
        }));
      }
    },
  });
}

function normalizeOpenError(error: unknown, signal: AbortSignal): CsvCoreError {
  if (signal.aborted) {
    return new CsvCoreError('OPEN_CANCELLED', '已取消打开 CSV 文件。');
  }
  if (error instanceof CsvCoreError) return error;
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'CSV_MAX_RECORD_SIZE'
  ) {
    return new CsvCoreError(
      'RECORD_TOO_LARGE',
      'CSV 记录不能超过 16 MiB。',
      parseErrorLocation(error),
      { cause: error },
    );
  }
  return new CsvCoreError('CSV_PARSE_FAILED', 'CSV 解析失败。', parseErrorLocation(error), {
    cause: error,
  });
}

function parseErrorLocation(error: unknown): Pick<CsvPublicError, 'record' | 'line' | 'column'> {
  if (typeof error !== 'object' || error === null) return {};
  const value = error as Record<string, unknown>;
  return {
    ...(typeof value.records === 'number' ? { record: value.records + 1 } : {}),
    ...(typeof value.lines === 'number' ? { line: value.lines } : {}),
    ...(typeof value.column === 'number' ? { column: value.column } : {}),
  };
}

function closedState(revision: number): CsvServiceConnectionSnapshot {
  return {
    connectionRevision: revision,
    phase: 'closed',
    path: null,
    fileName: null,
    encoding: null,
    delimiter: null,
    hasHeader: null,
    progress: null,
    error: null,
    byteSize: null,
    rowCount: null,
    columnCount: null,
    irregularRowCount: null,
  };
}

function assertActive(active: ActiveOpen, current: ActiveOpen | null): void {
  if (active.controller.signal.aborted || active !== current) {
    throw new CsvCoreError('OPEN_CANCELLED', '已取消打开 CSV 文件。');
  }
}

function noFollowFlag(): number {
  return 'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
}

function createBoundSourceReader(
  handle: SourceHandle,
  expected: BoundSourceIdentity,
  signal: AbortSignal,
): { stream: Readable; bytesRead(): number } {
  if (typeof handle.read !== 'function') {
    throw new CsvCoreError('SOURCE_READ_FAILED', '无法读取所选文件。');
  }
  let totalBytesRead = 0;
  const read = handle.read.bind(handle);
  async function* chunks(): AsyncGenerator<Buffer> {
    let position = 0;
    while (!signal.aborted) {
      const remaining = expected.size - position;
      if (remaining === 0) {
        const probe = Buffer.allocUnsafe(1);
        const result = await read(probe, 0, 1, position);
        if (result.bytesRead !== 0) throw sourceChangedError();
        assertSourceIdentityUnchanged(expected, await handle.stat());
        return;
      }
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const result = await read(buffer, 0, buffer.length, position);
      if (
        !Number.isInteger(result.bytesRead)
        || result.bytesRead <= 0
        || result.bytesRead > buffer.length
      ) {
        throw sourceChangedError();
      }
      position += result.bytesRead;
      totalBytesRead += result.bytesRead;
      yield buffer.subarray(0, result.bytesRead);
    }
    throw new CsvCoreError('OPEN_CANCELLED', '已取消打开 CSV 文件。');
  }
  return {
    stream: Readable.from(chunks(), { objectMode: false, signal }),
    bytesRead: () => totalBytesRead,
  };
}

function snapshotSourceIdentity(stat: fs.Stats): BoundSourceIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function assertSourceIdentityUnchanged(
  expected: BoundSourceIdentity,
  actual: fs.Stats,
): void {
  if (
    !actual.isFile()
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
    || actual.size !== expected.size
    || actual.mtimeMs !== expected.mtimeMs
    || actual.ctimeMs !== expected.ctimeMs
  ) {
    throw sourceChangedError();
  }
}

function sourceChangedError(): CsvCoreError {
  return new CsvCoreError('SOURCE_CHANGED', 'CSV 源文件在读取过程中发生了变化。');
}

async function closeSourceHandle(handle: SourceHandle): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    if (!hasErrorCode(error, 'EBADF')) throw error;
  }
}

function assertBoundSource(descriptor: fs.Stats, pathStat: StatLike): void {
  if (!descriptor.isFile()) {
    throw new CsvCoreError('NOT_REGULAR_FILE', '所选路径不是普通文件。');
  }
  if (
    !Number.isSafeInteger(descriptor.size)
    || descriptor.size < 0
    || descriptor.size > MAX_SOURCE_SIZE
  ) {
    throw new CsvCoreError('FILE_TOO_LARGE', 'CSV 文件不能超过 2 GiB。');
  }
  if (
    pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || typeof pathStat.dev !== 'number'
    || typeof pathStat.ino !== 'number'
    || descriptor.dev !== pathStat.dev
    || descriptor.ino !== pathStat.ino
  ) {
    throw new CsvCoreError('SOURCE_CHANGED', '文件路径在打开过程中发生了变化。');
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class ObservedSpoolWriter {
  failure: unknown = null;

  constructor(private readonly stream: Writable) {
    stream.on('error', (error) => {
      this.failure ??= error;
    });
  }

  async write(value: string): Promise<void> {
    this.throwIfFailed();
    await new Promise<void>((resolve, reject) => {
      this.stream.write(value, 'utf8', (error) => {
        if (error) {
          this.failure ??= error;
          reject(error);
        } else {
          resolve();
        }
      });
    });
    this.throwIfFailed();
  }

  async close(): Promise<void> {
    this.throwIfFailed();
    if (!this.stream.writableEnded) this.stream.end();
    try {
      await finished(this.stream, { cleanup: true });
    } catch (error) {
      this.failure ??= error;
      throw this.failure;
    }
    this.throwIfFailed();
  }

  async abort(): Promise<void> {
    if (!this.stream.destroyed) this.stream.destroy();
    try {
      await finished(this.stream, { cleanup: true });
    } catch (error) {
      this.failure ??= error;
    }
  }

  private throwIfFailed(): void {
    if (this.failure !== null) throw this.failure;
  }
}

class FieldSizeGuard extends Transform {
  private fieldBytes = 0;
  // Record bytes are the decoded field-content total; CSV delimiters and record terminators are syntax.
  private recordBytes = 0;
  private quoted = false;
  private pendingQuote = false;
  private atFieldStart = true;
  private atStreamStart = true;
  private previousCarriageReturn = false;
  private record = 1;
  private column = 1;

  constructor(
    private readonly delimiter: CsvDelimiter,
    private readonly maximumFieldBytes: number,
    private readonly maximumRecordBytes: number,
  ) {
    super({ decodeStrings: false });
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: string) => void,
  ): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    try {
      for (const character of text) {
        if (this.atStreamStart) {
          this.atStreamStart = false;
          if (character === '\uFEFF') continue;
        }
        this.consume(character);
      }
      callback(null, text);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private consume(character: string): void {
    if (this.quoted) {
      if (this.pendingQuote) {
        if (character === '"') {
          this.addBytes('"');
          this.pendingQuote = false;
          return;
        }
        this.pendingQuote = false;
        this.quoted = false;
        this.consumeOutsideQuotes(character);
        return;
      }
      if (character === '"') {
        this.pendingQuote = true;
      } else {
        this.addBytes(character);
      }
      return;
    }
    this.consumeOutsideQuotes(character);
  }

  private consumeOutsideQuotes(character: string): void {
    if (character === this.delimiter) {
      this.resetField();
      this.column += 1;
      this.previousCarriageReturn = false;
      return;
    }
    if (character === '\r') {
      this.resetRecord();
      this.previousCarriageReturn = true;
      return;
    }
    if (character === '\n') {
      if (!this.previousCarriageReturn) {
        this.resetRecord();
      } else {
        this.resetField();
        this.column = 1;
      }
      this.previousCarriageReturn = false;
      return;
    }
    this.previousCarriageReturn = false;
    if (character === '"' && this.atFieldStart) {
      this.quoted = true;
      this.atFieldStart = false;
      return;
    }
    this.addBytes(character);
    this.atFieldStart = false;
  }

  private addBytes(value: string): void {
    const byteLength = Buffer.byteLength(value, 'utf8');
    this.fieldBytes += byteLength;
    this.recordBytes += byteLength;
    if (this.fieldBytes > this.maximumFieldBytes) {
      throw new CsvCoreError('FIELD_TOO_LARGE', 'CSV 字段不能超过 16 MiB。', {
        record: this.record,
        column: this.column,
      });
    }
    if (this.recordBytes > this.maximumRecordBytes) {
      throw new CsvCoreError('RECORD_TOO_LARGE', 'CSV 记录不能超过 16 MiB。', {
        record: this.record,
      });
    }
  }

  private resetField(): void {
    this.fieldBytes = 0;
    this.quoted = false;
    this.pendingQuote = false;
    this.atFieldStart = true;
  }

  private resetRecord(): void {
    this.record += 1;
    this.recordBytes = 0;
    this.resetField();
    this.column = 1;
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
