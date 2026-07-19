import { describe, expect, it } from 'vitest';
import {
  fitRelationshipViewport,
  layoutRelationshipGraph,
  matchesRelationshipSearch,
  panRelationshipViewport,
  relationshipSummary,
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
});
