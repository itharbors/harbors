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
      type: Exclude<FieldInputType, 'default' | 'null'>;
      value: string;
    };

export type FieldInputType =
  | 'default'
  | 'null'
  | 'integer'
  | 'decimal'
  | 'real'
  | 'text'
  | 'date'
  | 'time'
  | 'datetime'
  | 'timestamp'
  | 'json';

export type DraftColumn = {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  generated: boolean;
  autoIncrement: boolean;
  binary: boolean;
};

export type RecordFieldDraft = {
  name: string;
  dataType: string;
  inputType: FieldInputType;
  value: string;
  included: boolean;
  originalInputType: FieldInputType;
  originalValue: string;
};

const INTEGER_PATTERN = /^[+-]?\d+$/;
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function formatValue(value: SerializedValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value.type === 'blob') {
    const previewBytes = value.previewHex.length / 2;
    const suffix = value.size > previewBytes ? '…' : '';
    return `BLOB · ${value.size} B · ${value.previewHex}${suffix}`;
  }
  return value.value;
}

export function editableValueFromInput(
  inputType: Exclude<FieldInputType, 'default'>,
  value: string,
): EditableValue {
  switch (inputType) {
    case 'null':
      return { type: 'null' };
    case 'integer':
      if (!INTEGER_PATTERN.test(value)) throw new Error('Enter a base-10 integer');
      return { type: 'integer', value };
    case 'decimal':
      if (!DECIMAL_PATTERN.test(value)) throw new Error('Enter a valid decimal');
      return { type: 'decimal', value };
    case 'real':
      if (value.trim() === '' || !Number.isFinite(Number(value))) {
        throw new Error('Enter a finite real number');
      }
      return { type: 'real', value };
    case 'json':
      try {
        JSON.parse(value);
      } catch {
        throw new Error('Enter valid JSON');
      }
      return { type: 'json', value };
    case 'date':
    case 'time':
    case 'datetime':
    case 'timestamp':
      if (value.trim() === '') throw new Error(`Enter a ${inputType} value`);
      return { type: inputType, value };
    case 'text':
      return { type: 'text', value };
  }
}

export function createRecordDraft(
  columns: DraftColumn[],
  row?: SerializedValue[],
): RecordFieldDraft[] {
  return columns.flatMap<RecordFieldDraft>((column, index) => {
    if (column.generated || column.binary) return [];
    const current = row?.[index];
    const inputType = inferInputType(column.type, current);
    const value = current === undefined ? '' : editableText(current);
    const included = row !== undefined
      ? true
      : !column.autoIncrement && !column.nullable && column.defaultValue === null;
    return [{
      name: column.name,
      dataType: column.type,
      inputType,
      value,
      included,
      originalInputType: inputType,
      originalValue: value,
    }];
  });
}

function inferInputType(type: string, value: SerializedValue | undefined): FieldInputType {
  if (value === null) return 'null';
  if (typeof value === 'object' && value !== null && value.type !== 'blob') {
    return value.type;
  }
  const normalized = type.toLowerCase();
  if (/\b(?:tinyint|smallint|mediumint|int|integer|bigint|year)\b/.test(normalized)) {
    return 'integer';
  }
  if (/\b(?:decimal|numeric)\b/.test(normalized)) return 'decimal';
  if (/\b(?:float|double|real)\b/.test(normalized)) return 'real';
  if (/\btimestamp\b/.test(normalized)) return 'timestamp';
  if (/\bdatetime\b/.test(normalized)) return 'datetime';
  if (/\bdate\b/.test(normalized)) return 'date';
  if (/\btime\b/.test(normalized)) return 'time';
  if (/\bjson\b/.test(normalized)) return 'json';
  return 'text';
}

function editableText(value: SerializedValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value.type === 'blob') return '';
  return value.value;
}
