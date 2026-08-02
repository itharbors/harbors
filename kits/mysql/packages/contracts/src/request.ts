import type { MysqlErrorEnvelope, MysqlPublicError } from './contracts.js';

export class MysqlRequestError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(error: MysqlPublicError) {
    super(error.message);
    this.name = 'MysqlRequestError';
    this.code = error.code;
    this.detail = error.detail;
  }
}

export function unwrapMysqlResponse<T>(value: unknown): T {
  if (isMysqlErrorEnvelope(value)) throw new MysqlRequestError(value.$mysqlError);
  return value as T;
}

export function isMysqlErrorEnvelope(value: unknown): value is MysqlErrorEnvelope {
  return isRecord(value) && '$mysqlError' in value && isPublicError(value.$mysqlError);
}

function isPublicError(value: unknown): value is MysqlPublicError {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.message === 'string'
    && (value.detail === undefined || typeof value.detail === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
