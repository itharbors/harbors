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

export type ConnectionMode = 'readonly' | 'readwrite';
export type ObjectKind = 'table' | 'view' | 'virtual' | 'shadow';
export type SortDirection = 'asc' | 'desc';
export type FilterOperator = 'contains' | 'equals' | 'is-null' | 'is-not-null';
export type ExportFormat = 'csv' | 'json';

export type SortInput = {
  column: string;
  direction: SortDirection;
};

export type FilterInput = {
  column: string;
  operator: FilterOperator;
  value?: string;
};

export type RowQuery = {
  name: string;
  page: number;
  pageSize: 25 | 50;
  offset: number;
  search?: string;
  filters: FilterInput[];
  sorts: SortInput[];
};

export type ExportRequest = Omit<RowQuery, 'page' | 'pageSize' | 'offset'> & {
  format: ExportFormat;
};

export type PublicError = {
  code: string;
  message: string;
  detail?: string;
};

const PAGE_SIZES = new Set([25, 50]);
const CONNECTION_MODES = new Set<ConnectionMode>(['readonly', 'readwrite']);
const FILTER_OPERATORS = new Set<FilterOperator>([
  'contains',
  'equals',
  'is-null',
  'is-not-null',
]);
const SORT_DIRECTIONS = new Set<SortDirection>(['asc', 'desc']);
const EXPORT_FORMATS = new Set<ExportFormat>(['csv', 'json']);
const INTEGER_PATTERN = /^[+-]?\d+$/;

export class WorkbenchError extends Error {
  readonly code: string;
  readonly detail?: string;
  readonly userMessage: string;

  constructor(code: string, message: string, detail?: string) {
    super(`[${code}] ${message}`);
    this.name = 'WorkbenchError';
    this.code = code;
    this.detail = detail;
    this.userMessage = message;
  }
}

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
  pageSize: 25 | 50;
  offset: number;
} {
  if (!isRecord(input)) throw new Error('pagination input must be an object');
  const { page, pageSize } = input;
  if (!Number.isInteger(page) || (page as number) < 1) {
    throw new Error('page must be an integer greater than or equal to 1');
  }
  if (!Number.isInteger(pageSize) || !PAGE_SIZES.has(pageSize as number)) {
    throw new Error('pageSize must be one of 25 or 50');
  }
  return {
    page: page as number,
    pageSize: pageSize as 25 | 50,
    offset: ((page as number) - 1) * (pageSize as number),
  };
}

export function parseConnectionMode(value: unknown): ConnectionMode {
  if (typeof value !== 'string' || !CONNECTION_MODES.has(value as ConnectionMode)) {
    throw new Error('mode must be readonly or readwrite');
  }
  return value as ConnectionMode;
}

export function parseRowQuery(input: unknown): RowQuery {
  const record = requireRecord(input, 'row query');
  const name = requireString(record.name, 'name');
  const pagination = parsePageInput(record);
  const search = optionalTrimmedString(record.search, 'search');
  return {
    name,
    ...pagination,
    ...(search === undefined ? {} : { search }),
    filters: parseFilters(record.filters),
    sorts: parseSorts(record.sorts),
  };
}

export function parseExportRequest(input: unknown): ExportRequest {
  const record = requireRecord(input, 'export request');
  const name = requireString(record.name, 'name');
  if (typeof record.format !== 'string' || !EXPORT_FORMATS.has(record.format as ExportFormat)) {
    throw new Error('format must be csv or json');
  }
  const search = optionalTrimmedString(record.search, 'search');
  return {
    name,
    format: record.format as ExportFormat,
    ...(search === undefined ? {} : { search }),
    filters: parseFilters(record.filters),
    sorts: parseSorts(record.sorts),
  };
}

export function parseFilters(value: unknown): FilterInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('filters must be an array');
  return value.map((item, index) => {
    const record = requireRecord(item, `filter ${index + 1}`);
    const column = requireString(record.column, `filter ${index + 1} column`);
    if (
      typeof record.operator !== 'string'
      || !FILTER_OPERATORS.has(record.operator as FilterOperator)
    ) {
      throw new Error(`filter ${index + 1} has an unsupported operator`);
    }
    const operator = record.operator as FilterOperator;
    if (operator === 'is-null' || operator === 'is-not-null') {
      return { column, operator };
    }
    if (typeof record.value !== 'string') {
      throw new Error(`filter ${index + 1} value must be a string`);
    }
    return { column, operator, value: record.value };
  });
}

export function parseSorts(value: unknown): SortInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('sorts must be an array');
  return value.map((item, index) => {
    const record = requireRecord(item, `sort ${index + 1}`);
    const column = requireString(record.column, `sort ${index + 1} column`);
    if (
      typeof record.direction !== 'string'
      || !SORT_DIRECTIONS.has(record.direction as SortDirection)
    ) {
      throw new Error(`sort ${index + 1} has an unsupported direction`);
    }
    return { column, direction: record.direction as SortDirection };
  });
}

export function toPublicError(error: unknown): PublicError {
  if (error instanceof WorkbenchError) {
    return {
      code: error.code,
      message: error.userMessage,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: '操作失败，请查看详情。',
    detail: error instanceof Error ? error.message : String(error),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalTrimmedString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
