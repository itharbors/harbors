export type SerializedValue =
  | null
  | string
  | number
  | boolean
  | { type: 'integer'; mysqlType: 'BIGINT' | 'BIGINT UNSIGNED'; value: string }
  | { type: 'decimal'; value: string }
  | { type: 'date' | 'time' | 'datetime' | 'timestamp'; value: string }
  | { type: 'json'; value: string }
  | { type: 'blob'; size: number; previewHex: string };

export type EditableValue =
  | { type: 'null' }
  | {
      type:
        | 'integer'
        | 'decimal'
        | 'real'
        | 'text'
        | 'date'
        | 'time'
        | 'datetime'
        | 'timestamp'
        | 'json';
      value: string;
    };

export type ConnectionInput = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string | null;
  tls: boolean;
};

export type DatabaseValue = null | string | number | boolean;

export type ConnectionMetadata = Omit<ConnectionInput, 'password'>;

export type ConnectionProfileUpdateInput = {
  profileId: string;
  password: string;
};

const PAGE_SIZES = new Set([25, 50, 100, 250]);
const INTEGER_PATTERN = /^[+-]?\d+$/;
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONNECTION_KEYS = ['host', 'port', 'user', 'password', 'database', 'tls'] as const;
const METADATA_KEYS = ['host', 'port', 'user', 'database', 'tls'] as const;
const PROFILE_ID_KEYS = ['profileId'] as const;
const PROFILE_LABEL_KEYS = ['label'] as const;
const PROFILE_UPDATE_KEYS = ['profileId', 'password'] as const;
const MAX_HOST_LENGTH = 255;
const MAX_USER_LENGTH = 128;
const MAX_DATABASE_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 4096;
const MAX_LABEL_LENGTH = 80;

export function parseConnectionInput(input: unknown): ConnectionInput {
  if (!isRecord(input)) {
    throw new Error('connection input must be an object');
  }
  requireExactKeys(input, CONNECTION_KEYS, 'connection input');

  const host = requireBoundedTrimmedString(input.host, 'host', MAX_HOST_LENGTH);
  if (!Number.isInteger(input.port) || (input.port as number) < 1 || (input.port as number) > 65_535) {
    throw new Error('port must be an integer between 1 and 65535');
  }
  const user = requireBoundedTrimmedString(input.user, 'user', MAX_USER_LENGTH);
  const password = requireBoundedString(input.password, 'password', MAX_PASSWORD_LENGTH);
  const database = optionalBoundedTrimmedString(input.database, 'database', MAX_DATABASE_LENGTH);
  if (typeof input.tls !== 'boolean') {
    throw new Error('tls must be a boolean');
  }

  return {
    host,
    port: input.port as number,
    user,
    password,
    database,
    tls: input.tls,
  };
}

export function parseProfileIdInput(input: unknown): { profileId: string } {
  if (!isRecord(input)) throw new Error('profile input must be an object');
  requireExactKeys(input, PROFILE_ID_KEYS, 'profile input');
  return { profileId: parseProfileId(input.profileId) };
}

export function parseProfileLabelInput(input: unknown): { label: string } {
  if (!isRecord(input)) throw new Error('profile label input must be an object');
  requireExactKeys(input, PROFILE_LABEL_KEYS, 'profile label input');
  return { label: requireBoundedTrimmedString(input.label, 'label', MAX_LABEL_LENGTH) };
}

export function parseConnectionMetadata(input: unknown): ConnectionMetadata {
  if (!isRecord(input)) throw new Error('connection metadata must be an object');
  requireExactKeys(input, METADATA_KEYS, 'connection metadata');
  const { host, port, user, database, tls } = parseConnectionInput({ ...input, password: '' });
  return { host, port, user, database, tls };
}

export function parseConnectionProfileUpdateInput(input: unknown): ConnectionProfileUpdateInput {
  if (!isRecord(input)) throw new Error('profile update input must be an object');
  requireExactKeys(input, PROFILE_UPDATE_KEYS, 'profile update input');
  return {
    profileId: parseProfileId(input.profileId),
    password: requireBoundedString(input.password, 'password', MAX_PASSWORD_LENGTH),
  };
}

export function parseProfileId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error('profileId must be a UUID');
  }
  return value.toLowerCase();
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

export function quoteIdentifier(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('identifier must be a non-empty string');
  }
  return `\`${name.replaceAll('`', '``')}\``;
}

export function serializeMysqlValue(value: unknown, mysqlType: string): SerializedValue {
  if (value === null) return null;
  if (Buffer.isBuffer(value)) {
    return {
      type: 'blob',
      size: value.length,
      previewHex: value.subarray(0, 16).toString('hex'),
    };
  }

  const normalizedType = mysqlType.trim().toUpperCase();
  if (normalizedType === 'LONGLONG' || normalizedType === 'LONGLONG UNSIGNED') {
    if (!['string', 'number', 'bigint'].includes(typeof value)) {
      throw new Error('MySQL returned an invalid BIGINT value');
    }
    return {
      type: 'integer',
      mysqlType: normalizedType.endsWith('UNSIGNED') ? 'BIGINT UNSIGNED' : 'BIGINT',
      value: String(value),
    };
  }
  if (normalizedType === 'DECIMAL' || normalizedType === 'NEWDECIMAL') {
    if (!['string', 'number', 'bigint'].includes(typeof value)) {
      throw new Error('MySQL returned an invalid DECIMAL value');
    }
    return { type: 'decimal', value: String(value) };
  }
  if (normalizedType === 'DATE' || normalizedType === 'NEWDATE') {
    return { type: 'date', value: requireValueString(value, 'DATE') };
  }
  if (normalizedType === 'TIME') {
    return { type: 'time', value: requireValueString(value, 'TIME') };
  }
  if (normalizedType === 'DATETIME') {
    return { type: 'datetime', value: requireValueString(value, 'DATETIME') };
  }
  if (normalizedType === 'TIMESTAMP') {
    return { type: 'timestamp', value: requireValueString(value, 'TIMESTAMP') };
  }
  if (normalizedType === 'JSON') {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (serialized === undefined) throw new Error('MySQL returned an invalid JSON value');
    return { type: 'json', value: serialized };
  }

  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('MySQL returned a non-finite number');
    return value;
  }
  if (typeof value === 'bigint') {
    return { type: 'integer', mysqlType: 'BIGINT', value: value.toString() };
  }
  throw new Error(`Unsupported MySQL value: ${typeof value}`);
}

export function deserializeEditableValue(value: unknown): DatabaseValue {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('editable value must include a type');
  }
  if (value.type === 'null') return null;
  if (typeof value.value !== 'string') {
    throw new Error(`${value.type} value must be a string`);
  }

  switch (value.type) {
    case 'integer':
      if (!INTEGER_PATTERN.test(value.value)) {
        throw new Error('integer value must be a base-10 integer string');
      }
      return value.value;
    case 'decimal':
      if (!DECIMAL_PATTERN.test(value.value)) {
        throw new Error('decimal value must be a valid decimal string');
      }
      return value.value;
    case 'real': {
      if (value.value.trim() === '') throw new Error('real value must be a finite number');
      const parsed = Number(value.value);
      if (!Number.isFinite(parsed)) throw new Error('real value must be a finite number');
      return parsed;
    }
    case 'json':
      try {
        JSON.parse(value.value);
      } catch {
        throw new Error('JSON value must be valid JSON');
      }
      return value.value;
    case 'text':
    case 'date':
    case 'time':
    case 'datetime':
    case 'timestamp':
      return value.value;
    default:
      throw new Error(`unsupported editable value type: ${value.type}`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireBoundedTrimmedString(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if ([...normalized].length > maximumLength) {
    throw new Error(`${name} must be at most ${maximumLength} characters`);
  }
  return normalized;
}

function optionalBoundedTrimmedString(
  value: unknown,
  name: string,
  maximumLength: number,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`${name} must be a string or null`);
  const normalized = value.trim();
  if ([...normalized].length > maximumLength) {
    throw new Error(`${name} must be at most ${maximumLength} characters`);
  }
  return normalized || null;
}

function requireBoundedString(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if ([...value].length > maximumLength) {
    throw new Error(`${name} must be at most ${maximumLength} characters`);
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  name: string,
): void {
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) {
    throw new Error(`${name} must contain own fields: ${missing.join(', ')}`);
  }
  const unexpected = Reflect.ownKeys(value).filter(
    (key) => typeof key !== 'string' || !expected.has(key),
  );
  if (unexpected.length > 0) {
    throw new Error(`${name} contains unexpected fields: ${unexpected.map(String).join(', ')}`);
  }
}

function requireValueString(value: unknown, type: string): string {
  if (typeof value !== 'string') throw new Error(`MySQL returned an invalid ${type} value`);
  return value;
}
