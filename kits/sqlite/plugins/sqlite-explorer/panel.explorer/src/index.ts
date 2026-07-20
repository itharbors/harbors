import {
  SQLITE_EXPLORER,
  type ObjectsSnapshot,
  type SelectionSnapshot,
} from '@itharbors/sqlite-contracts';

type PanelContext = {
  message: {
    request(plugin: string, method: string, input?: unknown): Promise<unknown>;
  };
};

type SchemaObject = {
  name: string;
  kind: 'table' | 'view' | 'virtual' | 'shadow';
  type: 'table' | 'view';
  writable: boolean;
  readOnlyReason?: string | null;
  sql?: string;
};

type PanelError = { message: string; detail?: string };

const EMPTY_SNAPSHOT: ObjectsSnapshot<SchemaObject> = {
  connected: false,
  connectionRevision: 0,
  schemaRevision: 0,
  objects: [],
  selection: { connectionRevision: 0, objectName: null },
};

const GROUPS = [
  { kind: 'table', label: '表', collapsed: false, icon: '▦' },
  { kind: 'view', label: '视图', collapsed: false, icon: '◇' },
  { kind: 'virtual', label: '虚拟表', collapsed: false, icon: '◈' },
  { kind: 'shadow', label: '系统对象', collapsed: true, icon: '·' },
] as const;

let context: PanelContext | undefined;
let root: HTMLElement | null = null;
let snapshot = cloneSnapshot(EMPTY_SNAPSHOT);
let query = '';
let error: PanelError | null = null;
let requestSequence = 0;
let selectionSequence = 0;
let expandedKinds = new Set<SchemaObject['kind']>();

const definition = {
  async mount(ctx: PanelContext) {
    context = ctx;
    root = document.querySelector('#panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    resetState();
    render();
    const sequence = ++requestSequence;
    try {
      const value = await requestExplorer('getObjectsSnapshot');
      if (sequence !== requestSequence || !isObjectsSnapshot(value) || isStale(value)) return;
      acceptSnapshot(value);
    } catch (caught) {
      if (sequence !== requestSequence) return;
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
  expandedKinds = new Set();
  requestSequence += 1;
  selectionSequence += 1;
}

function acceptSnapshot(next: ObjectsSnapshot<SchemaObject>): void {
  if (next.connectionRevision !== snapshot.connectionRevision) {
    query = '';
    expandedKinds.clear();
  }
  selectionSequence += 1;
  snapshot = cloneSnapshot(next);
  error = null;
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
  const sequence = ++selectionSequence;
  const connectionRevision = snapshot.connectionRevision;
  const schemaRevision = snapshot.schemaRevision;
  try {
    const selection = await requestExplorer('selectObject', {
      connectionRevision,
      objectName,
    }) as SelectionSnapshot;
    if (
      sequence !== selectionSequence
      || connectionRevision !== snapshot.connectionRevision
      || schemaRevision !== snapshot.schemaRevision
      || selection.connectionRevision !== snapshot.connectionRevision
    ) return;
    snapshot = { ...snapshot, selection: { ...selection } };
    error = null;
  } catch (caught) {
    error = panelError(caught);
  }
  render();
}

async function requestExplorer(method: string, input?: unknown): Promise<unknown> {
  if (!context) throw new Error('SQLite 对象栏尚未挂载。');
  return context.message.request(SQLITE_EXPLORER, method, input);
}

function render(): void {
  if (!root) return;
  root.innerHTML = `
    <aside class="object-rail" aria-label="SQLite 数据库对象">
      <div class="rail-heading"><span>数据库对象</span><b aria-hidden="true"></b></div>
      ${error ? renderError(error) : ''}
      <div class="object-list">${renderObjectList()}</div>
    </aside>
  `;

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
  for (const details of Array.from(root.querySelectorAll<HTMLDetailsElement>('details[data-object-kind]'))) {
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      const kind = details.dataset.objectKind as SchemaObject['kind'];
      if (details.open) expandedKinds.add(kind);
      else expandedKinds.delete(kind);
    });
  }
}

function renderObjectList(): string {
  if (!snapshot.connected) {
    return '<div class="empty-state">打开数据库后，这里会显示表、视图和系统对象。</div>';
  }
  if (snapshot.objects.length === 0) {
    return '<div class="empty-state">数据库中还没有对象。</div>';
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = snapshot.objects.filter((object) => (
    object.name.toLocaleLowerCase().includes(normalizedQuery)
  ));
  const groups = GROUPS.map((group) => {
    const objects = filtered.filter((object) => object.kind === group.kind);
    if (objects.length === 0) return '';
    const tag = group.collapsed ? 'details' : 'section';
    const headingTag = group.collapsed ? 'summary' : 'h2';
    const open = group.collapsed && expandedKinds.has(group.kind) ? ' open' : '';
    return `<${tag} class="object-group" data-object-kind="${group.kind}"${open}>
      <${headingTag} class="object-group-title">${group.label} · ${objects.length}</${headingTag}>
      ${objects.map((object) => renderObject(object, group.label, group.icon)).join('')}
    </${tag}>`;
  }).join('');

  return `<input type="search" data-field="object-search" aria-label="搜索数据库对象" placeholder="搜索对象" value="${escapeHtml(query)}">
    ${groups || '<div class="empty-state">没有匹配的对象。</div>'}`;
}

function renderObject(object: SchemaObject, label: string, icon: string): string {
  const active = object.name === snapshot.selection.objectName;
  return `<button type="button" class="object-item${active ? ' active' : ''}" data-object-name="${escapeHtml(object.name)}" aria-pressed="${active}" title="${escapeHtml(object.readOnlyReason ?? '')}">
    <span class="object-icon ${object.kind}" aria-hidden="true">${icon}</span>
    <span>${escapeHtml(object.name)}</span>
    <small>${label}</small>
  </button>`;
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
  if (!isRevision(value.connectionRevision) || !isRevision(value.schemaRevision)) return false;
  if (!Array.isArray(value.objects) || !value.objects.every(isSchemaObject)) return false;
  if (!isRecord(value.selection) || value.selection.connectionRevision !== value.connectionRevision) return false;
  return value.selection.objectName === null || typeof value.selection.objectName === 'string';
}

function isSchemaObject(value: unknown): value is SchemaObject {
  return isRecord(value)
    && typeof value.name === 'string'
    && ['table', 'view', 'virtual', 'shadow'].includes(String(value.kind));
}

function isRevision(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function cloneSnapshot(value: ObjectsSnapshot<SchemaObject>): ObjectsSnapshot<SchemaObject> {
  return {
    ...value,
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
