import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseLayoutIdentity,
  createRelationshipGraphSession,
  createRelationshipLayoutStore,
  type CanvasSize,
  type PersistedRelationshipStateV1,
  type RelationshipGraph,
  type RelationshipLayoutStore,
} from '../src/index.js';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const identity = createDatabaseLayoutIdentity('sqlite', ['/tmp/app.db', 'dev:1:ino:2']);
const canvas: CanvasSize = { width: 900, height: 600 };
const initialGraph = graphOf(['user', 'user_profile', 'order']);

describe('relationship graph session', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists node positions and viewport and restores exact database state', async () => {
    const store = createRelationshipLayoutStore(new MemoryStorage(), {
      digest: async () => 'digest',
      now: () => 1,
    });
    const session = await createRelationshipGraphSession({ identity, graph: initialGraph, canvas, store });
    expect(session.snapshot.source).toBe('automatic');

    session.moveNode('user_profile', { x: 700, y: 80 });
    session.setViewport({ x: 11, y: 12, scale: 0.8 });
    await session.flush();

    const restored = await createRelationshipGraphSession({ identity, graph: initialGraph, canvas, store });
    expect(restored.snapshot.source).toBe('cache');
    expect(positionOf(restored.snapshot, 'user_profile')).toEqual({ x: 700, y: 80 });
    expect(restored.snapshot.viewport).toEqual({ x: 11, y: 12, scale: 0.8 });
    await session.dispose();
    await restored.dispose();
  });

  it('preserves surviving positions, removes dead nodes, and places a new table near its name group', async () => {
    const store = createRelationshipLayoutStore(new MemoryStorage(), { digest: async () => 'digest' });
    const session = await createRelationshipGraphSession({ identity, graph: initialGraph, canvas, store });
    session.moveNode('user', { x: 100, y: 100 });
    session.moveNode('user_profile', { x: 420, y: 100 });
    session.moveNode('order', { x: 2_000, y: 1_000 });
    const userBefore = positionOf(session.snapshot, 'user');
    const profileBefore = positionOf(session.snapshot, 'user_profile');

    session.updateGraph(graphOf(['user', 'user_profile', 'user_preferences']), canvas);
    const next = session.snapshot;

    expect(positionOf(next, 'user')).toEqual(userBefore);
    expect(positionOf(next, 'user_profile')).toEqual(profileBefore);
    expect(next.layout.nodes.some((node) => node.name === 'order')).toBe(false);
    expect(next.layout.nodes.some((node) => node.name === 'user_preferences')).toBe(true);
    expect(distance(next, 'user_preferences', 'user')).toBeLessThan(1_000);
    expectNoOverlap(next.layout.nodes);
    expect(next.source).toBe('reconciled');
    await session.dispose();
  });

  it('fits without moving nodes and auto-arranges for the latest canvas', async () => {
    const store = createRelationshipLayoutStore(new MemoryStorage(), { digest: async () => 'digest' });
    const session = await createRelationshipGraphSession({ identity, graph: initialGraph, canvas, store });
    session.moveNode('order', { x: 4_000, y: 2_000 });
    const beforeFit = positions(session.snapshot);

    session.fit({ width: 500, height: 400 });
    expect(positions(session.snapshot)).toEqual(beforeFit);
    const fittedViewport = session.snapshot.viewport;

    session.autoArrange({ width: 400, height: 1_200 });
    expect(positions(session.snapshot)).not.toEqual(beforeFit);
    expect(session.snapshot.viewport).not.toEqual(fittedViewport);
    expect(session.snapshot.source).toBe('automatic');
    await session.dispose();
  });

  it('falls back to an automatic fitted layout for invalid or offscreen cache state', async () => {
    const invalidStore: RelationshipLayoutStore = {
      async load() {
        return {
          nodes: { user: { x: Number.POSITIVE_INFINITY, y: 0 } },
          viewport: { x: 0, y: 0, scale: 0.8 },
          canvas,
        };
      },
      async save() {},
    };
    const invalid = await createRelationshipGraphSession({
      identity,
      graph: initialGraph,
      canvas,
      store: invalidStore,
    });
    expect(invalid.snapshot.source).toBe('automatic');
    expect(invalid.snapshot.layout.nodes.every((node) => Number.isFinite(node.x))).toBe(true);

    const offscreenStore: RelationshipLayoutStore = {
      async load() {
        return {
          nodes: Object.fromEntries(initialGraph.tables.map((table) => [
            table.name,
            { x: 100, y: 100 },
          ])),
          viewport: { x: -5_000, y: -5_000, scale: 1 },
          canvas,
        };
      },
      async save() {},
    };
    const offscreen = await createRelationshipGraphSession({
      identity,
      graph: initialGraph,
      canvas,
      store: offscreenStore,
    });
    expect(offscreen.snapshot.source).toBe('cache');
    expect(offscreen.snapshot.viewport.x).not.toBe(-5_000);
    expect(offscreen.snapshot.viewport.y).not.toBe(-5_000);
    await invalid.dispose();
    await offscreen.dispose();
  });

  it('coalesces mutations into a delayed save and flushes disposal once', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_identity, _state: PersistedRelationshipStateV1) => {});
    const store: RelationshipLayoutStore = { load: async () => null, save };
    const session = await createRelationshipGraphSession({ identity, graph: initialGraph, canvas, store });
    await session.flush();
    save.mockClear();

    session.moveNode('user', { x: 10, y: 20 });
    session.moveNode('user', { x: 30, y: 40 });
    session.setViewport({ x: 1, y: 2, scale: 0.9 });
    await vi.advanceTimersByTimeAsync(149);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][1].nodes.user).toEqual({ x: 30, y: 40 });

    session.moveNode('user', { x: 50, y: 60 });
    await session.dispose();
    await session.dispose();
    expect(save).toHaveBeenCalledTimes(2);
    expect(() => session.moveNode('user', { x: 70, y: 80 })).toThrow(/disposed/i);
  });
});

function graphOf(names: string[]): RelationshipGraph {
  return {
    tables: names.map((name) => ({
      name,
      kind: 'table',
      columns: [{ name: 'id', type: 'INTEGER', primaryKeyOrder: 1, foreignKey: false }],
    })),
    relationships: names.includes('user_profile') && names.includes('user') ? [{
      id: 'user_profile:user',
      fromTable: 'user_profile',
      toTable: 'user',
      columns: [{ from: 'user_id', to: 'id' }],
      onUpdate: 'NO ACTION',
      onDelete: 'CASCADE',
    }] : [],
  };
}

function positionOf(snapshot: { layout: { nodes: Array<{ name: string; x: number; y: number }> } }, name: string) {
  const node = snapshot.layout.nodes.find((candidate) => candidate.name === name)!;
  return { x: node.x, y: node.y };
}

function positions(snapshot: { layout: { nodes: Array<{ name: string; x: number; y: number }> } }) {
  return Object.fromEntries(snapshot.layout.nodes.map((node) => [node.name, { x: node.x, y: node.y }]));
}

function distance(
  snapshot: { layout: { nodes: Array<{ name: string; x: number; y: number }> } },
  leftName: string,
  rightName: string,
): number {
  const left = positionOf(snapshot, leftName);
  const right = positionOf(snapshot, rightName);
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function expectNoOverlap(nodes: Array<{ name: string; x: number; y: number; width: number; height: number }>): void {
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      expect(
        left.x < right.x + right.width
          && left.x + left.width > right.x
          && left.y < right.y + right.height
          && left.y + left.height > right.y,
        `${left.name} overlaps ${right.name}`,
      ).toBe(false);
    }
  }
}
