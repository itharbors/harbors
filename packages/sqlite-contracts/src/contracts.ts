export const SQLITE_CORE = '@itharbors/sqlite-core';
export const SQLITE_EXPLORER = '@itharbors/sqlite-explorer';

export const CORE_TOPICS = {
  connectionChanged: '@itharbors/sqlite.connection.changed',
  schemaChanged: '@itharbors/sqlite.schema.changed',
  dataChanged: '@itharbors/sqlite.data.changed',
} as const;

export const SELECTION_CHANGED_TOPIC = '@itharbors/sqlite.selection.changed';
export const OBJECTS_CHANGED_TOPIC = '@itharbors/sqlite.objects.changed';

export type RevisionSnapshot = {
  connectionRevision: number;
  schemaRevision: number;
  dataRevision: number;
};

export type ConnectionSnapshot = RevisionSnapshot & {
  connected: boolean;
  path: string | null;
  fileName?: string | null;
  mode: 'readonly' | 'readwrite' | null;
  sqliteVersion: string | null;
  foreignKeys?: boolean | null;
  busyTimeout?: number | null;
};

export type SchemaSnapshot<TObject = unknown> = RevisionSnapshot & {
  objects: TObject[];
};

export type DataChangedEvent = RevisionSnapshot & {
  objectName: string | null;
};

export type SelectionSnapshot = {
  connectionRevision: number;
  objectName: string | null;
};

export type ObjectsSnapshot<TObject = unknown> = {
  connected: boolean;
  connectionRevision: number;
  schemaRevision: number;
  objects: TObject[];
  selection: SelectionSnapshot;
  error?: { message: string; detail?: string } | null;
};

export type SqlitePublicError = {
  code: string;
  message: string;
  detail?: string;
};

export type SqliteErrorEnvelope = {
  $sqliteError: SqlitePublicError;
};
