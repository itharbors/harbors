export type SerializedValue =
  | null
  | string
  | number
  | { type: 'integer'; value: string }
  | { type: 'blob'; size: number; previewHex: string };

export type EditableValue =
  | { type: 'null' }
  | { type: 'integer'; value: string }
  | { type: 'real'; value: string }
  | { type: 'text'; value: string };

export type DatabaseValue = null | string | number | bigint;

const PAGE_SIZES = new Set([25, 50, 100, 250]);
const INTEGER_PATTERN = /^[+-]?\d+$/;

export function quoteIdentifier(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('identifier must be a non-empty string');
  }
  return `"${name.replaceAll('"', '""')}"`;
}

export function serializeValue(value: unknown): SerializedValue {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('SQLite returned a non-finite number');
    }
    return value;
  }
  if (typeof value === 'bigint') {
    return { type: 'integer', value: value.toString() };
  }
  if (Buffer.isBuffer(value)) {
    return {
      type: 'blob',
      size: value.length,
      previewHex: value.subarray(0, 16).toString('hex'),
    };
  }
  throw new Error(`Unsupported SQLite value: ${typeof value}`);
}

export function deserializeEditableValue(value: unknown): DatabaseValue {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('editable value must include a type');
  }

  switch (value.type) {
    case 'null':
      return null;
    case 'integer':
      if (typeof value.value !== 'string' || !INTEGER_PATTERN.test(value.value)) {
        throw new Error('integer value must be a base-10 integer string');
      }
      return BigInt(value.value);
    case 'real': {
      if (typeof value.value !== 'string' || value.value.trim() === '') {
        throw new Error('real value must be a finite number');
      }
      const parsed = Number(value.value);
      if (!Number.isFinite(parsed)) {
        throw new Error('real value must be a finite number');
      }
      return parsed;
    }
    case 'text':
      if (typeof value.value !== 'string') {
        throw new Error('text value must be a string');
      }
      return value.value;
    default:
      throw new Error(`unsupported editable value type: ${value.type}`);
  }
}

export function parsePageInput(input: unknown): {
  page: number;
  pageSize: number;
  offset: number;
} {
  if (!isRecord(input)) throw new Error('pagination input must be an object');
  const { page, pageSize } = input;
  if (!Number.isInteger(page) || (page as number) < 1) {
    throw new Error('page must be an integer greater than or equal to 1');
  }
  if (!Number.isInteger(pageSize) || !PAGE_SIZES.has(pageSize as number)) {
    throw new Error('pageSize must be one of 25, 50, 100, or 250');
  }
  return {
    page: page as number,
    pageSize: pageSize as number,
    offset: ((page as number) - 1) * (pageSize as number),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
