import { sqliteCopy } from './copy.js';

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

export type FieldInputType = 'default' | 'null' | 'integer' | 'real' | 'text';

export type DraftColumn = {
  name: string;
  type: string;
  hidden: boolean;
  generated: boolean;
};

export type RecordFieldDraft = {
  name: string;
  affinity: string;
  inputType: FieldInputType;
  value: string;
};

const INTEGER_PATTERN = /^[+-]?\d+$/;

export function formatValue(value: SerializedValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value.type === 'integer') return value.value;
  const previewBytes = value.previewHex.length / 2;
  const suffix = value.size > previewBytes ? '…' : '';
  return `BLOB · ${value.size} B · ${value.previewHex}${suffix}`;
}

export function editableValueFromInput(
  inputType: Exclude<FieldInputType, 'default'>,
  value: string,
): EditableValue {
  switch (inputType) {
    case 'null':
      return { type: 'null' };
    case 'integer':
      if (!INTEGER_PATTERN.test(value)) {
        throw new Error(sqliteCopy.validation.integer);
      }
      return { type: 'integer', value };
    case 'real':
      if (value.trim() === '' || !Number.isFinite(Number(value))) {
        throw new Error(sqliteCopy.validation.real);
      }
      return { type: 'real', value };
    case 'text':
      return { type: 'text', value };
  }
}

export function createRecordDraft(
  columns: DraftColumn[],
  row?: SerializedValue[],
): RecordFieldDraft[] {
  return columns.flatMap<RecordFieldDraft>((column, index) => {
    if (column.hidden || column.generated || /\bBLOB\b/i.test(column.type)) return [];
    const affinity = column.type || 'ANY';
    if (!row) {
      return [{ name: column.name, affinity, inputType: 'default' as const, value: '' }];
    }
    const value = row[index];
    if (value === null) {
      return [{ name: column.name, affinity, inputType: 'null' as const, value: '' }];
    }
    if (typeof value === 'object' && value.type === 'integer') {
      return [{ name: column.name, affinity, inputType: 'integer' as const, value: value.value }];
    }
    if (typeof value === 'number') {
      return [{ name: column.name, affinity, inputType: 'real' as const, value: String(value) }];
    }
    return [{ name: column.name, affinity, inputType: 'text' as const, value: String(value) }];
  });
}
