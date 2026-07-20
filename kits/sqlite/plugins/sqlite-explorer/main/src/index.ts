import {
  OBJECTS_CHANGED_TOPIC,
  SQLITE_CORE,
  SELECTION_CHANGED_TOPIC,
  unwrapSqliteResponse,
  type ObjectsSnapshot,
  type SchemaSnapshot,
  type SelectionSnapshot,
} from '@itharbors/sqlite-contracts';

declare const editor: any;

type Runtime = {
  message: {
    request(plugin: string, method: string, input?: unknown): Promise<unknown>;
    broadcast(topic: string, payload: unknown): void;
  };
};

type SchemaObject = {
  name: string;
  kind?: 'table' | 'view' | 'virtual' | 'shadow';
};

type ConnectionEvent = {
  connected: boolean;
  connectionRevision: number;
  schemaRevision: number;
};

const DISCONNECTED_SNAPSHOT: ObjectsSnapshot<SchemaObject> = {
  connected: false,
  connectionRevision: 0,
  schemaRevision: 0,
  objects: [],
  selection: { connectionRevision: 0, objectName: null },
};

let runtime: Runtime | undefined;
let snapshot = cloneSnapshot(DISCONNECTED_SNAPSHOT);
let lastPublishedSelection: SelectionSnapshot = { ...DISCONNECTED_SNAPSHOT.selection };
let refreshSequence = 0;
let activeRefresh: Promise<ObjectsSnapshot<SchemaObject>> | null = null;

function getSelection(): SelectionSnapshot {
  return { ...snapshot.selection };
}

function getObjectsSnapshot(): ObjectsSnapshot<SchemaObject> {
  return cloneSnapshot(snapshot);
}

async function selectObject(input: unknown): Promise<SelectionSnapshot> {
  const candidate = parseSelection(input);
  if (candidate.connectionRevision !== snapshot.connectionRevision) {
    throw new Error('数据库连接已变化，请重新选择对象。');
  }
  while (activeRefresh) {
    const pendingRefresh = activeRefresh;
    await pendingRefresh;
    if (activeRefresh === pendingRefresh) activeRefresh = null;
  }
  if (candidate.connectionRevision !== snapshot.connectionRevision) {
    throw new Error('数据库连接已变化，请重新选择对象。');
  }
  if (
    candidate.objectName !== null
    && !snapshot.objects.some((object) => object.name === candidate.objectName)
  ) {
    throw new Error(`数据库对象不存在：${candidate.objectName}`);
  }
  if (
    candidate.connectionRevision === snapshot.selection.connectionRevision
    && candidate.objectName === snapshot.selection.objectName
  ) {
    return getSelection();
  }
  snapshot = { ...snapshot, selection: candidate };
  publishSelection();
  publishObjects();
  return getSelection();
}

async function refreshObjects(): Promise<ObjectsSnapshot<SchemaObject>> {
  return startRefresh(snapshot.selection.objectName);
}

async function startRefresh(preferredObjectName: string | null): Promise<ObjectsSnapshot<SchemaObject>> {
  const operation = performRefreshObjects(preferredObjectName);
  activeRefresh = operation;
  try {
    return await operation;
  } finally {
    if (activeRefresh === operation) activeRefresh = null;
  }
}

async function performRefreshObjects(
  preferredObjectName: string | null,
): Promise<ObjectsSnapshot<SchemaObject>> {
  if (!snapshot.connected) return getObjectsSnapshot();
  const sequence = ++refreshSequence;
  const expectedConnectionRevision = snapshot.connectionRevision;
  const schema = await getSchema();
  if (
    sequence !== refreshSequence
    || !snapshot.connected
    || schema.connectionRevision !== expectedConnectionRevision
    || snapshot.connectionRevision !== expectedConnectionRevision
    || schema.schemaRevision < snapshot.schemaRevision
  ) {
    return getObjectsSnapshot();
  }

  const preferred = schema.objects.some((object) => object.name === preferredObjectName)
    ? preferredObjectName
    : schema.objects.find((object) => object.kind === 'table')?.name
      ?? schema.objects[0]?.name
      ?? null;
  snapshot = {
    connected: true,
    connectionRevision: schema.connectionRevision,
    schemaRevision: schema.schemaRevision,
    objects: schema.objects.map((object) => ({ ...object })),
    selection: { connectionRevision: schema.connectionRevision, objectName: preferred },
  };
  publishSelection();
  publishObjects();
  return getObjectsSnapshot();
}

async function onConnectionChanged(input: unknown): Promise<ObjectsSnapshot<SchemaObject>> {
  const event = parseConnectionEvent(input);
  if (
    event.connectionRevision < snapshot.connectionRevision
    || (
      event.connectionRevision === snapshot.connectionRevision
      && event.schemaRevision < snapshot.schemaRevision
    )
  ) {
    return getObjectsSnapshot();
  }
  refreshSequence += 1;
  activeRefresh = null;
  snapshot = {
    connected: event.connected,
    connectionRevision: event.connectionRevision,
    schemaRevision: event.schemaRevision,
    objects: [],
    selection: {
      connectionRevision: event.connectionRevision,
      objectName: null,
    },
  };
  publishSelection();
  publishObjects();
  if (event.connected) {
    try {
      return await startRefresh(null);
    } catch {
      return getObjectsSnapshot();
    }
  }
  return getObjectsSnapshot();
}

async function onSchemaChanged(input: unknown): Promise<ObjectsSnapshot<SchemaObject>> {
  const event = parseRevisionEvent(input);
  if (
    !snapshot.connected
    || event.connectionRevision !== snapshot.connectionRevision
    || event.schemaRevision <= snapshot.schemaRevision
  ) {
    return getObjectsSnapshot();
  }
  try {
    return await refreshObjects();
  } catch {
    return getObjectsSnapshot();
  }
}

function publishSelection(): void {
  if (
    lastPublishedSelection.connectionRevision === snapshot.selection.connectionRevision
    && lastPublishedSelection.objectName === snapshot.selection.objectName
  ) return;
  lastPublishedSelection = { ...snapshot.selection };
  runtime?.message.broadcast(SELECTION_CHANGED_TOPIC, getSelection());
}

function publishObjects(): void {
  runtime?.message.broadcast(OBJECTS_CHANGED_TOPIC, getObjectsSnapshot());
}

async function getSchema(): Promise<SchemaSnapshot<SchemaObject>> {
  if (!runtime) throw new Error('SQLite Explorer 尚未加载。');
  const response = await runtime.message.request(SQLITE_CORE, 'getSchema');
  return unwrapSqliteResponse<SchemaSnapshot<SchemaObject>>(response);
}

function parseSelection(input: unknown): SelectionSnapshot {
  if (!isRecord(input) || !isRevision(input.connectionRevision)) {
    throw new Error('对象选择缺少有效的连接版本。');
  }
  if (input.objectName !== null && (typeof input.objectName !== 'string' || input.objectName === '')) {
    throw new Error('对象名称无效。');
  }
  return {
    connectionRevision: input.connectionRevision,
    objectName: input.objectName as string | null,
  };
}

function parseConnectionEvent(input: unknown): ConnectionEvent {
  const event = parseRevisionEvent(input);
  if (!isRecord(input) || typeof input.connected !== 'boolean') {
    throw new Error('连接变化事件缺少连接状态。');
  }
  return { ...event, connected: input.connected };
}

function parseRevisionEvent(input: unknown): { connectionRevision: number; schemaRevision: number } {
  if (
    !isRecord(input)
    || !isRevision(input.connectionRevision)
    || !isRevision(input.schemaRevision)
  ) {
    throw new Error('数据库变化事件缺少有效版本。');
  }
  return {
    connectionRevision: input.connectionRevision,
    schemaRevision: input.schemaRevision,
  };
}

function cloneSnapshot(value: ObjectsSnapshot<SchemaObject>): ObjectsSnapshot<SchemaObject> {
  return {
    ...value,
    objects: value.objects.map((object) => ({ ...object })),
    selection: { ...value.selection },
  };
}

function isRevision(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

editor.plugin.define({
  lifecycle: {
    load(ctx: Runtime) {
      runtime = ctx;
    },
    unload() {
      runtime = undefined;
      snapshot = cloneSnapshot(DISCONNECTED_SNAPSHOT);
      lastPublishedSelection = { ...DISCONNECTED_SNAPSHOT.selection };
      refreshSequence += 1;
      activeRefresh = null;
    },
  },
  methods: {
    getSelection,
    getObjectsSnapshot,
    selectObject,
    refreshObjects,
    onConnectionChanged,
    onSchemaChanged,
  },
});
