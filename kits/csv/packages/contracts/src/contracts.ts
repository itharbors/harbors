export const CSV_CORE = '@itharbors/csv-core';
export const CSV_EXPLORER = '@itharbors/csv-explorer';

export const CSV_TOPICS = {
  connectionChanged: '@itharbors/csv.connection.changed',
  progressChanged: '@itharbors/csv.progress.changed',
  schemaChanged: '@itharbors/csv.schema.changed',
  exportProgress: '@itharbors/csv.export.progress',
} as const;

export type CsvEncoding = 'utf8' | 'gb18030';
export type CsvDelimiter = ',' | '\t' | ';';
export type CsvConnectionPhase = 'closed' | 'sampling' | 'indexing' | 'ready' | 'error';

export type CsvConnectionSnapshot = {
  connectionRevision: number;
  phase: CsvConnectionPhase;
  path: string | null;
  fileName: string | null;
  encoding: CsvEncoding | null;
  delimiter: CsvDelimiter | null;
  hasHeader: boolean | null;
  progress: number | null;
  error: CsvPublicError | null;
  byteSize: number | null;
  rowCount: number | null;
  columnCount: number | null;
  irregularRowCount: number | null;
};

export type CsvSamplePreview = {
  cells: string[];
  truncated: boolean;
};

export type CsvSampleResult = {
  path: string;
  fileName: string;
  size: number;
  modifiedAt: string;
  suggestion: { encoding: CsvEncoding; delimiter: CsvDelimiter; hasHeader: boolean };
  preview: CsvSamplePreview;
};

export type CsvSampleInput = {
  path: string;
  encoding?: CsvEncoding;
  delimiter?: CsvDelimiter;
};

export type CsvOpenInput = {
  path: string;
  encoding: CsvEncoding;
  delimiter: CsvDelimiter;
  hasHeader: boolean;
};

export type CsvCancelOpenInput = {
  connectionRevision: number;
};

export type CsvFilter = {
  columnId: string;
  operator: 'contains' | 'equals' | 'is-empty' | 'is-not-empty';
  value?: string;
};

export type CsvQuery = {
  connectionRevision: number;
  page: number;
  pageSize: 25 | 50 | 100 | 250;
  search: string;
  filters: CsvFilter[];
  sort: { columnId: string; direction: 'asc' | 'desc' } | null;
};

export type CsvRowsResult = {
  connectionRevision: number;
  page: number;
  pageSize: CsvQuery['pageSize'];
  totalRows: number;
  rows: Array<{ record: number; values: string[] }>;
};

export type CsvSchema = {
  connectionRevision: number;
  columns: Array<{ id: string; index: number; name: string }>;
  irregularRecordCount: number;
};

export type CsvColumnStats = {
  connectionRevision: number;
  columnId: string;
  emptyCount: number;
  nonEmptyCount: number;
  maxLength: number;
};

export type CsvOpenProgress = {
  connectionRevision: number;
  progress: number;
};

export type CsvExportInput = CsvQuery & {
  exportId: string;
  outputPath: string;
};

export type CsvExportResult = {
  connectionRevision: number;
  exportId: string;
  outputPath: string;
  rowCount: number;
  elapsedMs: number;
};

export type CsvExportProgress = {
  connectionRevision: number;
  exportId: string;
  outputPath: string;
  writtenRows: number;
  totalRows: number;
};

export type CsvCancelExportInput = {
  connectionRevision: number;
  exportId: string;
};

export type CsvPublicError = {
  code: string;
  message: string;
  record?: number;
  line?: number;
  column?: number;
};

export type CsvErrorEnvelope = {
  $csvError: CsvPublicError;
};
