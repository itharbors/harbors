import {
  MYSQL_EXPLORER,
  type ObjectsSnapshot,
  type SelectionSnapshot,
} from '@itharbors/mysql-contracts';

type PanelContext = {
  message: {
    request(plugin: string, method: string, input?: unknown): Promise<unknown>;
  };
};

type SchemaObject = {
  name: string;
  type: 'table' | 'view';
  insertable: boolean;
};

type PanelError = { message: string; detail?: string };
type ExplorerActivity = { kind: 'hydrate' | 'database' | 'object'; name?: string } | null;

const EMPTY_SNAPSHOT: ObjectsSnapshot<SchemaObject> = {
  connected: false,
  database: null,
  databases: [],
  connectionRevision: 0,
  schemaRevision: 0,
  objects: [],
  selection: { connectionRevision: 0, objectName: null },
};

let context: PanelContext | undefined;
let root: HTMLElement | null = null;
let snapshot = cloneSnapshot(EMPTY_SNAPSHOT);
let query = '';
let error: PanelError | null = null;
let activity: ExplorerActivity = null;
let requestSequence = 0;
let selectionSequence = 0;

const definition = {
  async mount(ctx: PanelContext) {
    context = ctx;
    root = document.querySelector('#panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    resetState();
    activity = { kind: 'hydrate' };
    render();
    const sequence = ++requestSequence;
    try {
      const value = await requestExplorer('getObjectsSnapshot');
      if (sequence !== requestSequence || !isObjectsSnapshot(value) || isStale(value)) return;
      acceptSnapshot(value);
    } catch (caught) {
      if (sequence !== requestSequence) return;
      activity = null;
      error = panelError(caught);
      render();
    }
  },

  unmount() {
    requestSequence += 1;
    root?.replaceChildren();
    root = null;
    context = undefined;
    resetState();
  },

  methods: {
    onObjectsChanged(payload: unknown) {
      if (!isObjectsSnapshot(payload) || isStale(payload)) return;
      acceptSnapshot(payload);
    },
  },
};

export default definition;

function resetState(): void {
  snapshot = cloneSnapshot(EMPTY_SNAPSHOT);
  query = '';
  error = null;
  activity = null;
  requestSequence += 1;
  selectionSequence += 1;
}

function acceptSnapshot(next: ObjectsSnapshot<SchemaObject>): void {
  if (next.connectionRevision !== snapshot.connectionRevision) query = '';
  requestSequence += 1;
  selectionSequence += 1;
  activity = null;
  snapshot = cloneSnapshot(next);
  error = next.error ? { ...next.error } : null;
  render();
}

function isStale(next: ObjectsSnapshot<SchemaObject>): boolean {
  return next.connectionRevision < snapshot.connectionRevision
    || (
      next.connectionRevision === snapshot.connectionRevision
      && next.schemaRevision < snapshot.schemaRevision
    );
}

async function chooseObject(objectName: string): Promise<void> {
  if (activity !== null) return;
  const sequence = ++selectionSequence;
  const connectionRevision = snapshot.connectionRevision;
  const schemaRevision = snapshot.schemaRevision;
  const pending: Exclude<ExplorerActivity, null> = { kind: 'object', name: objectName };
  activity = pending;
  error = null;
  render();
  try {
    const selection = await requestExplorer('selectObject', {
      connectionRevision,
      objectName,
    }) as SelectionSnapshot;
    if (
      !isCurrentSelectionRequest(sequence, connectionRevision, schemaRevision)
      || selection.connectionRevision !== snapshot.connectionRevision
    ) return;
    activity = null;
    snapshot = { ...snapshot, selection: { ...selection } };
    error = null;
    render();
  } catch (caught) {
    if (!isCurrentSelectionRequest(sequence, connectionRevision, schemaRevision)) return;
    activity = null;
    error = panelError(caught);
    render();
  } finally {
    if (activity === pending && isCurrentSelectionRequest(sequence, connectionRevision, schemaRevision)) {
      activity = null;
      render();
    }
  }
}

async function chooseDatabase(database: string): Promise<void> {
  if (activity !== null) return;
  const sequence = ++selectionSequence;
  const connectionRevision = snapshot.connectionRevision;
  const schemaRevision = snapshot.schemaRevision;
  const pending: Exclude<ExplorerActivity, null> = { kind: 'database', name: database };
  activity = pending;
  error = null;
  render();
  try {
    const next = await requestExplorer('selectDatabase', { database });
    if (
      !isCurrentSelectionRequest(sequence, connectionRevision, schemaRevision)
      || !isObjectsSnapshot(next)
      || isStale(next)
    ) return;
    acceptSnapshot(next);
  } catch (caught) {
    if (!isCurrentSelectionRequest(sequence, connectionRevision, schemaRevision)) return;
    activity = null;
    error = panelError(caught);
    render();
  } finally {
    if (activity === pending && isCurrentSelectionRequest(sequence, connectionRevision, schemaRevision)) {
      activity = null;
      render();
    }
  }
}

function isCurrentSelectionRequest(
  sequence: number,
  connectionRevision: number,
  schemaRevision: number,
): boolean {
  return sequence === selectionSequence
    && connectionRevision === snapshot.connectionRevision
    && schemaRevision === snapshot.schemaRevision
    && context !== undefined
    && root?.isConnected === true;
}

async function requestExplorer(method: string, input?: unknown): Promise<unknown> {
  if (!context) throw new Error('MySQL 对象栏尚未挂载。');
  return context.message.request(MYSQL_EXPLORER, method, input);
}

function render(): void {
  if (!root) return;
  root.innerHTML = `
    <aside class="object-rail" aria-label="MySQL 数据库对象" aria-busy="${activity !== null}">
      <div class="rail-heading"><span>数据库对象</span><span class="object-count">${snapshot.objects.length}</span></div>
      <label class="object-search"><span class="sr-only">筛选对象</span><input type="search" data-field="object-search" aria-label="筛选对象" placeholder="筛选当前库对象" value="${escapeHtml(query)}"${snapshot.connected && snapshot.database !== null && activity === null ? '' : ' disabled'}></label>
      <div class="object-error-slot">${error ? renderError(error) : renderActivity()}</div>
      <div class="object-tree">${renderObjectTree()}</div>
    </aside>`;

  const search = root.querySelector<HTMLInputElement>('[data-field="object-search"]');
  search?.addEventListener('input', () => {
    query = search.value;
    render();
    queueMicrotask(() => {
      const next = root?.querySelector<HTMLInputElement>('[data-field="object-search"]');
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    });
  });
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-object-name]'))) {
    button.addEventListener('click', () => { void chooseObject(button.dataset.objectName!); });
  }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-database-name]'))) {
    button.addEventListener('click', () => { void chooseDatabase(button.dataset.databaseName!); });
  }
}

function renderObjectTree(): string {
  if (activity?.kind === 'hydrate') {
    return '<p class="empty-hint">正在读取数据库对象…</p>';
  }
  if (!snapshot.connected) {
    return '<p class="empty-hint">连接后即可查看表和视图。</p>';
  }
  const databases = renderDatabases();
  if (snapshot.error) {
    return `${databases}<p class="empty-hint">请刷新数据库对象后重试。</p>`;
  }
  if (snapshot.database === null) {
    return `${databases}<p class="empty-hint">选择数据库后查看表和视图。</p>`;
  }
  if (snapshot.objects.length === 0) {
    return `${databases}<p class="empty-hint">此数据库没有表或视图。</p>`;
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = snapshot.objects.filter((object) => (
    object.name.toLocaleLowerCase().includes(normalizedQuery)
  ));
  const groups = (['table', 'view'] as const).map((type) => {
    const objects = filtered.filter((object) => object.type === type);
    if (objects.length === 0) return '';
    const label = type === 'table' ? '表' : '视图';
    return `<section class="rail-group object-group" data-object-type="${type}">
      <h3>${label}</h3>
      ${objects.map((object) => renderObject(object)).join('')}
    </section>`;
  }).join('');
  return `${databases}${groups || '<p class="empty-hint">没有符合筛选条件的对象。</p>'}`;
}

function renderDatabases(): string {
  if (snapshot.databases.length === 0) {
    return '<section class="rail-group database-group"><h3>数据库</h3><p class="empty-hint">当前账号没有可访问的数据库。</p></section>';
  }
  return `<section class="rail-group database-group"><h3>数据库</h3>${snapshot.databases
    .map((database) => renderDatabase(database)).join('')}</section>`;
}

function renderDatabase(database: string): string {
  const selected = database === snapshot.database;
  const pending = activity?.kind === 'database' && activity.name === database;
  return `<button type="button" class="${selected ? 'selected' : ''}" data-database-name="${escapeHtml(database)}" aria-pressed="${selected}"${activity !== null ? ' disabled' : ''}>
    ${pending ? spinner() : '<span class="database-icon" aria-hidden="true"></span>'}
    <span>${escapeHtml(database)}</span>
  </button>`;
}

function renderObject(object: SchemaObject): string {
  const selected = object.name === snapshot.selection.objectName;
  const pending = activity?.kind === 'object' && activity.name === object.name;
  return `<button type="button" class="${selected ? 'selected' : ''}" data-object-name="${escapeHtml(object.name)}" aria-pressed="${selected}"${activity !== null ? ' disabled' : ''}>
    ${pending ? spinner() : `<span class="object-dot ${object.type}" aria-hidden="true"></span>`}
    <span>${escapeHtml(object.name)}</span>
  </button>`;
}

function renderActivity(): string {
  if (!activity) return '';
  const message = activity.kind === 'database'
    ? `正在切换数据库 ${activity.name ?? ''}…`
    : activity.kind === 'object'
      ? `正在选择 ${activity.name ?? ''}…`
      : '正在读取数据库对象…';
  return `<div class="rail-activity" role="status" aria-live="polite">${spinner()}<span>${escapeHtml(message)}</span></div>`;
}

function spinner(): string {
  return '<span class="activity-spinner" aria-hidden="true"></span>';
}

function renderError(panelErrorValue: PanelError): string {
  return `<div class="error-banner" role="alert">${escapeHtml(panelErrorValue.message)}${panelErrorValue.detail ? `<details><summary>技术详情</summary><pre>${escapeHtml(panelErrorValue.detail)}</pre></details>` : ''}</div>`;
}

function panelError(caught: unknown): PanelError {
  return caught instanceof Error
    ? {
      message: caught.message,
      ...('detail' in caught && typeof caught.detail === 'string' ? { detail: caught.detail } : {}),
    }
    : { message: String(caught) };
}

function isObjectsSnapshot(value: unknown): value is ObjectsSnapshot<SchemaObject> {
  if (!isRecord(value) || typeof value.connected !== 'boolean') return false;
  if (value.database !== null && typeof value.database !== 'string') return false;
  if (!Array.isArray(value.databases) || !value.databases.every((database) => typeof database === 'string')) return false;
  if (!isRevision(value.connectionRevision) || !isRevision(value.schemaRevision)) return false;
  if (!Array.isArray(value.objects) || !value.objects.every(isSchemaObject)) return false;
  if (value.error !== undefined && value.error !== null && !isPanelError(value.error)) return false;
  if (!isRecord(value.selection) || value.selection.connectionRevision !== value.connectionRevision) return false;
  return value.selection.objectName === null || typeof value.selection.objectName === 'string';
}

function isPanelError(value: unknown): value is PanelError {
  return isRecord(value)
    && typeof value.message === 'string'
    && (value.detail === undefined || typeof value.detail === 'string');
}

function isSchemaObject(value: unknown): value is SchemaObject {
  return isRecord(value)
    && typeof value.name === 'string'
    && (value.type === 'table' || value.type === 'view')
    && typeof value.insertable === 'boolean';
}

function isRevision(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function cloneSnapshot(value: ObjectsSnapshot<SchemaObject>): ObjectsSnapshot<SchemaObject> {
  return {
    ...value,
    ...(value.error ? { error: { ...value.error } } : {}),
    databases: [...value.databases],
    objects: value.objects.map((object) => ({ ...object })),
    selection: { ...value.selection },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[character] ?? character);
}
