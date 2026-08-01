import type { SqliteErrorEnvelope, SqlitePublicError } from './contracts.js';

export class SqliteRequestError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(error: SqlitePublicError) {
    super(error.message);
    this.name = 'SqliteRequestError';
    this.code = error.code;
    this.detail = error.detail;
  }
}

export function unwrapSqliteResponse<T>(value: unknown): T {
  if (isRecord(value) && '$sqliteError' in value && isPublicError(value.$sqliteError)) {
    throw new SqliteRequestError(value.$sqliteError);
  }
  return value as T;
}

export function isSqliteErrorEnvelope(value: unknown): value is SqliteErrorEnvelope {
  return isRecord(value) && '$sqliteError' in value && isPublicError(value.$sqliteError);
}

function isPublicError(value: unknown): value is SqlitePublicError {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.message === 'string'
    && (value.detail === undefined || typeof value.detail === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
