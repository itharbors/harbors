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

describe('SQLite Relationships panel', () => {
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

    expect(document.querySelector('[data-relationship-table="users"]')).not.toBeNull();
    document.querySelector<HTMLElement>('[data-relationship-table="users"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/sqlite-explorer',
      'selectObject',
      { connectionRevision: 1, objectName: 'users' },
    ));
    expect(openPanel).toHaveBeenCalledWith('@itharbors/sqlite-schema.schema');
    await definition.unmount();
  });

  it('persists a dragged layout for the same file identity and isolates another database', async () => {
    let currentConnection = connection();
    const request = requestFor(() => currentConnection, () => graph);
    const definition = (await import('../panel.relationships/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { openPanel: vi.fn() } });
    const users = document.querySelector<HTMLElement>('[data-relationship-table="users"]')!;
    const originalLeft = users.style.left;
    installPointerCapture(users);
    users.dispatchEvent(pointer('pointerdown', 3, 100, 100, { button: 0 }));
    users.dispatchEvent(pointer('pointermove', 3, 180, 140));
    users.dispatchEvent(pointer('pointerup', 3, 180, 140));
    const movedLeft = users.style.left;
    expect(movedLeft).not.toBe(originalLeft);
    await definition.unmount();

    document.body.innerHTML = '<div id="panel-root"></div>';
    await definition.mount({ message: { request }, panel: { openPanel: vi.fn() } });
    expect(document.querySelector<HTMLElement>('[data-relationship-table="users"]')!.style.left)
      .toBe(movedLeft);
    await definition.unmount();

    currentConnection = connection({
      path: '/tmp/other.sqlite',
      fileIdentity: 'dev:1:ino:99',
      fileName: 'other.sqlite',
      connectionRevision: 2,
    });
    document.body.innerHTML = '<div id="panel-root"></div>';
    await definition.mount({ message: { request }, panel: { openPanel: vi.fn() } });
    expect(document.querySelector<HTMLElement>('[data-relationship-table="users"]')!.style.left)
      .toBe(originalLeft);
    await definition.unmount();
  });

  it('keeps fit position-only and auto-arranges from the current visible region', async () => {
    const { definition } = await mountPanel({
      graph: graphOf([
        'users', 'user_profiles', 'orders', 'order_items',
        'audit_logs', 'audit_events', 'settings', 'features',
      ]),
      width: 1_300,
      height: 420,
    });
    const users = document.querySelector<HTMLElement>('[data-relationship-table="users"]')!;
    installPointerCapture(users);
    users.dispatchEvent(pointer('pointerdown', 4, 100, 100, { button: 0 }));
    users.dispatchEvent(pointer('pointermove', 4, 700, 400));
    users.dispatchEvent(pointer('pointerup', 4, 700, 400));
    const dragged = positions();

    button('适应窗口').click();
    expect(positions()).toEqual(dragged);

    const canvas = document.querySelector<HTMLElement>('.relationship-canvas')!;
    setSize(canvas, 420, 1_300);
    button('自动排列').click();
    expect(positions()).not.toEqual(dragged);
    const stage = document.querySelector<HTMLElement>('.relationship-stage')!;
    expect(Number.parseFloat(stage.style.width) / Number.parseFloat(stage.style.height)).toBeLessThan(1);
    await definition.unmount();
  });

  it('keeps surviving positions across Schema changes and leaves data changes warm', async () => {
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

    await definition.methods.onDataChanged({
      connectionRevision: 1,
      schemaRevision: 2,
      dataRevision: 4,
      objectName: 'users',
    });
    expect(graphReads).toBe(1);

    await definition.methods.onSchemaChanged({
      connectionRevision: 1,
      schemaRevision: 3,
      dataRevision: 4,
    });
    expect(graphReads).toBe(2);
    expect(nodePosition('users')).toEqual(usersBefore);
    expect(nodePosition('user_profiles')).toEqual(profilesBefore);
    expect(document.querySelector('[data-relationship-table="orders"]')).toBeNull();
    expect(document.querySelector('[data-relationship-table="user_preferences"]')).not.toBeNull();
    await definition.unmount();
  });

  it('ignores a late initial snapshot after a newer connection event', async () => {
    let resolveInitial!: (value: unknown) => void;
    const initial = new Promise((resolve) => { resolveInitial = resolve; });
    const newer = connection({
      path: '/tmp/new.sqlite',
      fileIdentity: 'dev:1:ino:5',
      fileName: 'new.sqlite',
      connectionRevision: 2,
      schemaRevision: 2,
    });
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

    expect(document.querySelector('.object-title h1')?.textContent).toBe('new.sqlite');
    expect(document.querySelector('[data-relationship-table="users"]')).not.toBeNull();
    await definition.unmount();
  });

  it('preserves the SQLite workspace hierarchy and visual contract', async () => {
    const { definition } = await mountPanel();
    const workspace = document.querySelector<HTMLElement>('#panel-root > .workspace');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-title > small')?.textContent)
      .toBe('DATABASE');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-title > h1')?.textContent)
      .toBe('demo.sqlite');
    expect(workspace?.querySelector(':scope > .view-host > .relationship-view')).not.toBeNull();
    expect(workspace?.querySelector(':scope > .status-bar[role="status"]')).not.toBeNull();

    const css = readFileSync(
      resolve(process.cwd(), 'plugins/sqlite-relationships/panel.relationships/src/index.css'),
      'utf8',
    );
    expect(css).toMatch(/--ink:\s*#0b1116/);
    expect(css).toMatch(/--teal:\s*#57c8b5/);
    expect(css).toMatch(/\.workspace\s*\{[^}]*grid-template-rows:\s*58px minmax\(0,\s*1fr\) 26px/s);
    expect(css).toMatch(/\.relationship-canvas\s*\{[^}]*overflow:\s*hidden/s);
    await definition.unmount();
  });
});

async function mountPanel(options: {
  graph?: ReturnType<typeof graphOf>;
  width?: number;
  height?: number;
} = {}) {
  const selectedGraph = options.graph ?? graph;
  const request = requestFor(
    () => connection(),
    () => selectedGraph,
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
  currentGraph: () => ReturnType<typeof graphOf>,
  width = 900,
  height = 600,
) {
  return vi.fn(async (plugin: string, method: string, input?: unknown) => {
    if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') {
      return currentConnection();
    }
    if (plugin === '@itharbors/sqlite-core' && method === 'getRelationshipGraph') {
      setSize(document.querySelector<HTMLElement>('.view-host')!, width, height);
      return currentGraph();
    }
    if (plugin === '@itharbors/sqlite-explorer' && method === 'selectObject') return input;
    throw new Error(`Unexpected ${plugin}:${method}`);
  });
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    path: '/tmp/demo.sqlite',
    fileIdentity: 'dev:1:ino:2',
    fileName: 'demo.sqlite',
    mode: 'readonly',
    sqliteVersion: '3.46',
    foreignKeys: true,
    busyTimeout: 5_000,
    connectionRevision: 1,
    schemaRevision: 2,
    dataRevision: 3,
    ...overrides,
  };
}

function graphOf(names: string[]) {
  const relationships = [];
  if (names.includes('user_profiles') && names.includes('users')) {
    relationships.push({
      id: 'user_profiles:users',
      fromTable: 'user_profiles',
      toTable: 'users',
      columns: [{ from: 'user_id', to: 'id' }],
      onUpdate: 'NO ACTION',
      onDelete: 'CASCADE',
    });
  }
  if (names.includes('order_items') && names.includes('orders')) {
    relationships.push({
      id: 'order_items:orders',
      fromTable: 'order_items',
      toTable: 'orders',
      columns: [{ from: 'order_id', to: 'id' }],
      onUpdate: 'NO ACTION',
      onDelete: 'CASCADE',
    });
  }
  return {
    tables: names.map((name) => ({
      name,
      kind: 'table' as const,
      columns: [{ name: 'id', type: 'INTEGER', primaryKeyOrder: 1, foreignKey: false }],
    })),
    relationships,
  };
}

function positions() {
  return Object.fromEntries(
    [...document.querySelectorAll<HTMLElement>('[data-relationship-table]')]
      .map((node) => [node.dataset.relationshipTable!, { left: node.style.left, top: node.style.top }]),
  );
}

function nodePosition(name: string) {
  const node = document.querySelector<HTMLElement>(`[data-relationship-table="${name}"]`)!;
  return { left: node.style.left, top: node.style.top };
}

function button(label: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent === label)!;
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
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
}

function pointer(
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number,
  extra: PointerEventInit = {},
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    pointerId,
    clientX,
    clientY,
    ...extra,
  });
}

function installPointerCapture(element: HTMLElement): void {
  Object.assign(element, {
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture: vi.fn(),
  });
}
