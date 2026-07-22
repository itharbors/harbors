import {
  createDatabaseLayoutIdentity,
  createRelationshipGraphSession,
  createRelationshipLayoutStore,
  renderRelationshipView,
  zoomRelationshipViewport,
  type CanvasSize,
  type RelationshipGraph,
  type RelationshipGraphSession,
} from '@itharbors/relationship-graph';
import {
  MYSQL_CORE,
  MYSQL_EXPLORER,
  unwrapMysqlResponse,
  type ConnectionSnapshot,
} from '@itharbors/mysql-contracts';

type Context = {
  message: { request(plugin: string, method: string, input?: unknown): Promise<unknown> };
  panel: { openPanel(name: string): unknown };
};
type RelationshipActivity = { kind: 'load' | 'open'; name?: string } | null;

const fallbackStorage = new Map<string, string>();

let context: Context | undefined;
let root: HTMLElement | null = null;
let connection: ConnectionSnapshot | null = null;
let graph: RelationshipGraph | null = null;
let session: RelationshipGraphSession | null = null;
let query = '';
let error: string | null = null;
let activity: RelationshipActivity = null;
let sequence = 0;
let schemaRevision = 0;
let lastCanvas: CanvasSize = { width: 960, height: 640 };
let resizeObserver: ResizeObserver | null = null;

const definition = {
  async mount(ctx: Context) {
    context = ctx;
    root = document.querySelector('#panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    const current = ++sequence;
    resizeObserver?.disconnect();
    resizeObserver = null;
    const previous = session;
    session = null;
    clearState();
    if (previous !== null) await previous.dispose();
    if (current !== sequence) return;
    render();
    try {
      const next = await core<ConnectionSnapshot>('getConnectionState');
      if (current !== sequence) return;
      connection = next;
      schemaRevision = next.schemaRevision;
      if (hasDatabaseIdentity(next)) await loadGraph();
      else render();
    } catch (caught) {
      if (current === sequence) setError(caught);
    }
  },

  async unmount() {
    sequence += 1;
    resizeObserver?.disconnect();
    resizeObserver = null;
    await disposeSession();
    root?.replaceChildren();
    root = null;
    context = undefined;
    clearState();
  },

  methods: {
    async onConnectionChanged(value: unknown) {
      if (!isConnection(value)) return;
      const current = ++sequence;
      await disposeSession();
      if (current !== sequence) return;
      connection = value;
      schemaRevision = value.schemaRevision;
      graph = null;
      query = '';
      error = null;
      activity = null;
      if (hasDatabaseIdentity(value)) await loadGraph();
      else render();
    },

    async onSchemaChanged(value: unknown) {
      if (!isRevision(value)
        || value.connectionRevision !== connection?.connectionRevision
        || value.schemaRevision === schemaRevision) return;
      schemaRevision = value.schemaRevision;
      await refreshGraph();
    },

    async onDataChanged(_value: unknown) {},
  },
};

export default definition;

function clearState(): void {
  connection = null;
  graph = null;
  query = '';
  error = null;
  activity = null;
  schemaRevision = 0;
  lastCanvas = { width: 960, height: 640 };
}

async function loadGraph(): Promise<void> {
  if (!hasDatabaseIdentity(connection) || activity !== null) return;
  const connectionRevision = connection.connectionRevision;
  const current = ++sequence;
  const pending: Exclude<RelationshipActivity, null> = { kind: 'load' };
  activity = pending;
  graph = null;
  error = null;
  render();
  try {
    const next = await core<RelationshipGraph>('getRelationshipGraph');
    if (current !== sequence || connectionRevision !== connection?.connectionRevision) return;
    const nextSession = await createSession(next, connection);
    if (current !== sequence || connectionRevision !== connection?.connectionRevision) {
      await nextSession.dispose();
      return;
    }
    await disposeSession();
    session = nextSession;
    graph = next;
  } catch (caught) {
    if (current !== sequence) return;
    error = errorMessage(caught);
  } finally {
    if (activity === pending && current === sequence) {
      activity = null;
      render();
    }
  }
}

async function refreshGraph(): Promise<void> {
  if (!hasDatabaseIdentity(connection) || activity !== null) return;
  if (session === null) {
    await loadGraph();
    return;
  }
  const connectionRevision = connection.connectionRevision;
  const current = ++sequence;
  const pending: Exclude<RelationshipActivity, null> = { kind: 'load' };
  activity = pending;
  error = null;
  render();
  try {
    const next = await core<RelationshipGraph>('getRelationshipGraph');
    if (current !== sequence || connectionRevision !== connection?.connectionRevision) return;
    session.updateGraph(next, currentCanvas());
    graph = next;
  } catch (caught) {
    if (current !== sequence) return;
    error = errorMessage(caught);
  } finally {
    if (activity === pending && current === sequence) {
      activity = null;
      render();
    }
  }
}

function createSession(next: RelationshipGraph, current: ConnectionSnapshot & {
  endpoint: string;
  database: string;
}): Promise<RelationshipGraphSession> {
  return createRelationshipGraphSession({
    identity: createDatabaseLayoutIdentity('mysql', [current.endpoint, current.database]),
    graph: next,
    canvas: currentCanvas(),
    store: createRelationshipLayoutStore(browserStorage()),
  });
}

async function disposeSession(): Promise<void> {
  const previous = session;
  session = null;
  if (previous !== null) await previous.dispose();
}

async function openTable(name: string): Promise<void> {
  if (!context || !connection || activity !== null) return;
  const connectionRevision = connection.connectionRevision;
  const current = ++sequence;
  const pending: Exclude<RelationshipActivity, null> = { kind: 'open', name };
  activity = pending;
  error = null;
  render();
  try {
    await context.message.request(MYSQL_EXPLORER, 'selectObject', {
      connectionRevision,
      objectName: name,
    });
    if (current !== sequence || connectionRevision !== connection?.connectionRevision) return;
    context.panel.openPanel('@itharbors/mysql-schema.schema');
  } catch (caught) {
    if (current !== sequence) return;
    error = errorMessage(caught);
  } finally {
    if (activity === pending && current === sequence) {
      activity = null;
      render();
    }
  }
}

async function core<T>(method: string): Promise<T> {
  if (!context) throw new Error('关系图尚未挂载');
  return unwrapMysqlResponse<T>(await context.message.request(MYSQL_CORE, method));
}

function render(): void {
  if (!root) return;
  resizeObserver?.disconnect();
  resizeObserver = null;
  root.innerHTML = `<main class="workspace" aria-busy="${activity !== null}">
    <header class="workspace-heading"><div class="object-identity"><span class="object-kind">数据库</span><h1 class="object-title"></h1></div></header>
    <section class="view-host" aria-busy="${activity !== null}"></section>
    <footer class="status-deck"><div role="status" aria-live="polite"></div><div class="error-slot"></div></footer>
  </main>`;
  root.querySelector<HTMLElement>('.object-title')!.textContent = connection?.database ?? '全库关系图';
  const host = root.querySelector<HTMLElement>('.view-host')!;
  root.querySelector<HTMLElement>('.status-deck > [role="status"]')!.textContent = relationshipStatus();

  if (error && (!graph || !session)) {
    host.innerHTML = `<div class="empty-state error" role="alert"><span>${escape(error)}</span><button data-action="retry">重试</button></div>`;
    host.querySelector('button')?.addEventListener('click', () => void loadGraph());
    return;
  }
  if (error) {
    const slot = root.querySelector<HTMLElement>('.error-slot')!;
    slot.innerHTML = `<span role="alert">${escape(error)}</span> <button data-action="retry">重试</button>`;
    slot.querySelector('button')?.addEventListener('click', () => void refreshGraph());
  }
  if (!connection?.connected) {
    host.innerHTML = '<div class="empty-state">请先连接 MySQL 数据库。</div>';
    return;
  }
  if (!hasDatabaseIdentity(connection)) {
    host.innerHTML = '<div class="empty-state">请选择要展示的 MySQL 数据库。</div>';
    return;
  }
  if (!graph || !session) {
    host.innerHTML = `<div class="empty-state">${activity ? spinner() : ''}<span>正在读取关系图…</span></div>`;
    return;
  }
  if (graph.tables.length === 0) {
    host.innerHTML = '<div class="empty-state">数据库中没有可展示的表。</div>';
    return;
  }

  const snapshot = session.snapshot;
  const view = renderRelationshipView({
    graph,
    layout: snapshot.layout,
    viewport: snapshot.viewport,
    query,
    tableKindLabel: (table) => table.kind.toLocaleUpperCase(),
    onNodeMove: (name, position, phase) => {
      if (phase === 'commit' && activity === null) session?.moveNode(name, position);
    },
    onViewportChange: (viewport) => {
      if (activity === null) session?.setViewport(viewport);
    },
    onOpenTable: (name) => {
      if (activity === null) void openTable(name);
    },
  });
  view.removeAttribute('role');
  view.removeAttribute('aria-labelledby');
  view.setAttribute('aria-label', 'MySQL 表关系图');
  const toolbar = view.querySelector<HTMLElement>('.relationship-toolbar')!;
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '搜索表';
  search.setAttribute('aria-label', '搜索关系图中的表');
  search.value = query;
  search.disabled = activity !== null;
  search.addEventListener('input', () => {
    if (activity !== null) return;
    query = search.value;
    render();
    queueMicrotask(() => root?.querySelector<HTMLInputElement>('input[type="search"]')?.focus());
  });
  const controls = [
    button('−', '缩小', () => zoom(1 / 1.1)),
    button('+', '放大', () => zoom(1.1)),
    button('适应窗口', '适应窗口', fitView),
    button('自动排列', '根据当前窗口自动排列', autoArrange),
  ];
  for (const control of controls) control.disabled = activity !== null;
  toolbar.prepend(search, ...controls);
  host.append(view);
  observeCanvas();
  if (activity) renderActivityLayer(host);
}

function relationshipStatus(): string {
  if (activity?.kind === 'open') return `正在打开 ${activity.name ?? ''}…`;
  if (activity?.kind === 'load') return '正在读取关系图…';
  if (error) return '读取关系图失败';
  if (graph) return `${graph.tables.length} 张表 · ${graph.relationships.length} 条关系`;
  return connection?.connected ? '正在读取关系图…' : '等待连接 MySQL 数据库';
}

function renderActivityLayer(host: HTMLElement): void {
  const layer = document.createElement('div');
  layer.className = 'relationship-activity-layer';
  layer.append(document.createRange().createContextualFragment(
    `${spinner()}<span>${escape(relationshipStatus())}</span>`,
  ));
  host.append(layer);
}

function spinner(): string {
  return '<span class="activity-spinner" aria-hidden="true"></span>';
}

function button(label: string, aria: string, handler: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.setAttribute('aria-label', aria);
  element.addEventListener('click', handler);
  return element;
}

function fitView(): void {
  if (!session || activity !== null) return;
  session.fit(currentCanvas());
  render();
}

function autoArrange(): void {
  if (!session || activity !== null) return;
  session.autoArrange(currentCanvas());
  render();
}

function zoom(factor: number): void {
  if (!session || activity !== null) return;
  const canvas = currentCanvas();
  session.setViewport(zoomRelationshipViewport(session.snapshot.viewport, factor, {
    x: canvas.width / 2,
    y: canvas.height / 2,
  }));
  render();
}

function observeCanvas(): void {
  const canvas = root?.querySelector<HTMLElement>('.relationship-canvas');
  if (!canvas || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(() => {
    const size = elementSize(canvas);
    if (size !== null) lastCanvas = size;
  });
  resizeObserver.observe(canvas);
}

function currentCanvas(): CanvasSize {
  const canvas = root?.querySelector<HTMLElement>('.relationship-canvas');
  const host = root?.querySelector<HTMLElement>('.view-host');
  const size = elementSize(canvas) ?? elementSize(host);
  if (size !== null) lastCanvas = size;
  return { ...lastCanvas };
}

function elementSize(element: HTMLElement | null | undefined): CanvasSize | null {
  if (!element || element.clientWidth <= 0 || element.clientHeight <= 0) return null;
  return { width: element.clientWidth, height: element.clientHeight };
}

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  try {
    return window.localStorage;
  } catch {
    return {
      getItem: (key) => fallbackStorage.get(key) ?? null,
      setItem: (key, value) => { fallbackStorage.set(key, value); },
    };
  }
}

function setError(value: unknown, rerender = true): void {
  error = errorMessage(value);
  activity = null;
  if (rerender) render();
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function hasDatabaseIdentity(value: ConnectionSnapshot | null): value is ConnectionSnapshot & {
  connected: true;
  endpoint: string;
  database: string;
} {
  return value?.connected === true && value.endpoint !== null && value.database !== null;
}

function isRevision(value: unknown): value is { connectionRevision: number; schemaRevision: number } {
  return typeof value === 'object'
    && value !== null
    && Number.isInteger((value as { connectionRevision?: unknown }).connectionRevision)
    && Number.isInteger((value as { schemaRevision?: unknown }).schemaRevision);
}

function isConnection(value: unknown): value is ConnectionSnapshot {
  return isRevision(value) && typeof (value as { connected?: unknown }).connected === 'boolean';
}

function escape(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[character] ?? character);
}
