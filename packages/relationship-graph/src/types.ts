export type RelationshipColumn = {
  name: string;
  type: string;
  primaryKeyOrder: number;
  foreignKey: boolean;
};

export type RelationshipTable = {
  name: string;
  kind: string;
  columns: RelationshipColumn[];
};

export type Relationship = {
  id: string;
  fromTable: string;
  toTable: string;
  columns: Array<{ from: string; to: string | null }>;
  onUpdate: string;
  onDelete: string;
};

export type RelationshipGraph = {
  tables: RelationshipTable[];
  relationships: Relationship[];
};

export type CanvasSize = { width: number; height: number };
export type RelationshipViewport = { x: number; y: number; scale: number };
export type NodePosition = { x: number; y: number };

export type RelationshipNodeLayout = NodePosition & {
  name: string;
  width: number;
  height: number;
  group: string;
};

export type RelationshipEdgeLayout = {
  id: string;
  fromTable: string;
  toTable: string;
  path: string;
};

export type RelationshipLayout = {
  width: number;
  height: number;
  nodes: RelationshipNodeLayout[];
  edges: RelationshipEdgeLayout[];
};

export type PersistedRelationshipStateV1 = {
  nodes: Record<string, NodePosition>;
  viewport: RelationshipViewport;
  canvas: CanvasSize;
};
