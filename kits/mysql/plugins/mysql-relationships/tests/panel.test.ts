// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): Promise<void> | void;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

const graph = graphOf(['users', 'user_profiles', 'orders']);

describe('MySQL Relationships panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    localStorage.clear();
    vi.resetModules();
    installBrowserFakes();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the graph and opens a table in the Schema panel', async () => {
    const { definition, request, openPanel } = await mountPanel();

    document.querySelector<HTMLElement>('[data-relationship-table="users"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/mysql-explorer',
      'selectObject',
      { connectionRevision: 1, objectName: 'users' },
    ));
    expect(openPanel).toHaveBeenCalledWith('@itharbors/mysql-schema.schema');
    await definition.unmount();
  });

  it('restores a dragged layout only for the same endpoint and database', async () => {
    let currentConnection = connection();
    const request = requestFor(() => currentConnection, () => graph);
    const definition = (await import('../panel.relationships/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { openPanel: vi.fn() } });
    const users = document.querySelector<HTMLElement>('[data-relationship-table="users"]')!;
    const originalLeft = users.style.left;
    drag(users, 100, 100, 220, 150);
    const movedLeft = users.style.left;
    expect(movedLeft).not.toBe(originalLeft);
    await definition.unmount();

    document.body.innerHTML = '<div id="panel-root"></div>';
    await definition.mount({ message: { request }, panel: { openPanel: vi.fn() } });
    expect(nodePosition('users').left).toBe(movedLeft);
    await definition.unmount();

    currentConnection = connection({ database: 'other', connectionRevision: 2 });
    document.body.innerHTML = '<div id="panel-root"></div>';
    await definition.mount({ message: { request }, panel: { openPanel: vi.fn() } });
    expect(nodePosition('users').left).toBe(originalLeft);
    await definition.unmount();

    currentConnection = connection({ endpoint: 'replica.local:3306', connectionRevision: 3 });
    document.body.innerHTML = '<div id="panel-root"></div>';
    await definition.mount({ message: { request }, panel: { openPanel: vi.fn() } });
    expect(nodePosition('users').left).toBe(originalLeft);
    await definition.unmount();
  });

  it('fits without moving nodes and auto-arranges for the current visible region', async () => {
    const { definition } = await mountPanel({
      graph: graphOf([
        'users', 'user_profiles', 'orders', 'order_items',
        'audit_logs', 'audit_events', 'settings', 'features',
      ]),
      width: 1_300,
      height: 420,
    });
    const users = document.querySelector<HTMLElement>('[data-relationship-table="users"]')!;
    drag(users, 100, 100, 700, 400);
    const dragged = positions();

    button('适应窗口').click();
    expect(positions()).toEqual(dragged);

    setSize(document.querySelector<HTMLElement>('.relationship-canvas')!, 420, 1_300);
    button('自动排列').click();
    expect(positions()).not.toEqual(dragged);
    const stage = document.querySelector<HTMLElement>('.relationship-stage')!;
    expect(Number.parseFloat(stage.style.width) / Number.parseFloat(stage.style.height)).toBeLessThan(1);
    await definition.unmount();
  });

  it('preserves surviving positions on Schema changes and ignores data changes', async () => {
    const nextGraph = graphOf(['users', 'user_profiles', 'user_preferences']);
    let graphReads = 0;
    const request = requestFor(
      () => connection(),
      () => (graphReads++ === 0 ? graph : nextGraph),
    );
    const definition = (await import('../panel.relationships/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { openPanel: vi.fn() } });
    const usersBefore = nodePosition('users');
    const profilesBefore = nodePosition('user_profiles');

    await definition.methods.onDataChanged({ connectionRevision: 1, schemaRevision: 2, dataRevision: 4 });
    expect(graphReads).toBe(1);
    await definition.methods.onSchemaChanged({ connectionRevision: 1, schemaRevision: 3, dataRevision: 4 });

    expect(graphReads).toBe(2);
    expect(nodePosition('users')).toEqual(usersBefore);
    expect(nodePosition('user_profiles')).toEqual(profilesBefore);
    expect(document.querySelector('[data-relationship-table="orders"]')).toBeNull();
    expect(document.querySelector('[data-relationship-table="user_preferences"]')).not.toBeNull();
    await definition.unmount();
  });

  it('keeps the warm graph visible and disables controls during a Schema reload', async () => {
    let resolveReload!: (value: unknown) => void;
    const pendingReload = new Promise((resolve) => { resolveReload = resolve; });
    let reads = 0;
    const request = requestFor(
      () => connection(),
      () => (++reads === 1 ? graph : pendingReload),
    );
    const definition = (await import('../panel.relationships/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { openPanel: vi.fn() } });

    const refreshing = definition.methods.onSchemaChanged({
      connectionRevision: 1,
      schemaRevision: 3,
      dataRevision: 4,
    });
    expect(document.querySelector('[data-relationship-table="users"]')).not.toBeNull();
    expect(button('自动排列').disabled).toBe(true);
    expect(document.querySelector('.relationship-activity-layer')).not.toBeNull();

    resolveReload(graph);
    await refreshing;
    expect(button('自动排列').disabled).toBe(false);
    await definition.unmount();
  });

  it('clears an error into a single visible retry request', async () => {
    let resolveRetry!: (value: unknown) => void;
    const pendingRetry = new Promise((resolve) => { resolveRetry = resolve; });
    let graphRequests = 0;
    const request = requestFor(
      () => connection(),
      () => {
        graphRequests += 1;
        if (graphRequests === 1) throw new Error('关系图读取失败');
        return pendingRetry;
      },
    );
    const definition = (await import('../panel.relationships/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { openPanel: vi.fn() } });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('关系图读取失败');

    button('重试').click();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('.view-host')?.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelector('.activity-spinner')).not.toBeNull();
    expect(graphRequests).toBe(2);

    resolveRetry(graph);
    await vi.waitFor(() => expect(document.querySelector('[data-relationship-table="users"]')).not.toBeNull());
    await definition.unmount();
  });

  it('shows table-opening progress, disables auto-arrange, and blocks duplicate requests', async () => {
    let resolveSelection!: (value: unknown) => void;
    const pendingSelection = new Promise((resolve) => { resolveSelection = resolve; });
    const request = requestFor(() => connection(), () => graph, 900, 600, pendingSelection);
    const openPanel = vi.fn();
    const definition = (await import('../panel.relationships/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { openPanel } });

    document.querySelector<HTMLElement>('[data-relationship-table="users"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.querySelector('.view-host')?.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelector('[role="status"]')?.textContent).toContain('正在打开 users…');
    expect(button('自动排列').disabled).toBe(true);
    document.querySelector<HTMLElement>('[data-relationship-table="users"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(request.mock.calls.filter((call) => call[1] === 'selectObject')).toHaveLength(1);

    resolveSelection({ connectionRevision: 1, objectName: 'users' });
    await vi.waitFor(() => expect(openPanel).toHaveBeenCalledWith('@itharbors/mysql-schema.schema'));
    await definition.unmount();
  });

  it('ignores a late initial snapshot after a newer connection event', async () => {
    let resolveInitial!: (value: unknown) => void;
    const initial = new Promise((resolve) => { resolveInitial = resolve; });
    const newer = connection({ database: 'new_app', connectionRevision: 2, schemaRevision: 3 });
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return initial;
      if (method === 'getRelationshipGraph') {
        setSize(document.querySelector<HTMLElement>('.view-host')!, 900, 600);
        return graph;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const definition = (await import('../panel.relationships/src/index')).default as PanelDefinition;
    const mounting = definition.mount({ message: { request }, panel: { openPanel: vi.fn() } });
    await definition.methods.onConnectionChanged(newer);
    resolveInitial(connection());
    await mounting;

    expect(document.querySelector('.object-title')?.textContent).toBe('new_app');
    await definition.unmount();
  });

  it('preserves the MySQL workspace hierarchy and visual contract', async () => {
    const visualGraph = graphOf(['users', 'teams'], true);
    const { definition } = await mountPanel({ graph: visualGraph });
    const workspace = document.querySelector<HTMLElement>('#panel-root > .workspace');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-kind')?.textContent).toBe('数据库');
    expect(workspace?.querySelector(':scope > .workspace-heading h1.object-title')?.textContent).toBe('app');
    const view = workspace?.querySelector<HTMLElement>(':scope > .view-host > .relationship-view');
    expect(view?.getAttribute('aria-label')).toBe('MySQL 表关系图');
    expect(view?.querySelector('.relationship-stage > .relationship-edges')).not.toBeNull();
    expect(view?.querySelector('aside.relationship-details[aria-label="关系映射明细"]')).not.toBeNull();
    expect(workspace?.querySelector(':scope > .status-deck > [role="status"] + .error-slot')).not.toBeNull();

    const css = readFileSync(
      resolve(process.cwd(), 'plugins/mysql-relationships/panel.relationships/src/index.css'),
      'utf8',
    );
    expect(css).toMatch(/--ink:\s*#07111d/);
    expect(css).toMatch(/--blue:\s*#4d9bd3/);
    expect(css).toMatch(/--cyan:\s*#76d0ec/);
    expect(css).toMatch(/--amber:\s*#f0ba57/);
    expect(css).toMatch(/\.workspace\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/s);
    expect(css).toMatch(/\.relationship-view\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/s);
    expect(css).toMatch(/\.relationship-canvas\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    await definition.unmount();
  });
});

async function mountPanel(options: {
  graph?: ReturnType<typeof graphOf>;
  width?: number;
  height?: number;
} = {}) {
  const request = requestFor(
    () => connection(),
    () => options.graph ?? graph,
    options.width ?? 900,
    options.height ?? 600,
  );
  const openPanel = vi.fn();
  const definition = (await import('../panel.relationships/src/index')).default as PanelDefinition;
  await definition.mount({ message: { request }, panel: { openPanel } });
  return { definition, request, openPanel };
}

function requestFor(
  currentConnection: () => ReturnType<typeof connection>,
  currentGraph: () => unknown,
  width = 900,
  height = 600,
  selection: Promise<unknown> | null = null,
) {
  return vi.fn(async (plugin: string, method: string, input?: unknown) => {
    if (plugin === '@itharbors/mysql-core' && method === 'getConnectionState') return currentConnection();
    if (plugin === '@itharbors/mysql-core' && method === 'getRelationshipGraph') {
      setSize(document.querySelector<HTMLElement>('.view-host')!, width, height);
      return currentGraph();
    }
    if (plugin === '@itharbors/mysql-explorer' && method === 'selectObject') return selection ?? input;
    throw new Error(`Unexpected ${plugin}:${method}`);
  });
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    endpoint: 'db.local:3306',
    database: 'app',
    mysqlVersion: '8.4.0',
    tls: true,
    connectionRevision: 1,
    schemaRevision: 2,
    dataRevision: 3,
    ...overrides,
  };
}

function graphOf(names: string[], teamsRelation = false) {
  const relationships = [];
  if (names.includes('user_profiles') && names.includes('users')) {
    relationships.push({ id: 'profiles-users', fromTable: 'user_profiles', toTable: 'users', columns: [{ from: 'user_id', to: 'id' }], onUpdate: 'NO ACTION', onDelete: 'CASCADE' });
  }
  if (names.includes('order_items') && names.includes('orders')) {
    relationships.push({ id: 'items-orders', fromTable: 'order_items', toTable: 'orders', columns: [{ from: 'order_id', to: 'id' }], onUpdate: 'NO ACTION', onDelete: 'CASCADE' });
  }
  if (teamsRelation) {
    relationships.push({ id: 'users-team', fromTable: 'users', toTable: 'teams', columns: [{ from: 'team_id', to: 'id' }], onUpdate: 'CASCADE', onDelete: 'RESTRICT' });
  }
  return {
    tables: names.map((name) => ({
      name,
      kind: 'table' as const,
      columns: [{ name: name === 'users' && teamsRelation ? 'team_id' : 'id', type: 'BIGINT', primaryKeyOrder: 1, foreignKey: name === 'users' && teamsRelation }],
    })),
    relationships,
  };
}

function positions() {
  return Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-relationship-table]')]
    .map((node) => [node.dataset.relationshipTable!, { left: node.style.left, top: node.style.top }]));
}

function nodePosition(name: string) {
  const node = document.querySelector<HTMLElement>(`[data-relationship-table="${name}"]`)!;
  return { left: node.style.left, top: node.style.top };
}

function button(label: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent === label)!;
}

function drag(element: HTMLElement, fromX: number, fromY: number, toX: number, toY: number): void {
  installPointerCapture(element);
  element.dispatchEvent(pointer('pointerdown', 7, fromX, fromY, { button: 0 }));
  element.dispatchEvent(pointer('pointermove', 7, toX, toY));
  element.dispatchEvent(pointer('pointerup', 7, toX, toY));
}

function setSize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
}

function installBrowserFakes(): void {
  if (globalThis.PointerEvent === undefined) {
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    vi.stubGlobal('PointerEvent', TestPointerEvent);
  }
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
}

function pointer(type: string, pointerId: number, clientX: number, clientY: number, extra: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, { bubbles: true, pointerId, clientX, clientY, ...extra });
}

function installPointerCapture(element: HTMLElement): void {
  Object.assign(element, {
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture: vi.fn(),
  });
}
