import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  layoutRelationshipGraph,
  moveRelationshipNode,
  renderRelationshipView,
  type RelationshipGraph,
} from '../src/index.js';

const graph: RelationshipGraph = {
  tables: [
    {
      name: 'parents',
      kind: 'table',
      columns: [{ name: 'id', type: 'INTEGER', primaryKeyOrder: 1, foreignKey: false }],
    },
    {
      name: 'children',
      kind: 'table',
      columns: [{ name: 'parent_id', type: 'INTEGER', primaryKeyOrder: 0, foreignKey: true }],
    },
    { name: 'isolated', kind: 'virtual', columns: [] },
  ],
  relationships: [{
    id: 'children:0',
    fromTable: 'children',
    toTable: 'parents',
    columns: [{ from: 'parent_id', to: 'id' }],
    onUpdate: 'NO ACTION',
    onDelete: 'CASCADE',
  }],
};

describe('shared relationship graph renderer', () => {
  beforeEach(() => {
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('renders accessible nodes, keys, search emphasis, routed edges, and visible summaries', () => {
    const onOpenTable = vi.fn();
    const view = render({ query: 'child', onOpenTable });
    document.body.append(view);

    expect(view.querySelectorAll('[data-relationship-table]')).toHaveLength(3);
    expect(view.querySelector('[data-relationship-table="children"]')?.textContent).toContain('FK');
    expect(view.querySelector('[data-relationship-table="isolated"]')?.textContent).toContain('VIRTUAL');
    expect(view.querySelector('[data-relationship-table="parents"]')?.getAttribute('data-dimmed')).toBe('true');
    expect(view.querySelectorAll('svg [data-relationship-edge]')).toHaveLength(1);
    expect(view.querySelector('[data-relationship-edge="children:0"]')?.getAttribute('marker-end'))
      .toBe('url(#relationship-arrow)');
    expect(view.querySelector('[data-relationship-summary]')?.textContent)
      .toContain('children.parent_id → parents.id');
    expect(view.querySelector('[data-relationship-detail="children:0"]')?.textContent)
      .toContain('ON DELETE CASCADE');

    const child = view.querySelector<HTMLElement>('[data-relationship-table="children"]')!;
    child.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onOpenTable).toHaveBeenCalledWith('children');
  });

  it('selects a table with Space without opening or changing layout', () => {
    const onOpenTable = vi.fn();
    const onSelectTable = vi.fn();
    const onNodeMove = vi.fn();
    const view = render({ onOpenTable, onSelectTable, onNodeMove });

    view.querySelector<HTMLElement>('[data-relationship-table="children"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

    expect(onSelectTable).toHaveBeenCalledWith('children');
    expect(onOpenTable).not.toHaveBeenCalled();
    expect(onNodeMove).not.toHaveBeenCalled();
  });

  it('focuses a selected table, its direct neighbors, and incident relationships', () => {
    const view = render({ selectedTable: 'children' });

    expect(table(view, 'children').dataset.focus).toBe('selected');
    expect(table(view, 'children').getAttribute('aria-pressed')).toBe('true');
    expect(table(view, 'parents').dataset.focus).toBe('related');
    expect(table(view, 'isolated').dataset.focus).toBe('muted');
    expect(view.querySelector<SVGPathElement>('[data-relationship-edge="children:0"]')?.dataset.focus)
      .toBe('related');
    expect(view.querySelector<HTMLElement>('[data-relationship-detail="children:0"]')?.dataset.focus)
      .toBe('related');
  });

  it('selects with click or Space, opens with double-click or Enter, and clears on blank click', () => {
    const onSelectTable = vi.fn();
    const onOpenTable = vi.fn();
    const view = render({ onSelectTable, onOpenTable });
    const child = table(view, 'children');

    child.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSelectTable).toHaveBeenLastCalledWith('children');
    expect(onOpenTable).not.toHaveBeenCalled();

    child.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    child.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    child.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSelectTable).toHaveBeenLastCalledWith('children');
    expect(onOpenTable).toHaveBeenCalledTimes(2);

    view.querySelector<HTMLElement>('.relationship-canvas')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSelectTable).toHaveBeenLastCalledWith(null);
  });

  it('does not clear selection after panning the canvas', () => {
    const onSelectTable = vi.fn();
    const view = render({ onSelectTable });
    const canvas = view.querySelector<HTMLElement>('.relationship-canvas')!;
    installPointerCapture(canvas);

    canvas.dispatchEvent(pointer('pointerdown', 12, 10, 10, { button: 0 }));
    canvas.dispatchEvent(pointer('pointermove', 12, 30, 30));
    canvas.dispatchEvent(pointer('pointerup', 12, 30, 30));
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onSelectTable).not.toHaveBeenCalled();
  });

  it('anchors wheel zoom, ignores zero delta, and clamps scale', () => {
    const onViewportChange = vi.fn();
    const view = render({
      viewport: { x: 10, y: 20, scale: 1.9 },
      onViewportChange,
    });
    const canvas = view.querySelector<HTMLElement>('.relationship-canvas')!;
    canvas.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 30,
      deltaY: 0,
    }));
    expect(onViewportChange).not.toHaveBeenCalled();

    canvas.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 110,
      clientY: 120,
      deltaY: -1,
    }));
    const next = onViewportChange.mock.calls[0][0];
    expect(next.scale).toBe(2);
    expect((110 - next.x) / next.scale).toBeCloseTo((110 - 10) / 1.9);
    expect((120 - next.y) / next.scale).toBeCloseTo((120 - 20) / 1.9);
  });

  it('pans through pointer capture without rebuilding stage nodes', () => {
    const onViewportChange = vi.fn();
    const view = render({ onViewportChange });
    const canvas = view.querySelector<HTMLElement>('.relationship-canvas')!;
    const stage = view.querySelector<HTMLElement>('.relationship-stage')!;
    const tables = [...view.querySelectorAll('[data-relationship-table]')];
    installPointerCapture(canvas);

    canvas.dispatchEvent(pointer('pointerdown', 7, 10, 15, { button: 0 }));
    canvas.dispatchEvent(pointer('pointermove', 7, 25, 35));
    canvas.dispatchEvent(pointer('pointerup', 7, 25, 35));

    expect(onViewportChange).toHaveBeenCalledWith({ x: 15, y: 20, scale: 1 });
    expect(view.querySelector('.relationship-stage')).toBe(stage);
    expect([...view.querySelectorAll('[data-relationship-table]')]).toEqual(tables);
    expect(stage.style.transform).toBe('translate(15px, 20px) scale(1)');
  });

  it('drags a node in graph space, updates its edge in place, and commits once', () => {
    const base = layoutRelationshipGraph(graph, { width: 900, height: 600 });
    const layout = moveRelationshipNode(base, graph, 'children', { x: 0, y: 0 });
    const onNodeMove = vi.fn();
    const view = render({ layout, onNodeMove });
    const child = view.querySelector<HTMLElement>('[data-relationship-table="children"]')!;
    const edge = view.querySelector<SVGPathElement>('[data-relationship-edge="children:0"]')!;
    const beforePath = edge.getAttribute('d');
    const tables = [...view.querySelectorAll('[data-relationship-table]')];
    installPointerCapture(child);

    child.dispatchEvent(pointer('pointerdown', 9, 100, 100, { button: 0 }));
    child.dispatchEvent(pointer('pointermove', 9, 160, 140));

    expect(child.style.left).toBe('60px');
    expect(child.style.top).toBe('40px');
    expect(edge.getAttribute('d')).not.toBe(beforePath);
    expect([...view.querySelectorAll('[data-relationship-table]')]).toEqual(tables);
    expect(onNodeMove).toHaveBeenCalledWith('children', { x: 60, y: 40 }, 'preview');

    child.dispatchEvent(pointer('pointerup', 9, 160, 140));
    expect(onNodeMove).toHaveBeenLastCalledWith('children', { x: 60, y: 40 }, 'commit');
    expect(onNodeMove.mock.calls.filter((call) => call[2] === 'commit')).toHaveLength(1);
  });

  it('treats movement below four pixels as a selection click', () => {
    const onOpenTable = vi.fn();
    const onSelectTable = vi.fn();
    const onNodeMove = vi.fn();
    const view = render({ onOpenTable, onSelectTable, onNodeMove });
    const child = view.querySelector<HTMLElement>('[data-relationship-table="children"]')!;
    installPointerCapture(child);

    child.dispatchEvent(pointer('pointerdown', 10, 100, 100, { button: 0 }));
    child.dispatchEvent(pointer('pointermove', 10, 102, 102));
    child.dispatchEvent(pointer('pointerup', 10, 102, 102));
    child.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onNodeMove).not.toHaveBeenCalled();
    expect(onSelectTable).toHaveBeenCalledTimes(1);
    expect(onSelectTable).toHaveBeenCalledWith('children');
    expect(onOpenTable).not.toHaveBeenCalled();
  });

  it('lists only relationships that were routed to existing nodes', () => {
    const extended: RelationshipGraph = {
      ...graph,
      relationships: [
        ...graph.relationships,
        { ...graph.relationships[0], id: 'missing:0', fromTable: 'missing' },
      ],
    };
    const layout = layoutRelationshipGraph(extended, { width: 900, height: 600 });
    const view = render({ graph: extended, layout });

    expect(view.querySelectorAll('svg [data-relationship-edge]')).toHaveLength(1);
    expect(view.querySelectorAll('[data-relationship-summary] li')).toHaveLength(1);
  });
});

function render(overrides: Partial<Parameters<typeof renderRelationshipView>[0]> = {}): HTMLElement {
  const selectedGraph = overrides.graph ?? graph;
  return renderRelationshipView({
    graph: selectedGraph,
    layout: overrides.layout ?? layoutRelationshipGraph(selectedGraph, { width: 900, height: 600 }),
    viewport: overrides.viewport ?? { x: 0, y: 0, scale: 1 },
    query: overrides.query ?? '',
    selectedTable: overrides.selectedTable ?? null,
    tableKindLabel: overrides.tableKindLabel ?? ((table) => (
      table.kind === 'virtual' ? 'VIRTUAL' : 'TABLE'
    )),
    onNodeMove: overrides.onNodeMove ?? vi.fn(),
    onViewportChange: overrides.onViewportChange ?? vi.fn(),
    onSelectTable: overrides.onSelectTable ?? vi.fn(),
    onOpenTable: overrides.onOpenTable ?? vi.fn(),
  });
}

function table(view: HTMLElement, name: string): HTMLElement {
  return view.querySelector<HTMLElement>(`[data-relationship-table="${name}"]`)!;
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
