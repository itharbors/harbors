import { describe, expect, it } from 'vitest';
import {
  fitRelationshipViewport,
  layoutRelationshipGraph,
  moveRelationshipNode,
  panRelationshipViewport,
  zoomRelationshipViewport,
  type Relationship,
  type RelationshipGraph,
  type RelationshipLayout,
} from '../src/index.js';

const businessGraph: RelationshipGraph = {
  tables: [
    table('user'),
    table('user_profile', 2),
    table('user_roles'),
    table('order'),
    table('order_items', 3),
    table('order_payments', 2),
    table('audit_log'),
    table('audit_events'),
    table('settings'),
  ],
  relationships: [
    relationship('user_profile:user', 'user_profile', 'user'),
    relationship('user_roles:user', 'user_roles', 'user'),
    relationship('order_items:order', 'order_items', 'order'),
    relationship('order_payments:order', 'order_payments', 'order'),
  ],
};

describe('relationship graph layout', () => {
  it('is deterministic, non-overlapping, and keeps name groups close', () => {
    const layout = layoutRelationshipGraph(businessGraph, { width: 1_200, height: 700 });

    expect(layoutRelationshipGraph(businessGraph, { width: 1_200, height: 700 })).toEqual(layout);
    expectNoOverlap(layout);
    expect(distance(layout, 'user', 'user_profile')).toBeLessThan(
      distance(layout, 'user', 'order_items'),
    );
    expect(distance(layout, 'order', 'order_items')).toBeLessThan(
      distance(layout, 'order', 'audit_log'),
    );
  });

  it('packs the same groups differently for wide and narrow canvases', () => {
    const wide = layoutRelationshipGraph(businessGraph, { width: 1_400, height: 500 });
    const narrow = layoutRelationshipGraph(businessGraph, { width: 500, height: 1_400 });

    expectNoOverlap(wide);
    expectNoOverlap(narrow);
    expect(wide.width / wide.height).toBeGreaterThan(narrow.width / narrow.height);
  });

  it('routes cycles, self references, and parallel relationships inside bounds', () => {
    const graph: RelationshipGraph = {
      tables: [table('employee'), table('team'), table('team_member')],
      relationships: [
        relationship('employee:self', 'employee', 'employee'),
        relationship('team:member', 'team', 'team_member'),
        relationship('member:team:1', 'team_member', 'team'),
        relationship('member:team:2', 'team_member', 'team'),
      ],
    };

    const layout = layoutRelationshipGraph(graph, { width: 900, height: 600 });
    expect(layout.edges).toHaveLength(4);
    expect(layout.edges.find((edge) => edge.id === 'employee:self')!.path).toContain('C');
    expect(new Set(layout.edges.map((edge) => edge.path)).size).toBe(4);
    for (const edge of layout.edges) {
      for (const coordinate of pathCoordinates(edge.path)) {
        expect(coordinate.x).toBeGreaterThanOrEqual(0);
        expect(coordinate.y).toBeGreaterThanOrEqual(0);
        expect(coordinate.x).toBeLessThanOrEqual(layout.width);
        expect(coordinate.y).toBeLessThanOrEqual(layout.height);
      }
    }
  });

  it('moves one node and reroutes its incident edges', () => {
    const layout = layoutRelationshipGraph(businessGraph, { width: 1_200, height: 700 });
    const before = layout.edges.find((edge) => edge.id === 'user_profile:user')!.path;
    const moved = moveRelationshipNode(layout, businessGraph, 'user_profile', { x: 50, y: 70 });

    expect(moved.nodes.find((node) => node.name === 'user_profile')).toMatchObject({ x: 50, y: 70 });
    expect(moved.edges.find((edge) => edge.id === 'user_profile:user')!.path).not.toBe(before);
    expect(moved.nodes.find((node) => node.name === 'order')).toEqual(
      layout.nodes.find((node) => node.name === 'order'),
    );
  });

  it('fits, zooms around an anchor, and pans with scale limits', () => {
    const layout = layoutRelationshipGraph(businessGraph, { width: 900, height: 600 });
    const fitted = fitRelationshipViewport(layout, { width: 800, height: 500 });
    const zoomed = zoomRelationshipViewport(fitted, 1.5, { x: 400, y: 250 });
    const panned = panRelationshipViewport(zoomed, 15, -10);

    expect(fitted.scale).toBeGreaterThanOrEqual(0.3);
    expect(fitted.scale).toBeLessThanOrEqual(1);
    expect((400 - zoomed.x) / zoomed.scale).toBeCloseTo((400 - fitted.x) / fitted.scale);
    expect((250 - zoomed.y) / zoomed.scale).toBeCloseTo((250 - fitted.y) / fitted.scale);
    expect(panned).toEqual({ x: zoomed.x + 15, y: zoomed.y - 10, scale: zoomed.scale });
    expect(zoomRelationshipViewport(fitted, 100, { x: 0, y: 0 }).scale).toBe(2);
    expect(zoomRelationshipViewport(fitted, 0.0001, { x: 0, y: 0 }).scale).toBe(0.3);
  });

  it('ignores relationships whose endpoints do not exist', () => {
    const graph: RelationshipGraph = {
      tables: [table('known')],
      relationships: [relationship('missing', 'known', 'absent')],
    };

    expect(layoutRelationshipGraph(graph, { width: 500, height: 500 }).edges).toEqual([]);
  });

  it('lays out a five-thousand-table chain without exhausting the call stack', () => {
    const tables = Array.from({ length: 5_000 }, (_, index) => table(`table_${index}`));
    const relationships = tables.slice(1).map((current, index) => (
      relationship(`edge:${index}`, current.name, tables[index].name)
    ));

    const layout = layoutRelationshipGraph({ tables, relationships }, { width: 1_200, height: 800 });

    expect(layout.nodes).toHaveLength(5_000);
    expect(layout.edges).toHaveLength(4_999);
  }, 20_000);
});

function table(name: string, columns = 1) {
  return {
    name,
    kind: 'table',
    columns: Array.from({ length: columns }, (_, index) => ({
      name: `column_${index}`,
      type: 'INTEGER',
      primaryKeyOrder: index === 0 ? 1 : 0,
      foreignKey: false,
    })),
  };
}

function relationship(id: string, fromTable: string, toTable: string): Relationship {
  return {
    id,
    fromTable,
    toTable,
    columns: [{ from: 'id', to: 'id' }],
    onUpdate: 'NO ACTION',
    onDelete: 'NO ACTION',
  };
}

function expectNoOverlap(layout: RelationshipLayout): void {
  for (let leftIndex = 0; leftIndex < layout.nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < layout.nodes.length; rightIndex += 1) {
      const left = layout.nodes[leftIndex];
      const right = layout.nodes[rightIndex];
      const overlaps = left.x < right.x + right.width
        && left.x + left.width > right.x
        && left.y < right.y + right.height
        && left.y + left.height > right.y;
      expect(overlaps, `${left.name} overlaps ${right.name}`).toBe(false);
    }
  }
}

function distance(layout: RelationshipLayout, leftName: string, rightName: string): number {
  const left = layout.nodes.find((node) => node.name === leftName)!;
  const right = layout.nodes.find((node) => node.name === rightName)!;
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function pathCoordinates(path: string): Array<{ x: number; y: number }> {
  const numbers = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  const coordinates: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < numbers.length; index += 2) {
    coordinates.push({ x: numbers[index], y: numbers[index + 1] });
  }
  return coordinates;
}
