import type { SerializedValue } from './view-model.js';

export function rowsToCsv(columns: string[], rows: SerializedValue[][]): string {
  return [
    columns.map(csvCell).join(','),
    ...rows.map((row) => row.map((value) => csvCell(displayValue(value))).join(',')),
  ].join('\r\n');
}

export function createDownload(fileName: string, mimeType: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function displayValue(value: SerializedValue): string {
  if (value === null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return value.type === 'integer' ? value.value : value.previewHex;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
