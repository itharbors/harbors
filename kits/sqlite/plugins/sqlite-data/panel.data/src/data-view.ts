import { formatValue, type SerializedValue } from './view-model.js';

type RowIdentity =
  | { kind: 'primary-key'; values: Record<string, SerializedValue> }
  | { kind: 'rowid'; value: SerializedValue };

export function identitySummary(identity: RowIdentity): string {
  if (identity.kind === 'rowid') return `rowid = ${formatValue(identity.value)}`;
  return Object.entries(identity.values)
    .map(([column, value]) => `${column} = ${formatValue(value)}`)
    .join(' · ');
}

export function limitRenderedRows<T>(rows: T[]): T[] {
  return rows.slice(0, 50);
}
