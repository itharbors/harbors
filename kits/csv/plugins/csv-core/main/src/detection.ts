import type { CsvDelimiter, CsvEncoding } from '@itharbors/csv-contracts';
import { parse } from 'csv-parse/sync';
import { CsvCoreError } from './protocol.js';

const DELIMITERS: CsvDelimiter[] = [',', '\t', ';'];

export type CsvSampleSuggestion = {
  encoding: CsvEncoding;
  delimiter: CsvDelimiter;
  hasHeader: boolean;
};

export type CsvSamplePreview = {
  cells: string[];
  truncated: boolean;
};

const SAMPLE_PREVIEW_CELLS = 3;
const SAMPLE_PREVIEW_CHARACTERS = 48;

export function decodeSample(
  buffer: Buffer,
  encoding: CsvEncoding,
  allowIncompleteTrailingSequence = false,
): string {
  try {
    return new TextDecoder(encoding === 'utf8' ? 'utf-8' : 'gb18030', { fatal: true }).decode(buffer, {
      stream: allowIncompleteTrailingSequence,
    });
  } catch (error) {
    throw new CsvCoreError(
      'INVALID_ENCODING',
      `文件不是有效的 ${encoding === 'utf8' ? 'UTF-8' : 'GB18030'}。`,
      {},
      { cause: error },
    );
  }
}

export function detectSample(
  buffer: Buffer,
  allowIncompleteTrailingSequence = false,
): CsvSampleSuggestion & { preview: CsvSamplePreview } {
  const hasUtf8Bom = buffer.length >= 3
    && buffer[0] === 0xef
    && buffer[1] === 0xbb
    && buffer[2] === 0xbf;
  let encoding: CsvEncoding = 'utf8';
  let text: string;
  if (hasUtf8Bom) {
    text = decodeSample(buffer.subarray(3), 'utf8', allowIncompleteTrailingSequence);
  } else {
    try {
      text = decodeSample(buffer, 'utf8', allowIncompleteTrailingSequence);
    } catch {
      encoding = 'gb18030';
      text = decodeSample(buffer, encoding, allowIncompleteTrailingSequence);
    }
  }
  const delimiter = detectDelimiter(text);
  const records = parseRecords(text, delimiter);
  return {
    encoding,
    delimiter,
    hasHeader: suggestHeader(records),
    preview: previewRecord(records[0] ?? []),
  };
}

export function previewSample(
  buffer: Buffer,
  encoding: CsvEncoding,
  delimiter: CsvDelimiter,
  allowIncompleteTrailingSequence = false,
): CsvSamplePreview {
  return previewRecord(parseRecords(
    decodeSample(buffer, encoding, allowIncompleteTrailingSequence),
    delimiter,
  )[0] ?? []);
}

function previewRecord(record: string[]): CsvSamplePreview {
  let truncated = record.length > SAMPLE_PREVIEW_CELLS;
  const cells = record.slice(0, SAMPLE_PREVIEW_CELLS).map((value) => {
    const characters = [...value];
    if (characters.length <= SAMPLE_PREVIEW_CHARACTERS) return value;
    truncated = true;
    return characters.slice(0, SAMPLE_PREVIEW_CHARACTERS).join('');
  });
  return { cells, truncated };
}

export function detectDelimiter(text: string): CsvDelimiter {
  const candidates = DELIMITERS.map((delimiter, priority) => {
    const records = parseRecords(text, delimiter);
    const widths = records.map((record) => record.length);
    const counts = new Map<number, number>();
    for (const width of widths) counts.set(width, (counts.get(width) ?? 0) + 1);
    let modalWidth = 1;
    let modalCount = 0;
    for (const [width, count] of counts) {
      if (count > modalCount || (count === modalCount && width > modalWidth)) {
        modalWidth = width;
        modalCount = count;
      }
    }
    return {
      delimiter,
      priority,
      parsedRecordCount: records.length,
      modalWidth,
      inconsistentRecordCount: records.length - modalCount,
    };
  });

  candidates.sort((left, right) =>
    right.parsedRecordCount - left.parsedRecordCount
    || right.modalWidth - left.modalWidth
    || left.inconsistentRecordCount - right.inconsistentRecordCount
    || left.priority - right.priority);
  return candidates[0].delimiter;
}

function parseRecords(text: string, delimiter: CsvDelimiter): string[][] {
  try {
    return parse(text, {
      bom: true,
      delimiter,
      quote: '"',
      relax_column_count: true,
      relax_quotes: false,
      skip_empty_lines: false,
    }) as string[][];
  } catch {
    return [];
  }
}

function suggestHeader(records: string[][]): boolean {
  if (records.length < 2 || records[0].length === 0) return false;
  const first = records[0];
  let votes = 0;
  for (let column = 0; column < first.length; column += 1) {
    const later = records.slice(1).map((record) => record[column] ?? '');
    const nonEmptyLater = later.filter((value) => value !== '');
    if (nonEmptyLater.length === 0) continue;
    const laterKinds = new Set(nonEmptyLater.map(valueKind));
    if (laterKinds.size === 1 && !laterKinds.has(valueKind(first[column]))) {
      votes += 1;
      continue;
    }
    const laterLengths = new Set(nonEmptyLater.map((value) => [...value].length));
    if (laterLengths.size === 1) {
      votes += laterLengths.has([...first[column]].length) ? -1 : 1;
    }
  }
  return votes > 0;
}

function valueKind(value: string): 'empty' | 'number' | 'boolean' | 'text' {
  if (value === '') return 'empty';
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return 'number';
  if (/^(?:true|false)$/i.test(value)) return 'boolean';
  return 'text';
}
