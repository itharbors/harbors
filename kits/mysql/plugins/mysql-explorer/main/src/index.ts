import {
  MYSQL_CORE,
  SELECTION_CHANGED_TOPIC,
  unwrapMysqlResponse,
  type SchemaSnapshot,
  type SelectionSnapshot,
} from '@itharbors/mysql-contracts';

declare const editor: any;

type Runtime = {
  message: {
    request(plugin: string, method: string, input?: unknown): Promise<unknown>;
    broadcast(topic: string, payload: unknown): void;
  };
};

type SchemaObject = { name: string };

let runtime: Runtime | undefined;
let selection: SelectionSnapshot = { connectionRevision: 0, objectName: null };

function getSelection(): SelectionSnapshot {
  return { ...selection };
}

async function selectObject(input: unknown): Promise<SelectionSnapshot> {
  const candidate = parseSelection(input);
  if (candidate.connectionRevision !== selection.connectionRevision) {
    throw new Error('数据库连接已变化，请重新选择对象。');
  }
  if (candidate.objectName !== null) {
    const schema = await getSchema();
    if (schema.connectionRevision !== selection.connectionRevision) {
      throw new Error('数据库连接已变化，请重新选择对象。');
    }
    if (!schema.objects.some((object) => object.name === candidate.objectName)) {
      throw new Error(`数据库对象不存在：${candidate.objectName}`);
    }
  }
  return commitSelection(candidate);
}

function onConnectionChanged(input: unknown): SelectionSnapshot {
  const connectionRevision = parseConnectionRevision(input);
  return commitSelection({ connectionRevision, objectName: null });
}

async function onSchemaChanged(input: unknown): Promise<SelectionSnapshot> {
  const connectionRevision = parseConnectionRevision(input);
  if (connectionRevision !== selection.connectionRevision || selection.objectName === null) {
    return getSelection();
  }
  const schema = await getSchema();
  if (schema.connectionRevision !== selection.connectionRevision) return getSelection();
  if (!schema.objects.some((object) => object.name === selection.objectName)) {
    return commitSelection({ connectionRevision, objectName: null });
  }
  return getSelection();
}

function commitSelection(next: SelectionSnapshot): SelectionSnapshot {
  if (
    next.connectionRevision === selection.connectionRevision
    && next.objectName === selection.objectName
  ) return getSelection();
  selection = { ...next };
  runtime?.message.broadcast(SELECTION_CHANGED_TOPIC, getSelection());
  return getSelection();
}

async function getSchema(): Promise<SchemaSnapshot<SchemaObject>> {
  if (!runtime) throw new Error('MySQL Explorer 尚未加载。');
  return unwrapMysqlResponse<SchemaSnapshot<SchemaObject>>(
    await runtime.message.request(MYSQL_CORE, 'getSchema'),
  );
}

function parseSelection(input: unknown): SelectionSnapshot {
  if (!isRecord(input) || !Number.isInteger(input.connectionRevision) || Number(input.connectionRevision) < 0) {
    throw new Error('对象选择缺少有效的连接版本。');
  }
  if (input.objectName !== null && (typeof input.objectName !== 'string' || input.objectName === '')) {
    throw new Error('对象名称无效。');
  }
  return {
    connectionRevision: Number(input.connectionRevision),
    objectName: input.objectName as string | null,
  };
}

function parseConnectionRevision(input: unknown): number {
  if (!isRecord(input) || !Number.isInteger(input.connectionRevision) || Number(input.connectionRevision) < 0) {
    throw new Error('连接变化事件缺少有效版本。');
  }
  return Number(input.connectionRevision);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

editor.plugin.define({
  lifecycle: {
    load(ctx: Runtime) { runtime = ctx; },
    unload() {
      runtime = undefined;
      selection = { connectionRevision: 0, objectName: null };
    },
  },
  methods: { getSelection, selectObject, onConnectionChanged, onSchemaChanged },
});
