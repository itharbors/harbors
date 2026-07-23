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

  it('changes a single connected group direction to use the current canvas', () => {
    const graph: RelationshipGraph = {
      tables: [
        table('account'),
        table('account_address', 2),
        table('account_audit', 3),
        table('account_profile', 4),
        table('account_role', 2),
      ],
      relationships: [
        relationship('address:account', 'account_address', 'account'),
        relationship('audit:account', 'account_audit', 'account'),
        relationship('profile:account', 'account_profile', 'account'),
        relationship('role:account', 'account_role', 'account'),
      ],
    };

    const wide = layoutRelationshipGraph(graph, { width: 1_600, height: 500 });
    const tall = layoutRelationshipGraph(graph, { width: 500, height: 1_600 });

    expectNoOverlap(wide);
    expectNoOverlap(tall);
    expect(wide.width / wide.height).toBeGreaterThan(1);
    expect(tall.width / tall.height).toBeLessThan(1);
    expect(wide).toEqual(layoutRelationshipGraph(graph, { width: 1_600, height: 500 }));
    expect(tall).toEqual(layoutRelationshipGraph(graph, { width: 500, height: 1_600 }));
  });

  it('includes viewport padding when choosing a group direction', () => {
    const graph: RelationshipGraph = {
      tables: [
        table('catalog', 12),
        table('catalog_a', 1),
        table('catalog_b', 3),
        table('catalog_c', 4),
        table('catalog_d', 7),
      ],
      relationships: [
        relationship('catalog:a', 'catalog_a', 'catalog'),
        relationship('catalog:b', 'catalog_b', 'catalog'),
        relationship('catalog:c', 'catalog_c', 'catalog'),
        relationship('catalog:d', 'catalog_d', 'catalog'),
      ],
    };
    const canvas = { width: 1_000, height: 600 };

    const layout = layoutRelationshipGraph(graph, canvas);
    const fitted = fitRelationshipViewport(layout, canvas);

    expectNoOverlap(layout);
    expect(fitted.scale).toBeGreaterThan(0.78);
    expect(layout.nodes.find((node) => node.name === 'catalog_a')?.y).toBe(
      layout.nodes.find((node) => node.name === 'catalog_d')?.y,
    );
  });

  it('prioritizes readable scale when packing differently sized groups', () => {
    const graph: RelationshipGraph = {
      tables: [
        table('alpha'),
        table('alpha_child_a', 4),
        table('alpha_child_b', 4),
        table('alpha_child_c', 4),
        table('beta', 9),
        table('charlie', 8),
      ],
      relationships: [
        relationship('alpha:a', 'alpha_child_a', 'alpha'),
        relationship('alpha:b', 'alpha_child_b', 'alpha'),
        relationship('alpha:c', 'alpha_child_c', 'alpha'),
      ],
    };
    const canvas = { width: 1_600, height: 600 };

    const layout = layoutRelationshipGraph(graph, canvas);
    const fitted = fitRelationshipViewport(layout, canvas);

    expectNoOverlap(layout);
    expect(fitted.scale).toBeGreaterThan(0.95);
    expect(layout.nodes.find((node) => node.name === 'charlie')?.y).toBe(
      layout.nodes.find((node) => node.name === 'alpha')?.y,
    );
  });

  it('uses group dimensions when choosing how many packing columns to evaluate', () => {
    const graph: RelationshipGraph = {
      tables: Array.from({ length: 100 }, (_, index) => (
        table(String.fromCodePoint(0x4e00 + index), 100)
      )),
      relationships: [],
    };
    const canvas = { width: 1_600, height: 600 };

    const layout = layoutRelationshipGraph(graph, canvas);
    const fitted = fitRelationshipViewport(layout, canvas);

    expectNoOverlap(layout);
    expect(fitted.scale).toBeGreaterThan(0.08);
    expect(new Set(layout.nodes.map((node) => node.y)).size).toBe(2);
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
    expect(new Set(layout.edges.map((edge) => edge.path)).size).toBe(4);
    for (const edge of layout.edges) {
      expect(edge.path).toContain(' C ');
      if (edge.fromTable !== edge.toTable) expect(edge.path).not.toContain(' L ');
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
