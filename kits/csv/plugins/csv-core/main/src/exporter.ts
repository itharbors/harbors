import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import path from 'node:path';
import type { CsvRowsResult } from '@itharbors/csv-contracts';
import {
  CsvCoreError,
  type CsvExportInput,
  type CsvExportProgress,
  type CsvExportResult,
} from './protocol.js';

const EXPORT_PAGE_SIZE = 250;

export type CsvExporterOptions = {
  now: () => number;
  createWriteStream?: (outputPath: string, descriptor: number) => Writable;
  onProgress?: (progress: CsvExportProgress) => void;
  onCleanupError?: (error: unknown) => void;
};

export async function exportCsvRows(
  input: CsvExportInput,
  sourcePath: string,
  headers: readonly string[],
  signal: AbortSignal,
  getPage: (
    page: number,
    pageSize: 250,
    knownTotalRows?: number,
  ) => CsvRowsResult,
  options: CsvExporterOptions,
): Promise<CsvExportResult> {
  const startedAt = options.now();
  const outputPath = path.resolve(input.outputPath);
  if (outputPath === path.resolve(sourcePath)) {
    throw new CsvCoreError('UNSAFE_EXPORT', '导出目标不能与 CSV 源文件相同。');
  }
  assertExportActive(signal);

  // Validate and obtain a stable total before creating any output artifact.
  const firstPage = getPage(1, EXPORT_PAGE_SIZE);
  let handle: FileHandle | null = null;
  let writer: ObservedExportWriter | null = null;
  let created = false;
  const cancellationError = new CsvCoreError('EXPORT_CANCELLED', '已取消 CSV 导出。');
  const onAbort = (): void => writer?.destroy(cancellationError);
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    try {
      handle = await fsp.open(outputPath, 'wx', 0o600);
      created = true;
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) {
        throw new CsvCoreError('EXPORT_TARGET_EXISTS', '导出目标已存在，请选择新文件。');
      }
      throw error;
    }
    assertExportActive(signal);
    const stream = options.createWriteStream?.(outputPath, handle.fd)
      ?? fs.createWriteStream(outputPath, {
        autoClose: false,
        encoding: 'utf8',
        fd: handle.fd,
      });
    writer = new ObservedExportWriter(stream);
    await writer.write('\uFEFF');
    await writer.write(`${headers.map(encodeCsvCell).join(',')}\r\n`);

    let writtenRows = 0;
    let page = firstPage;
    while (page.rows.length > 0) {
      assertExportActive(signal);
      for (const row of page.rows) {
        await writer.write(`${row.values.map(encodeCsvCell).join(',')}\r\n`);
      }
      writtenRows += page.rows.length;
      reportProgress(options.onProgress, {
        connectionRevision: input.connectionRevision,
        exportId: input.exportId,
        outputPath,
        writtenRows,
        totalRows: firstPage.totalRows,
      });
      assertExportActive(signal);
      if (writtenRows >= firstPage.totalRows) break;
      page = getPage(
        Math.floor(writtenRows / EXPORT_PAGE_SIZE) + 1,
        EXPORT_PAGE_SIZE,
        firstPage.totalRows,
      );
      if (page.rows.length === 0) {
        throw new CsvCoreError('EXPORT_FAILED', 'CSV 导出结果在写入过程中发生变化。');
      }
    }

    await writer.close();
    writer = null;
    await handle.close();
    handle = null;
    assertExportActive(signal);
    const result = {
      connectionRevision: input.connectionRevision,
      exportId: input.exportId,
      outputPath,
      rowCount: writtenRows,
      elapsedMs: Math.max(0, options.now() - startedAt),
    };
    assertExportActive(signal);
    return result;
  } catch (error) {
    if (writer !== null) await writer.abort(error);
    if (handle !== null) {
      try {
        await handle.close();
      } catch (cleanupError) {
        options.onCleanupError?.(cleanupError);
      }
    }
    if (created) {
      try {
        await fsp.rm(outputPath);
      } catch (cleanupError) {
        if (!hasErrorCode(cleanupError, 'ENOENT')) options.onCleanupError?.(cleanupError);
      }
    }
    if (signal.aborted) throw cancellationError;
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function encodeCsvCell(value: string): string {
  if (!/[",\r\n]/u.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function assertExportActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CsvCoreError('EXPORT_CANCELLED', '已取消 CSV 导出。');
  }
}

function reportProgress(
  listener: CsvExporterOptions['onProgress'],
  progress: CsvExportProgress,
): void {
  try {
    listener?.(progress);
  } catch {
    // A progress observer is diagnostic and cannot change the export result.
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}

class ObservedExportWriter {
  private failure: unknown = null;

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

  async abort(error: unknown): Promise<void> {
    if (!this.stream.destroyed) {
      this.stream.destroy(error instanceof Error ? error : new Error(String(error)));
    }
    try {
      await finished(this.stream, { cleanup: true });
    } catch (streamError) {
      this.failure ??= streamError;
    }
  }

  destroy(error: Error): void {
    if (!this.stream.destroyed) this.stream.destroy(error);
  }

  private throwIfFailed(): void {
    if (this.failure !== null) throw this.failure;
  }
}
