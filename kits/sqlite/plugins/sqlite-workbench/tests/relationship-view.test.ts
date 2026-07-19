// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import {
  fitRelationshipViewport,
  layoutRelationshipGraph,
  matchesRelationshipSearch,
  panRelationshipViewport,
  relationshipSummary,
  renderRelationshipView,
  zoomRelationshipViewport,
  type RelationshipGraph,
} from '../panel.workbench/src/relationship-view';

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
    { name: 'isolated', kind: 'table', columns: [] },
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

const cyclicGraph: RelationshipGraph = {
  tables: [
    {
      name: 'employees',
      kind: 'table',
      columns: [{ name: 'manager_id', type: 'INTEGER', primaryKeyOrder: 0, foreignKey: true }],
    },
    {
      name: 'cycle_a',
      kind: 'table',
      columns: [{ name: 'b_id', type: 'INTEGER', primaryKeyOrder: 0, foreignKey: true }],
    },
    {
      name: 'cycle_b',
      kind: 'table',
      columns: [{ name: 'a_id', type: 'INTEGER', primaryKeyOrder: 0, foreignKey: true }],
    },
    {
      name: 'links',
      kind: 'table',
      columns: [
        { name: 'primary_target_id', type: 'INTEGER', primaryKeyOrder: 0, foreignKey: true },
        { name: 'backup_target_id', type: 'INTEGER', primaryKeyOrder: 0, foreignKey: true },
      ],
    },
    {
      name: 'targets',
      kind: 'table',
      columns: [{ name: 'id', type: 'INTEGER', primaryKeyOrder: 1, foreignKey: false }],
    },
  ],
  relationships: [
    {
      id: 'employees:0',
      fromTable: 'employees',
      toTable: 'employees',
      columns: [{ from: 'manager_id', to: 'id' }],
      onUpdate: 'NO ACTION',
      onDelete: 'SET NULL',
    },
    {
      id: 'cycle_a:0',
      fromTable: 'cycle_a',
      toTable: 'cycle_b',
      columns: [{ from: 'b_id', to: 'id' }],
      onUpdate: 'NO ACTION',
      onDelete: 'NO ACTION',
    },
    {
      id: 'cycle_b:0',
      fromTable: 'cycle_b',
      toTable: 'cycle_a',
      columns: [{ from: 'a_id', to: 'id' }],
      onUpdate: 'NO ACTION',
      onDelete: 'NO ACTION',
    },
    {
      id: 'links:1',
      fromTable: 'links',
      toTable: 'targets',
      columns: [{ from: 'backup_target_id', to: 'id' }],
      onUpdate: 'NO ACTION',
      onDelete: 'NO ACTION',
    },
    {
      id: 'links:0',
      fromTable: 'links',
      toTable: 'targets',
      columns: [{ from: 'primary_target_id', to: 'id' }],
      onUpdate: 'NO ACTION',
      onDelete: 'CASCADE',
    },
  ],
};

const crowdedCycleGraph: RelationshipGraph = {
  tables: [
    {
      name: 'cycle_a',
      kind: 'table',
      columns: [{ name: 'b_id', type: 'INTEGER', primaryKeyOrder: 0, foreignKey: true }],
    },
    {
      name: 'cycle_b',
      kind: 'table',
      columns: [{ name: 'a_id', type: 'INTEGER', primaryKeyOrder: 0, foreignKey: true }],
    },
    {
      name: 'employees',
      kind: 'table',
      columns: Array.from({ length: 8 }, (_, index) => ({
        name: `manager_${index}_id`,
        type: 'INTEGER',
        primaryKeyOrder: 0,
        foreignKey: true,
      })),
    },
  ],
  relationships: [
    {
      id: 'cycle_a:0',
      fromTable: 'cycle_a',
      toTable: 'cycle_b',
      columns: [{ from: 'b_id', to: 'id' }],
      onUpdate: 'NO ACTION',
      onDelete: 'NO ACTION',
    },
    {
      id: 'cycle_b:0',
      fromTable: 'cycle_b',
      toTable: 'cycle_a',
      columns: [{ from: 'a_id', to: 'id' }],
      onUpdate: 'NO ACTION',
      onDelete: 'NO ACTION',
    },
    ...Array.from({ length: 8 }, (_, index): RelationshipGraph['relationships'][number] => ({
      id: `employees:${index}`,
      fromTable: 'employees',
      toTable: 'employees',
      columns: [{ from: `manager_${index}_id`, to: 'id' }],
      onUpdate: 'NO ACTION',
      onDelete: 'SET NULL',
    })),
  ],
};

function pathCoordinates(path: string): Array<{ x: number; y: number }> {
  const tokens = path.match(/[A-Z]|-?\d+(?:\.\d+)?/g) ?? [];
  const coordinates: Array<{ x: number; y: number }> = [];
  let x = 0;
  let y = 0;
  let index = 0;
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'M') {
      x = Number(tokens[index++]);
      y = Number(tokens[index++]);
      coordinates.push({ x, y });
    } else if (command === 'H') {
      x = Number(tokens[index++]);
      coordinates.push({ x, y });
    } else if (command === 'V') {
      y = Number(tokens[index++]);
      coordinates.push({ x, y });
    } else if (command === 'C') {
      for (let point = 0; point < 3; point += 1) {
        x = Number(tokens[index++]);
        y = Number(tokens[index++]);
        coordinates.push({ x, y });
      }
    } else {
      throw new Error(`Unsupported path command: ${command}`);
    }
  }
  return coordinates;
}

function orthogonalMidpointX(path: string): number {
  const match = path.match(/ H (-?\d+(?:\.\d+)?) V /);
  if (!match) throw new Error(`Missing orthogonal midpoint: ${path}`);
  return Number(match[1]);
}

describe('SQLite relationship view', () => {
  it('renders accessible table nodes, SVG edges, search emphasis, and summaries', () => {
    const onOpenTable = vi.fn();
    const view = renderRelationshipView({
      graph,
      viewport: { x: 0, y: 0, scale: 1 },
      query: 'child',
      onViewportChange: vi.fn(),
      onOpenTable,
    });
    document.body.append(view);
    expect(view.querySelectorAll('[data-relationship-table]')).toHaveLength(3);
    expect(view.querySelector('[data-relationship-table="children"]')?.textContent).toContain('FK');
    expect(view.querySelector('[data-relationship-table="parents"]')?.getAttribute('data-dimmed')).toBe('true');
    expect(view.querySelectorAll('svg [data-relationship-edge]')).toHaveLength(1);
    expect(view.querySelector('[data-relationship-summary]')?.textContent).toContain('children.parent_id → parents.id');
    expect(view.querySelector('[data-relationship-summary]')?.closest('.relationship-details')).not.toBeNull();
    expect(view.querySelector('.sr-only [data-relationship-summary]')).toBeNull();
    expect(view.querySelector('[data-relationship-detail="children:0"]')?.textContent)
      .toContain('children.parent_id → parents.id');
    expect(view.querySelector('[data-relationship-edge="children:0"]')?.getAttribute('marker-end'))
      .toBe('url(#relationship-arrow)');
    const child = view.querySelector<HTMLElement>('[data-relationship-table="children"]')!;
    child.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onOpenTable).toHaveBeenCalledWith('children');
  });

  it('opens a table with the Space key', () => {
    const onOpenTable = vi.fn();
    const view = renderRelationshipView({
      graph,
      viewport: { x: 0, y: 0, scale: 1 },
      query: '',
      onViewportChange: vi.fn(),
      onOpenTable,
    });
    const child = view.querySelector<HTMLElement>('[data-relationship-table="children"]')!;
    child.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(onOpenTable).toHaveBeenCalledWith('children');
  });

  it('dims an edge only when neither endpoint matches the search query', () => {
    const renderWithQuery = (query: string): HTMLElement => renderRelationshipView({
      graph,
      viewport: { x: 0, y: 0, scale: 1 },
      query,
      onViewportChange: vi.fn(),
      onOpenTable: vi.fn(),
    });
    expect(
      renderWithQuery('isolated')
        .querySelector('[data-relationship-edge="children:0"]')
        ?.getAttribute('data-dimmed'),
    ).toBe('true');
    expect(
      renderWithQuery('child')
        .querySelector('[data-relationship-edge="children:0"]')
        ?.getAttribute('data-dimmed'),
    ).toBe('false');
    expect(
      renderWithQuery('')
        .querySelector('[data-relationship-edge="children:0"]')
        ?.getAttribute('data-dimmed'),
    ).toBe('false');
  });

  it('ignores a zero-delta wheel event', () => {
    const onViewportChange = vi.fn();
    const view = renderRelationshipView({
      graph,
      viewport: { x: 0, y: 0, scale: 1 },
      query: '',
      onViewportChange,
      onOpenTable: vi.fn(),
    });
    view.querySelector<HTMLElement>('.relationship-canvas')!.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 30,
      deltaX: 12,
      deltaY: 0,
    }));
    expect(onViewportChange).not.toHaveBeenCalled();
  });

  it('anchors wheel zoom to the pointer and clamps the scale', () => {
    const onViewportChange = vi.fn();
    const view = renderRelationshipView({
      graph,
      viewport: { x: 10, y: 20, scale: 1.9 },
      query: '',
      onViewportChange,
      onOpenTable: vi.fn(),
    });
    view.querySelector<HTMLElement>('.relationship-canvas')!.dispatchEvent(new WheelEvent('wheel', {
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
    const view = renderRelationshipView({
      graph,
      viewport: { x: 0, y: 0, scale: 1 },
      query: '',
      onViewportChange,
      onOpenTable: vi.fn(),
    });
    const canvas = view.querySelector<HTMLElement>('.relationship-canvas')!;
    const stage = view.querySelector<HTMLElement>('.relationship-stage')!;
    const tables = [...view.querySelectorAll('[data-relationship-table]')];
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.assign(canvas, {
      setPointerCapture,
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture,
    });

    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 10,
      clientY: 15,
      pointerId: 7,
    }));
    canvas.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      clientX: 25,
      clientY: 35,
      pointerId: 7,
    }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));

    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(onViewportChange).toHaveBeenCalledWith({ x: 15, y: 20, scale: 1 });
    expect(view.querySelector('.relationship-stage')).toBe(stage);
    expect([...view.querySelectorAll('[data-relationship-table]')]).toEqual(tables);
    expect(stage.style.transform).toBe('translate(15px, 20px) scale(1)');
  });

  it('keeps non-SVG summaries aligned with routed relationships', () => {
    const view = renderRelationshipView({
      graph: {
        ...graph,
        relationships: [
          ...graph.relationships,
          {
            ...graph.relationships[0],
            id: 'missing:0',
            fromTable: 'missing',
          },
        ],
      },
      viewport: { x: 0, y: 0, scale: 1 },
      query: '',
      onViewportChange: vi.fn(),
      onOpenTable: vi.fn(),
    });
    expect(view.querySelectorAll('svg [data-relationship-edge]')).toHaveLength(1);
    expect(view.querySelectorAll('[data-relationship-summary] li')).toHaveLength(1);
  });

  it('places parents before children and isolated tables below without overlap', () => {
    const first = layoutRelationshipGraph(graph);
    expect(layoutRelationshipGraph(graph)).toEqual(first);
    const parent = first.nodes.find((node) => node.name === 'parents')!;
    const child = first.nodes.find((node) => node.name === 'children')!;
    const isolated = first.nodes.find((node) => node.name === 'isolated')!;
    expect(parent.x).toBeLessThan(child.x);
    expect(isolated.y).toBeGreaterThan(Math.max(parent.y + parent.height, child.y + child.height));
    for (const [index, left] of first.nodes.entries()) {
      for (const right of first.nodes.slice(index + 1)) {
        expect(
          left.x + left.width <= right.x
          || right.x + right.width <= left.x
          || left.y + left.height <= right.y
          || right.y + right.height <= left.y,
        ).toBe(true);
      }
    }
  });

  it('constrains fit, zoom, pan, search, and readable summaries', () => {
    const layout = layoutRelationshipGraph(graph);
    expect(fitRelationshipViewport(layout, 800, 500).scale).toBeGreaterThanOrEqual(0.3);
    expect(zoomRelationshipViewport({ x: 0, y: 0, scale: 1 }, 99, { x: 100, y: 100 }).scale).toBe(2);
    expect(zoomRelationshipViewport({ x: 0, y: 0, scale: 1 }, 0.001, { x: 100, y: 100 }).scale).toBe(0.3);
    expect(panRelationshipViewport({ x: 1, y: 2, scale: 1 }, 5, -3)).toEqual({
      x: 6,
      y: -1,
      scale: 1,
    });
    expect(matchesRelationshipSearch('UserAccounts', 'account')).toBe(true);
    expect(relationshipSummary(graph.relationships[0])).toContain('children.parent_id → parents.id');
  });

  it('routes cycles, self-loops, and parallel edges deterministically', () => {
    const layout = layoutRelationshipGraph(cyclicGraph);
    expect(layout.edges.find((edge) => edge.id === 'employees:0')!.path).toContain('C');
    expect(new Set(
      layout.edges
        .filter((edge) => edge.fromTable === 'links' && edge.toTable === 'targets')
        .map((edge) => edge.path),
    ).size).toBe(2);
    expect(layout.nodes.filter((node) => ['cycle_a', 'cycle_b'].includes(node.name))).toHaveLength(2);
    expect(layoutRelationshipGraph(cyclicGraph)).toEqual(layout);
  });

  it('shows every reciprocal and parallel mapping in a visible relationship list', () => {
    const view = renderRelationshipView({
      graph: cyclicGraph,
      viewport: { x: 0, y: 0, scale: 1 },
      query: '',
      onViewportChange: vi.fn(),
      onOpenTable: vi.fn(),
    });

    const details = [...view.querySelectorAll<HTMLElement>('[data-relationship-detail]')];
    expect(details).toHaveLength(cyclicGraph.relationships.length);
    expect(details.every((detail) => !detail.closest('.sr-only'))).toBe(true);
    expect(details.map((detail) => detail.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('cycle_a.b_id → cycle_b.id'),
      expect.stringContaining('cycle_b.a_id → cycle_a.id'),
      expect.stringContaining('links.primary_target_id → targets.id'),
      expect.stringContaining('links.backup_target_id → targets.id'),
    ]));
  });

  it('routes reciprocal same-rank relationships on distinct tracks', () => {
    const layout = layoutRelationshipGraph(crowdedCycleGraph);
    const reciprocal = layout.edges.filter((edge) => edge.fromTable.startsWith('cycle_'));
    expect(new Set(reciprocal.map((edge) => orthogonalMidpointX(edge.path))).size).toBe(2);
  });

  it('includes every routed edge coordinate inside the declared layout bounds', () => {
    const layout = layoutRelationshipGraph(crowdedCycleGraph);
    for (const edge of layout.edges) {
      for (const coordinate of pathCoordinates(edge.path)) {
        expect(coordinate.x).toBeGreaterThanOrEqual(0);
        expect(coordinate.x).toBeLessThanOrEqual(layout.width);
        expect(coordinate.y).toBeGreaterThanOrEqual(0);
        expect(coordinate.y).toBeLessThanOrEqual(layout.height);
      }
    }
  });

  it('keeps eight parallel self references distinct and strictly right of their node', () => {
    const layout = layoutRelationshipGraph(crowdedCycleGraph);
    const employee = layout.nodes.find((node) => node.name === 'employees')!;
    const selfPaths = layout.edges
      .filter((edge) => edge.fromTable === 'employees' && edge.toTable === 'employees')
      .map((edge) => edge.path);
    expect(new Set(selfPaths).size).toBe(8);
    for (const path of selfPaths) {
      expect(Math.max(...pathCoordinates(path).map((coordinate) => coordinate.x)))
        .toBeGreaterThan(employee.x + employee.width);
    }
  });

  it('lays out a five-thousand-table chain without exhausting the call stack', () => {
    const tables = Array.from({ length: 5_000 }, (_, index) => ({
      name: `chain_${String(index).padStart(4, '0')}`,
      kind: 'table' as const,
      columns: [{ name: 'parent_id', type: 'INTEGER', primaryKeyOrder: 0, foreignKey: index > 0 }],
    }));
    const relationships = tables.slice(1).map((table, index) => ({
      id: `${table.name}:0`,
      fromTable: table.name,
      toTable: tables[index].name,
      columns: [{ from: 'parent_id', to: 'id' }],
      onUpdate: 'NO ACTION',
      onDelete: 'NO ACTION',
    }));

    const layout = layoutRelationshipGraph({ tables, relationships });

    expect(layout.nodes).toHaveLength(5_000);
    expect(layout.edges).toHaveLength(4_999);
  });
});
