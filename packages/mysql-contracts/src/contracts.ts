export const MYSQL_CORE = '@itharbors/mysql-core';
export const MYSQL_EXPLORER = '@itharbors/mysql-explorer';

export const CORE_TOPICS = {
  connectionChanged: '@itharbors/mysql.connection.changed',
  schemaChanged: '@itharbors/mysql.schema.changed',
  dataChanged: '@itharbors/mysql.data.changed',
} as const;

export const SELECTION_CHANGED_TOPIC = '@itharbors/mysql.selection.changed';
export const OBJECTS_CHANGED_TOPIC = '@itharbors/mysql.objects.changed';

export type RevisionSnapshot = {
  connectionRevision: number;
  schemaRevision: number;
  dataRevision: number;
};

export type ConnectionSnapshot = RevisionSnapshot & {
  connected: boolean;
  endpoint: string | null;
  database: string | null;
  mysqlVersion: string | null;
  tls: boolean;
};

export type DatabasesSnapshot = RevisionSnapshot & {
  databases: string[];
};

export type SchemaSnapshot<TObject = unknown> = RevisionSnapshot & {
  objects: TObject[];
};

export type SelectionSnapshot = {
  connectionRevision: number;
  objectName: string | null;
};

export type ObjectsSnapshot<TObject = unknown> = {
  connected: boolean;
  database: string | null;
  databases: string[];
  connectionRevision: number;
  schemaRevision: number;
  objects: TObject[];
  selection: SelectionSnapshot;
  error?: { message: string; detail?: string } | null;
};

export type DataChangedEvent = RevisionSnapshot & {
  objectName: string | null;
};

export type RelationshipColumn = {
  name: string;
  type: string;
  primaryKeyOrder: number;
  foreignKey: boolean;
};

export type RelationshipTable = {
  name: string;
  kind: 'table';
  columns: RelationshipColumn[];
};

export type Relationship = {
  id: string;
  fromTable: string;
  toTable: string;
  columns: Array<{ from: string; to: string }>;
  onUpdate: string;
  onDelete: string;
};

export type RelationshipGraph = {
  tables: RelationshipTable[];
  relationships: Relationship[];
};

export type MysqlPublicError = {
  code: string;
  message: string;
  detail?: string;
};

export type MysqlErrorEnvelope = {
  $mysqlError: MysqlPublicError;
};
