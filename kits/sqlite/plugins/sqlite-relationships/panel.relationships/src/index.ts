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
  SQLITE_CORE,
  SQLITE_EXPLORER,
  unwrapSqliteResponse,
  type ConnectionSnapshot,
} from '@itharbors/sqlite-contracts';

type Context = {
  message: { request(plugin: string, method: string, input?: unknown): Promise<unknown> };
  panel: { openPanel(name: string): unknown };
};

const fallbackStorage = new Map<string, string>();

let context: Context | undefined;
let root: HTMLElement | null = null;
let connection: ConnectionSnapshot | null = null;
let graph: RelationshipGraph | null = null;
let session: RelationshipGraphSession | null = null;
let query = '';
let error: string | null = null;
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
      if (next.connected) await loadGraph();
      else render();
    } catch (value) {
      if (current === sequence) setError(value);
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
      if (value.connected) await loadGraph();
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
  schemaRevision = 0;
  lastCanvas = { width: 960, height: 640 };
}

async function loadGraph(): Promise<void> {
  if (!connection?.connected) return;
  const connectionRevision = connection.connectionRevision;
  const current = ++sequence;
  graph = null;
  error = null;
  render();
  try {
    const next = await core<RelationshipGraph>('getRelationshipGraph');
    if (current !== sequence || connectionRevision !== connection?.connectionRevision) return;
    const nextSession = await createRelationshipGraphSession({
      identity: createDatabaseLayoutIdentity('sqlite', [
        connection.path ?? '',
        connection.fileIdentity ?? 'path-only',
      ]),
      graph: next,
      canvas: currentCanvas(),
      store: createRelationshipLayoutStore(browserStorage()),
    });
    if (current !== sequence || connectionRevision !== connection?.connectionRevision) {
      await nextSession.dispose();
      return;
    }
    await disposeSession();
    session = nextSession;
    graph = next;
    error = null;
  } catch (value) {
    if (current !== sequence) return;
    setError(value, false);
  }
  render();
}

async function refreshGraph(): Promise<void> {
  if (!connection?.connected) return;
  const connectionRevision = connection.connectionRevision;
  const current = ++sequence;
  try {
    const next = await core<RelationshipGraph>('getRelationshipGraph');
    if (current !== sequence || connectionRevision !== connection?.connectionRevision) return;
    if (session === null) {
      const nextSession = await createRelationshipGraphSession({
        identity: createDatabaseLayoutIdentity('sqlite', [
          connection.path ?? '',
          connection.fileIdentity ?? 'path-only',
        ]),
        graph: next,
        canvas: currentCanvas(),
        store: createRelationshipLayoutStore(browserStorage()),
      });
      if (current !== sequence || connectionRevision !== connection?.connectionRevision) {
        await nextSession.dispose();
        return;
      }
      session = nextSession;
    } else {
      session.updateGraph(next, currentCanvas());
    }
    graph = next;
    error = null;
  } catch (value) {
    if (current !== sequence) return;
    setError(value, false);
  }
  render();
}

async function disposeSession(): Promise<void> {
  const previous = session;
  session = null;
  if (previous !== null) await previous.dispose();
}

async function openTable(name: string): Promise<void> {
  if (!context || !connection) return;
  const current = sequence;
  const connectionRevision = connection.connectionRevision;
  await context.message.request(SQLITE_EXPLORER, 'selectObject', {
    connectionRevision,
    objectName: name,
  });
  if (current === sequence && connectionRevision === connection?.connectionRevision) {
    context.panel.openPanel('@itharbors/sqlite-schema.schema');
  }
}

async function core<T>(method: string): Promise<T> {
  if (!context) throw new Error('关系图尚未挂载');
  return unwrapSqliteResponse<T>(await context.message.request(SQLITE_CORE, method));
}

function render(): void {
  if (!root) return;
  resizeObserver?.disconnect();
  resizeObserver = null;
  root.innerHTML = `<main class="workspace"><header class="workspace-heading"><div class="object-title"><small>DATABASE</small><h1>${escape(databaseTitle())}</h1></div></header><div class="view-host"></div><footer class="status-bar" role="status" aria-live="polite"><span>${escape(relationshipStatus())}</span><span>${connection?.connected ? 'ONLINE' : 'OFFLINE'}</span></footer></main>`;
  const host = root.querySelector<HTMLElement>('.view-host')!;
  if (error) {
    host.innerHTML = `<div class="empty-state error" role="alert"><span>${escape(error)}</span><button data-action="retry">重试</button></div>`;
    host.querySelector('button')?.addEventListener('click', () => void loadGraph());
    return;
  }
  if (!connection?.connected) {
    host.innerHTML = '<div class="empty-state">请先打开 SQLite 数据库。</div>';
    return;
  }
  if (!graph || !session) {
    host.innerHTML = '<div class="empty-state">正在读取关系图…</div>';
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
    tableKindLabel: (table) => table.kind === 'view' ? 'VIEW' : 'TABLE',
    onNodeMove: (name, position, phase) => {
      if (phase === 'commit') session?.moveNode(name, position);
    },
    onViewportChange: (viewport) => session?.setViewport(viewport),
    onOpenTable: (name) => void openTable(name),
  });
  view.removeAttribute('aria-labelledby');
  view.setAttribute('aria-label', 'SQLite 表关系图');
  const toolbar = view.querySelector<HTMLElement>('.relationship-toolbar')!;
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '搜索表';
  search.setAttribute('aria-label', '搜索关系图中的表');
  search.value = query;
  search.addEventListener('input', () => {
    query = search.value;
    render();
    queueMicrotask(() => root?.querySelector<HTMLInputElement>('input[type="search"]')?.focus());
  });
  toolbar.prepend(
    search,
    button('−', '缩小', () => zoom(1 / 1.1)),
    button('+', '放大', () => zoom(1.1)),
    button('适应窗口', '适应窗口', fitView),
    button('自动排列', '根据当前窗口自动排列', autoArrange),
  );
  host.append(view);
  observeCanvas();
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

function databaseTitle(): string {
  return connection?.fileName ?? connection?.path?.split(/[\\/]/).pop() ?? '全库关系图';
}

function relationshipStatus(): string {
  if (error) return '关系图加载失败';
  if (!connection?.connected) return '等待数据库连接';
  if (!graph) return '正在读取关系图';
  return `${graph.tables.length} 张表 · ${graph.relationships.length} 条关系`;
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
  if (!session) return;
  session.fit(currentCanvas());
  render();
}

function autoArrange(): void {
  if (!session) return;
  session.autoArrange(currentCanvas());
  render();
}

function zoom(factor: number): void {
  if (!session) return;
  const canvas = currentCanvas();
  const viewport = zoomRelationshipViewport(session.snapshot.viewport, factor, {
    x: canvas.width / 2,
    y: canvas.height / 2,
  });
  session.setViewport(viewport);
  render();
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
  error = value instanceof Error ? value.message : String(value);
  if (rerender) render();
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
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  })[character]!);
}
