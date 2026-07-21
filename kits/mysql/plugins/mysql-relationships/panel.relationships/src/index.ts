import {
  MYSQL_CORE,
  MYSQL_EXPLORER,
  unwrapMysqlResponse,
  type ConnectionSnapshot,
} from '@itharbors/mysql-contracts';
import {
  fitRelationshipViewport,
  layoutRelationshipGraph,
  renderRelationshipView,
  zoomRelationshipViewport,
  type RelationshipGraph,
  type RelationshipViewport,
} from './relationship-view.js';

type Context = {
  message: { request(plugin: string, method: string, input?: unknown): Promise<unknown> };
  panel: { openPanel(name: string): unknown };
};
type RelationshipActivity = { kind: 'load' | 'open'; name?: string } | null;

let context: Context | undefined;
let root: HTMLElement | null = null;
let connection: ConnectionSnapshot | null = null;
let graph: RelationshipGraph | null = null;
let viewport: RelationshipViewport = { x: 32, y: 32, scale: 1 };
let query = '';
let error: string | null = null;
let activity: RelationshipActivity = null;
let sequence = 0;
let schemaRevision = 0;

const definition = {
  async mount(ctx: Context) {
    context = ctx;
    root = document.querySelector('#panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    reset();
    render();
    const current = ++sequence;
    try {
      const next = await core<ConnectionSnapshot>('getConnectionState');
      if (current !== sequence) return;
      connection = next;
      schemaRevision = next.schemaRevision;
      if (next.connected) await loadGraph();
      else render();
    } catch (caught) {
      if (current === sequence) setError(caught);
    }
  },
  unmount() {
    sequence += 1;
    root?.replaceChildren();
    root = null;
    context = undefined;
    reset();
  },
  methods: {
    async onConnectionChanged(value: unknown) {
      if (!isConnection(value)) return;
      connection = value;
      schemaRevision = value.schemaRevision;
      graph = null;
      viewport = { x: 32, y: 32, scale: 1 };
      error = null;
      activity = null;
      sequence += 1;
      if (value.connected) await loadGraph();
      else render();
    },
    async onSchemaChanged(value: unknown) {
      if (!isRevision(value)
        || value.connectionRevision !== connection?.connectionRevision
        || value.schemaRevision === schemaRevision) return;
      schemaRevision = value.schemaRevision;
      await loadGraph(true);
    },
    async onDataChanged(_value: unknown) {},
  },
};
export default definition;

function reset(): void {
  connection = null;
  graph = null;
  viewport = { x: 32, y: 32, scale: 1 };
  query = '';
  error = null;
  activity = null;
  schemaRevision = 0;
  sequence += 1;
}

async function loadGraph(keepWarm = false): Promise<void> {
  if (!connection?.connected || activity !== null) return;
  const connectionRevision = connection.connectionRevision;
  const current = ++sequence;
  const pending: Exclude<RelationshipActivity, null> = { kind: 'load' };
  activity = pending;
  error = null;
  if (!keepWarm) graph = null;
  render();
  try {
    const next = await core<RelationshipGraph>('getRelationshipGraph');
    if (current !== sequence || connectionRevision !== connection?.connectionRevision) return;
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
  root.innerHTML = `<main class="workspace" aria-busy="${activity !== null}">
    <header class="workspace-heading"><div class="object-identity"><span class="object-kind">数据库</span><h1 class="object-title"></h1></div></header>
    <section class="view-host" aria-busy="${activity !== null}"></section>
    <footer class="status-deck"><div role="status" aria-live="polite"></div><div class="error-slot"></div></footer>
  </main>`;
  root.querySelector<HTMLElement>('.object-title')!.textContent = connection?.database ?? '全库关系图';
  const host = root.querySelector<HTMLElement>('.view-host')!;
  const status = root.querySelector<HTMLElement>('.status-deck > [role="status"]')!;
  status.textContent = relationshipStatus();

  if (error) {
    host.innerHTML = `<div class="empty-state error" role="alert"><span>${escape(error)}</span><button data-action="retry">重试</button></div>`;
    host.querySelector('button')?.addEventListener('click', () => void loadGraph());
    return;
  }
  if (!connection?.connected) {
    host.innerHTML = '<div class="empty-state">请先连接 MySQL 数据库。</div>';
    return;
  }
  if (!graph) {
    host.innerHTML = `<div class="empty-state">${activity ? spinner() : ''}<span>正在读取关系图…</span></div>`;
    return;
  }
  if (graph.tables.length === 0) {
    host.innerHTML = '<div class="empty-state">数据库中没有可展示的表。</div>';
    return;
  }

  const view = renderRelationshipView({
    graph,
    viewport,
    query,
    onViewportChange: (value) => { viewport = value; },
    onOpenTable: (name) => void openTable(name),
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
    query = search.value;
    render();
    queueMicrotask(() => root?.querySelector<HTMLInputElement>('input[type="search"]')?.focus());
  });
  const zoomOut = button('−', '缩小', () => zoom(1 / 1.1));
  const zoomIn = button('+', '放大', () => zoom(1.1));
  const fit = button('适应窗口', '适应窗口', fitView);
  for (const control of [zoomOut, zoomIn, fit]) control.disabled = activity !== null;
  toolbar.prepend(search, zoomOut, zoomIn, fit);
  host.append(view);
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
  layer.append(document.createRange().createContextualFragment(`${spinner()}<span>${escape(relationshipStatus())}</span>`));
  host.append(layer);
}

function spinner(): string {
  return '<span class="activity-spinner" aria-hidden="true"></span>';
}

function button(label: string, aria: string, handler: () => void): HTMLButtonElement {
  const value = document.createElement('button');
  value.type = 'button';
  value.textContent = label;
  value.setAttribute('aria-label', aria);
  value.addEventListener('click', handler);
  return value;
}

function fitView(): void {
  if (!graph || activity !== null) return;
  const canvas = root?.querySelector<HTMLElement>('.relationship-canvas');
  viewport = fitRelationshipViewport(
    layoutRelationshipGraph(graph),
    canvas?.clientWidth || 960,
    canvas?.clientHeight || 640,
  );
  render();
}

function zoom(factor: number): void {
  if (activity !== null) return;
  const canvas = root?.querySelector<HTMLElement>('.relationship-canvas');
  viewport = zoomRelationshipViewport(viewport, factor, {
    x: (canvas?.clientWidth || 960) / 2,
    y: (canvas?.clientHeight || 640) / 2,
  });
  render();
}

function setError(value: unknown, rerender = true): void {
  error = errorMessage(value);
  activity = null;
  if (rerender) render();
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
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
