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
});
