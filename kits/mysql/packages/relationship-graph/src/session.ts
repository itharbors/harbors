import type { DatabaseLayoutIdentity } from './identity.js';
import {
  fitRelationshipViewport,
  layoutRelationshipGraph,
  moveRelationshipNode,
  rebuildRelationshipLayout,
  RELATIONSHIP_LAYOUT,
} from './layout.js';
import type { RelationshipLayoutStore } from './storage.js';
import type {
  CanvasSize,
  NodePosition,
  PersistedRelationshipStateV1,
  RelationshipGraph,
  RelationshipLayout,
  RelationshipNodeLayout,
  RelationshipViewport,
} from './types.js';

export type RelationshipGraphSnapshot = {
  layout: RelationshipLayout;
  viewport: RelationshipViewport;
  source: 'automatic' | 'cache' | 'reconciled';
};

export type RelationshipGraphSession = {
  readonly snapshot: RelationshipGraphSnapshot;
  moveNode(name: string, position: NodePosition): void;
  setViewport(viewport: RelationshipViewport): void;
  fit(canvas: CanvasSize): void;
  autoArrange(canvas: CanvasSize): void;
  updateGraph(graph: RelationshipGraph, canvas: CanvasSize): void;
  flush(): Promise<void>;
  dispose(): Promise<void>;
};

export type CreateRelationshipGraphSessionOptions = {
  identity: DatabaseLayoutIdentity;
  graph: RelationshipGraph;
  canvas: CanvasSize;
  store: RelationshipLayoutStore;
};

const SAVE_DELAY_MS = 150;
const MIN_SCALE = 0.3;
const MAX_SCALE = 2;
const MAX_ABSOLUTE_COORDINATE = 10_000_000;

export async function createRelationshipGraphSession(
  options: CreateRelationshipGraphSessionOptions,
): Promise<RelationshipGraphSession> {
  const automatic = layoutRelationshipGraph(options.graph, options.canvas);
  const cached = validatePersistedState(await options.store.load(options.identity));
  if (cached === null) {
    return new GraphSession(
      options.identity,
      options.graph,
      options.canvas,
      options.store,
      {
        layout: automatic,
        viewport: fitRelationshipViewport(automatic, options.canvas),
        source: 'automatic',
      },
      true,
    );
  }

  const restored = reconcilePositions(options.graph, automatic, cached.nodes);
  const currentNames = new Set(options.graph.tables.map((table) => table.name));
  const cachedNames = Object.keys(cached.nodes);
  const exact = cachedNames.length === currentNames.size
    && cachedNames.every((name) => currentNames.has(name));
  let viewport = sanitizeViewport(cached.viewport, fitRelationshipViewport(restored, options.canvas));
  if (!viewportShowsAnyNode(restored, viewport, options.canvas)) {
    viewport = fitRelationshipViewport(restored, options.canvas);
  }
  return new GraphSession(
    options.identity,
    options.graph,
    options.canvas,
    options.store,
    { layout: restored, viewport, source: exact ? 'cache' : 'reconciled' },
    !exact,
  );
}

class GraphSession implements RelationshipGraphSession {
  private graph: RelationshipGraph;
  private currentCanvas: CanvasSize;
  private current: RelationshipGraphSnapshot;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private dirty: boolean;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(
    private readonly identity: DatabaseLayoutIdentity,
    graph: RelationshipGraph,
    canvas: CanvasSize,
    private readonly store: RelationshipLayoutStore,
    snapshot: RelationshipGraphSnapshot,
    dirty: boolean,
  ) {
    this.graph = graph;
    this.currentCanvas = safeCanvas(canvas);
    this.current = snapshot;
    this.dirty = dirty;
    if (dirty) this.scheduleSave();
  }

  get snapshot(): RelationshipGraphSnapshot {
    return cloneSnapshot(this.current);
  }

  moveNode(name: string, position: NodePosition): void {
    this.assertActive();
    const next = sanitizePosition(position);
    if (next === null) return;
    const layout = moveRelationshipNode(this.current.layout, this.graph, name, next);
    if (layout === this.current.layout) return;
    this.current = { ...this.current, layout };
    this.markDirty();
  }

  setViewport(viewport: RelationshipViewport): void {
    this.assertActive();
    this.current = {
      ...this.current,
      viewport: sanitizeViewport(viewport, this.current.viewport),
    };
    this.markDirty();
  }

  fit(canvas: CanvasSize): void {
    this.assertActive();
    this.currentCanvas = safeCanvas(canvas);
    this.current = {
      ...this.current,
      viewport: fitRelationshipViewport(this.current.layout, this.currentCanvas),
    };
    this.markDirty();
  }

  autoArrange(canvas: CanvasSize): void {
    this.assertActive();
    this.currentCanvas = safeCanvas(canvas);
    const layout = layoutRelationshipGraph(this.graph, this.currentCanvas);
    this.current = {
      layout,
      viewport: fitRelationshipViewport(layout, this.currentCanvas),
      source: 'automatic',
    };
    this.markDirty();
  }

  updateGraph(graph: RelationshipGraph, canvas: CanvasSize): void {
    this.assertActive();
    this.graph = graph;
    this.currentCanvas = safeCanvas(canvas);
    const automatic = layoutRelationshipGraph(graph, this.currentCanvas);
    const positions = Object.fromEntries(this.current.layout.nodes.map((node) => [
      node.name,
      { x: node.x, y: node.y },
    ]));
    const layout = reconcilePositions(graph, automatic, positions);
    this.current = { ...this.current, layout, source: 'reconciled' };
    if (!viewportShowsAnyNode(layout, this.current.viewport, this.currentCanvas)) {
      this.current = {
        ...this.current,
        viewport: fitRelationshipViewport(layout, this.currentCanvas),
      };
    }
    this.markDirty();
  }

  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.persistDirtyState();
    await this.saveChain;
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    this.disposePromise = (async () => {
      await this.flush();
      this.disposed = true;
    })();
    return this.disposePromise;
  }

  private assertActive(): void {
    if (this.disposed || this.disposePromise !== null) {
      throw new Error('Relationship graph session is disposed');
    }
  }

  private markDirty(): void {
    this.dirty = true;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persistDirtyState();
    }, SAVE_DELAY_MS);
  }

  private async persistDirtyState(): Promise<void> {
    if (!this.dirty) return this.saveChain;
    this.dirty = false;
    const state = persistedState(this.current, this.currentCanvas);
    this.saveChain = this.saveChain.then(() => this.store.save(this.identity, state));
    await this.saveChain;
  }
}

function reconcilePositions(
  graph: RelationshipGraph,
  automatic: RelationshipLayout,
  savedPositions: Record<string, NodePosition>,
): RelationshipLayout {
  const nodes: RelationshipNodeLayout[] = [];
  const pending: RelationshipNodeLayout[] = [];
  for (const node of automatic.nodes) {
    const saved = sanitizePosition(savedPositions[node.name]);
    if (saved === null) pending.push({ ...node });
    else nodes.push({ ...node, ...saved });
  }

  for (const candidate of pending) {
    const groupNodes = nodes.filter((node) => node.group === candidate.group);
    const start = groupNodes.length === 0
      ? { x: candidate.x, y: candidate.y }
      : {
          x: Math.max(...groupNodes.map((node) => node.x + node.width)) + RELATIONSHIP_LAYOUT.nodeGap,
          y: Math.min(...groupNodes.map((node) => node.y)),
        };
    const position = firstAvailablePosition(candidate, start, nodes);
    nodes.push({ ...candidate, ...position });
  }
  return rebuildRelationshipLayout(graph, nodes);
}

function firstAvailablePosition(
  node: RelationshipNodeLayout,
  start: NodePosition,
  occupied: RelationshipNodeLayout[],
): NodePosition {
  for (let index = 0; index < 512; index += 1) {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const position = {
      x: start.x + column * (node.width + RELATIONSHIP_LAYOUT.nodeGap),
      y: start.y + row * (node.height + RELATIONSHIP_LAYOUT.nodeGap),
    };
    if (!occupied.some((candidate) => overlaps({ ...node, ...position }, candidate))) return position;
  }
  return start;
}

function overlaps(left: RelationshipNodeLayout, right: RelationshipNodeLayout): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function viewportShowsAnyNode(
  layout: RelationshipLayout,
  viewport: RelationshipViewport,
  requestedCanvas: CanvasSize,
): boolean {
  const canvas = safeCanvas(requestedCanvas);
  return layout.nodes.some((node) => {
    const left = node.x * viewport.scale + viewport.x;
    const top = node.y * viewport.scale + viewport.y;
    const right = (node.x + node.width) * viewport.scale + viewport.x;
    const bottom = (node.y + node.height) * viewport.scale + viewport.y;
    return left < canvas.width && right > 0 && top < canvas.height && bottom > 0;
  });
}

function validatePersistedState(value: PersistedRelationshipStateV1 | null): PersistedRelationshipStateV1 | null {
  if (value === null || safeCanvasOrNull(value.canvas) === null) return null;
  const viewport = sanitizeViewportOrNull(value.viewport);
  if (viewport === null) return null;
  const nodes: Array<[string, NodePosition]> = [];
  for (const [name, position] of Object.entries(value.nodes)) {
    const safe = sanitizePosition(position);
    if (safe === null) return null;
    nodes.push([name, safe]);
  }
  return { nodes: Object.fromEntries(nodes), viewport, canvas: safeCanvas(value.canvas) };
}

function persistedState(
  snapshot: RelationshipGraphSnapshot,
  canvas: CanvasSize,
): PersistedRelationshipStateV1 {
  return {
    nodes: Object.fromEntries(snapshot.layout.nodes.map((node) => [
      node.name,
      { x: node.x, y: node.y },
    ])),
    viewport: { ...snapshot.viewport },
    canvas: { ...canvas },
  };
}

function cloneSnapshot(snapshot: RelationshipGraphSnapshot): RelationshipGraphSnapshot {
  return {
    source: snapshot.source,
    viewport: { ...snapshot.viewport },
    layout: {
      width: snapshot.layout.width,
      height: snapshot.layout.height,
      nodes: snapshot.layout.nodes.map((node) => ({ ...node })),
      edges: snapshot.layout.edges.map((edge) => ({ ...edge })),
    },
  };
}

function sanitizePosition(value: NodePosition | undefined): NodePosition | null {
  if (value === undefined || !isCoordinate(value.x) || !isCoordinate(value.y)) return null;
  return { x: value.x, y: value.y };
}

function sanitizeViewport(
  value: RelationshipViewport,
  fallback: RelationshipViewport,
): RelationshipViewport {
  return sanitizeViewportOrNull(value) ?? fallback;
}

function sanitizeViewportOrNull(value: RelationshipViewport): RelationshipViewport | null {
  if (!isCoordinate(value.x)
    || !isCoordinate(value.y)
    || !Number.isFinite(value.scale)) return null;
  return {
    x: value.x,
    y: value.y,
    scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, value.scale)),
  };
}

function safeCanvas(value: CanvasSize): CanvasSize {
  return safeCanvasOrNull(value) ?? { width: 960, height: 640 };
}

function safeCanvasOrNull(value: CanvasSize): CanvasSize | null {
  return Number.isFinite(value.width)
    && Number.isFinite(value.height)
    && value.width > 0
    && value.height > 0
    ? { width: value.width, height: value.height }
    : null;
}

function isCoordinate(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_COORDINATE;
}
