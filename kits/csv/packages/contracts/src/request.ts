import type { CsvErrorEnvelope, CsvPublicError } from './contracts.js';

export const CSV_CORE_REQUEST_NAMES = [
  'sampleFile',
  'openFile',
  'getConnectionState',
  'cancelOpen',
  'closeFile',
  'getSchema',
  'getRows',
  'getColumnStats',
  'exportRows',
  'cancelExport',
] as const;

export type CsvCoreRequestName = typeof CSV_CORE_REQUEST_NAMES[number];

export class CsvRequestError extends Error {
  readonly code: string;
  readonly record?: number;
  readonly line?: number;
  readonly column?: number;

  constructor(error: CsvPublicError) {
    super(error.message);
    this.name = 'CsvRequestError';
    this.code = error.code;
    this.record = error.record;
    this.line = error.line;
    this.column = error.column;
  }
}

export function unwrapCsvResponse<T>(value: unknown): T {
  if (isCsvErrorEnvelope(value)) throw new CsvRequestError(value.$csvError);
  return value as T;
}

export function isCsvErrorEnvelope(value: unknown): value is CsvErrorEnvelope {
  return isRecord(value) && '$csvError' in value && isPublicError(value.$csvError);
}

function isPublicError(value: unknown): value is CsvPublicError {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.message === 'string'
    && (value.record === undefined || typeof value.record === 'number')
    && (value.line === undefined || typeof value.line === 'number')
    && (value.column === undefined || typeof value.column === 'number');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
