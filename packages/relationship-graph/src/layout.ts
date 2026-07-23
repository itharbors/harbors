import { routeRelationshipEdges } from './edges.js';
import { groupRelationshipGraph } from './groups.js';
import { compareTableNames } from './names.js';
import type {
  CanvasSize,
  NodePosition,
  Relationship,
  RelationshipGraph,
  RelationshipLayout,
  RelationshipNodeLayout,
  RelationshipTable,
  RelationshipViewport,
} from './types.js';

export const RELATIONSHIP_LAYOUT = {
  padding: 48,
  nodeWidth: 260,
  headerHeight: 42,
  rowHeight: 26,
  layerGap: 60,
  nodeGap: 44,
  groupGap: 72,
} as const;

const MIN_SCALE = 0.3;
const MAX_SCALE = 2;
const MAX_ABSOLUTE_COORDINATE = 10_000_000;
const DEFAULT_CANVAS: CanvasSize = { width: 960, height: 640 };

type GroupBox = {
  key: string;
  width: number;
  height: number;
  nodes: RelationshipNodeLayout[];
};

type LayoutDirection = 'left-to-right' | 'top-to-bottom';

type GroupCandidate = {
  box: GroupBox;
  direction: LayoutDirection;
};

type PackedGroups = {
  width: number;
  height: number;
  nodes: RelationshipNodeLayout[];
  centers: Map<string, { x: number; y: number }>;
};

type PackingMetrics = {
  fitScale: number;
  aspectError: number;
  emptyRatio: number;
  crossSpan: number;
};

type PackingCandidate = {
  packed: PackedGroups;
  metrics: PackingMetrics;
  columns: number;
};

export function layoutRelationshipGraph(
  graph: RelationshipGraph,
  requestedCanvas: CanvasSize,
): RelationshipLayout {
  const canvas = safeCanvas(requestedCanvas);
  try {
    const tables = graph.tables.slice().sort((left, right) => compareTableNames(left.name, right.name));
    const groupByName = groupRelationshipGraph({ tables, relationships: graph.relationships });
    const grouped = new Map<string, RelationshipTable[]>();
    for (const table of tables) {
      const key = groupByName.get(table.name) ?? table.name;
      const values = grouped.get(key) ?? [];
      values.push(table);
      grouped.set(key, values);
    }
    const boxes = [...grouped]
      .sort(([left], [right]) => compareTableNames(left, right))
      .map(([key, groupTables]) => layoutGroup(key, groupTables, graph.relationships, canvas));
    const packed = choosePacking(boxes, graph.relationships, groupByName, canvas);
    if (!packed.nodes.every(isFiniteNode)) return fallbackGrid(graph, canvas, groupByName);
    return rebuildRelationshipLayout(graph, packed.nodes);
  } catch {
    return fallbackGrid(graph, canvas, groupRelationshipGraph(graph));
  }
}

export function moveRelationshipNode(
  layout: RelationshipLayout,
  graph: RelationshipGraph,
  name: string,
  position: NodePosition,
): RelationshipLayout {
  if (!isCoordinate(position.x) || !isCoordinate(position.y)) return layout;
  let found = false;
  const nodes = layout.nodes.map((node) => {
    if (node.name !== name) return { ...node };
    found = true;
    return { ...node, x: position.x, y: position.y };
  });
  return found ? rebuildRelationshipLayout(graph, nodes) : layout;
}

export function rebuildRelationshipLayout(
  graph: RelationshipGraph,
  nodes: RelationshipNodeLayout[],
): RelationshipLayout {
  const sortedNodes = nodes.slice().sort((left, right) => compareTableNames(left.name, right.name));
  const routed = routeRelationshipEdges(graph.relationships, sortedNodes);
  const bounds = nodeBounds(sortedNodes);
  return {
    width: Math.max(
      RELATIONSHIP_LAYOUT.padding * 2,
      bounds.maxX + RELATIONSHIP_LAYOUT.padding,
      routed.maxX + RELATIONSHIP_LAYOUT.padding,
    ),
    height: Math.max(
      RELATIONSHIP_LAYOUT.padding * 2,
      bounds.maxY + RELATIONSHIP_LAYOUT.padding,
      routed.maxY + RELATIONSHIP_LAYOUT.padding,
    ),
    nodes: sortedNodes,
    edges: routed.edges,
  };
}

export function fitRelationshipViewport(
  layout: RelationshipLayout,
  requestedCanvas: CanvasSize,
): RelationshipViewport {
  const canvas = safeCanvas(requestedCanvas);
  const bounds = nodeBounds(layout.nodes);
  const width = Math.max(1, bounds.maxX - bounds.minX + RELATIONSHIP_LAYOUT.padding * 2);
  const height = Math.max(1, bounds.maxY - bounds.minY + RELATIONSHIP_LAYOUT.padding * 2);
  const scale = clamp(Math.min(canvas.width / width, canvas.height / height, 1), MIN_SCALE, MAX_SCALE);
  return {
    scale,
    x: (canvas.width - (bounds.maxX - bounds.minX) * scale) / 2 - bounds.minX * scale,
    y: (canvas.height - (bounds.maxY - bounds.minY) * scale) / 2 - bounds.minY * scale,
  };
}

export function zoomRelationshipViewport(
  viewport: RelationshipViewport,
  factor: number,
  anchor: NodePosition,
): RelationshipViewport {
  const scale = clamp(viewport.scale * factor, MIN_SCALE, MAX_SCALE);
  const ratio = scale / viewport.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - viewport.x) * ratio,
    y: anchor.y - (anchor.y - viewport.y) * ratio,
  };
}

export function panRelationshipViewport(
  viewport: RelationshipViewport,
  dx: number,
  dy: number,
): RelationshipViewport {
  return { x: viewport.x + dx, y: viewport.y + dy, scale: viewport.scale };
}

function layoutGroup(
  key: string,
  tables: RelationshipTable[],
  relationships: Relationship[],
  canvas: CanvasSize,
): GroupBox {
  const tableByName = new Map(tables.map((table) => [table.name, table]));
  const internal = relationships.filter((relationship) => (
    tableByName.has(relationship.fromTable) && tableByName.has(relationship.toTable)
  ));
  const related = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const relationship of internal) {
    related.add(relationship.fromTable);
    related.add(relationship.toTable);
    const children = adjacency.get(relationship.toTable) ?? [];
    if (!children.includes(relationship.fromTable)) children.push(relationship.fromTable);
    adjacency.set(relationship.toTable, children);
  }
  for (const children of adjacency.values()) children.sort(compareTableNames);

  const relatedNames = [...related].sort(compareTableNames);
  const rankByName = rankNames(relatedNames, adjacency);
  const layers = new Map<number, RelationshipTable[]>();
  for (const name of relatedNames) {
    const rank = rankByName.get(name) ?? 0;
    const values = layers.get(rank) ?? [];
    values.push(tableByName.get(name)!);
    layers.set(rank, values);
  }

  const isolated = tables
    .filter((table) => !related.has(table.name))
    .sort((left, right) => compareTableNames(left.name, right.name));
  const directions: LayoutDirection[] = [
    'left-to-right',
    'top-to-bottom',
  ];
  const candidates: GroupCandidate[] = directions.map((direction) => ({
    direction,
    box: layoutGroupCandidate(key, layers, isolated, direction, canvas),
  }));
  candidates.sort((left, right) => compareGroupCandidates(left, right, canvas));
  return candidates[0].box;
}

function layoutGroupCandidate(
  key: string,
  layers: Map<number, RelationshipTable[]>,
  isolated: RelationshipTable[],
  direction: LayoutDirection,
  canvas: CanvasSize,
): GroupBox {
  const nodes = layoutRankedNodes(key, layers, direction);
  const relatedBounds = nodeBounds(nodes);
  const isolatedNodes = layoutIsolatedNodes(key, isolated, canvas);
  if (isolatedNodes.length > 0) {
    const offset = nodes.length === 0
      ? { x: 0, y: 0 }
      : direction === 'left-to-right'
        ? { x: relatedBounds.maxX + RELATIONSHIP_LAYOUT.nodeGap, y: 0 }
        : { x: 0, y: relatedBounds.maxY + RELATIONSHIP_LAYOUT.nodeGap };
    nodes.push(...isolatedNodes.map((node) => ({
      ...node,
      x: node.x + offset.x,
      y: node.y + offset.y,
    })));
  }
  const bounds = nodeBounds(nodes);
  return {
    key,
    nodes,
    width: Math.max(RELATIONSHIP_LAYOUT.nodeWidth, bounds.maxX - bounds.minX),
    height: Math.max(
      RELATIONSHIP_LAYOUT.headerHeight + RELATIONSHIP_LAYOUT.rowHeight,
      bounds.maxY - bounds.minY,
    ),
  };
}

function layoutRankedNodes(
  key: string,
  layers: Map<number, RelationshipTable[]>,
  direction: LayoutDirection,
): RelationshipNodeLayout[] {
  const nodes: RelationshipNodeLayout[] = [];
  let rankOffset = 0;
  for (const rank of [...layers.keys()].sort((left, right) => left - right)) {
    const tables = layers.get(rank)!
      .slice()
      .sort((left, right) => compareTableNames(left.name, right.name));
    let memberOffset = 0;
    let rankSpan = 0;
    for (const table of tables) {
      const height = tableHeight(table);
      nodes.push({
        name: table.name,
        group: key,
        x: direction === 'left-to-right' ? rankOffset : memberOffset,
        y: direction === 'left-to-right' ? memberOffset : rankOffset,
        width: RELATIONSHIP_LAYOUT.nodeWidth,
        height,
      });
      memberOffset += (direction === 'left-to-right' ? height : RELATIONSHIP_LAYOUT.nodeWidth)
        + RELATIONSHIP_LAYOUT.nodeGap;
      rankSpan = Math.max(
        rankSpan,
        direction === 'left-to-right' ? RELATIONSHIP_LAYOUT.nodeWidth : height,
      );
    }
    rankOffset += rankSpan + RELATIONSHIP_LAYOUT.layerGap;
  }
  return nodes;
}

function layoutIsolatedNodes(
  key: string,
  isolated: RelationshipTable[],
  canvas: CanvasSize,
): RelationshipNodeLayout[] {
  if (isolated.length === 0) return [];
  const averageHeight = isolated.reduce((sum, table) => sum + tableHeight(table), 0)
    / isolated.length;
  const targetAspect = canvas.width / canvas.height;
  const isolatedColumns = clampInteger(
    Math.round(Math.sqrt(
      isolated.length * targetAspect * averageHeight / RELATIONSHIP_LAYOUT.nodeWidth,
    )),
    1,
    isolated.length,
  );
  const rowHeights: number[] = [];
  for (let index = 0; index < isolated.length; index += isolatedColumns) {
    rowHeights.push(Math.max(...isolated.slice(index, index + isolatedColumns).map(tableHeight)));
  }
  const rowOffsets: number[] = [];
  for (let row = 0, y = 0; row < rowHeights.length; row += 1) {
    rowOffsets.push(y);
    y += rowHeights[row] + RELATIONSHIP_LAYOUT.nodeGap;
  }
  return isolated.map((table, index) => {
    const row = Math.floor(index / isolatedColumns);
    const column = index % isolatedColumns;
    return {
      name: table.name,
      group: key,
      x: column * (RELATIONSHIP_LAYOUT.nodeWidth + RELATIONSHIP_LAYOUT.nodeGap),
      y: rowOffsets[row],
      width: RELATIONSHIP_LAYOUT.nodeWidth,
      height: tableHeight(table),
    };
  });
}

function compareGroupCandidates(
  left: GroupCandidate,
  right: GroupCandidate,
  canvas: CanvasSize,
): number {
  const leftScale = fittedScale(left.box.width, left.box.height, canvas);
  const rightScale = fittedScale(right.box.width, right.box.height, canvas);
  const scaleComparison = compareDescending(leftScale, rightScale);
  if (scaleComparison !== 0) return scaleComparison;
  const targetAspect = canvas.width / canvas.height;
  const leftAspectError = Math.abs(Math.log(left.box.width / left.box.height / targetAspect));
  const rightAspectError = Math.abs(Math.log(right.box.width / right.box.height / targetAspect));
  const aspectComparison = compareAscending(leftAspectError, rightAspectError);
  if (aspectComparison !== 0) return aspectComparison;
  const areaComparison = compareAscending(
    left.box.width * left.box.height,
    right.box.width * right.box.height,
  );
  if (areaComparison !== 0) return areaComparison;
  const preferred: LayoutDirection = canvas.width >= canvas.height
    ? 'top-to-bottom'
    : 'left-to-right';
  return left.direction === preferred ? -1 : right.direction === preferred ? 1 : 0;
}

function fittedScale(width: number, height: number, canvas: CanvasSize): number {
  return Math.min(canvas.width / Math.max(1, width), canvas.height / Math.max(1, height), 1);
}

function choosePacking(
  groups: GroupBox[],
  relationships: Relationship[],
  groupByName: Map<string, string>,
  canvas: CanvasSize,
): PackedGroups {
  if (groups.length === 0) {
    return {
      width: RELATIONSHIP_LAYOUT.padding * 2,
      height: RELATIONSHIP_LAYOUT.padding * 2,
      nodes: [],
      centers: new Map(),
    };
  }
  const maximumColumns = Math.min(
    groups.length,
    Math.ceil(Math.sqrt(groups.length * canvas.width / canvas.height)) + 2,
  );
  let best: PackingCandidate | null = null;
  for (let columns = 1; columns <= maximumColumns; columns += 1) {
    const packed = packGroups(groups, columns);
    const candidate: PackingCandidate = {
      packed,
      metrics: packingMetrics(packed, relationships, groupByName, canvas, groups),
      columns,
    };
    if (best === null || comparePackingCandidates(candidate, best) < 0) best = candidate;
  }
  return best!.packed;
}

function packGroups(groups: GroupBox[], columns: number): PackedGroups {
  const nodes: RelationshipNodeLayout[] = [];
  const centers = new Map<string, { x: number; y: number }>();
  let y = RELATIONSHIP_LAYOUT.padding;
  let maximumRight: number = RELATIONSHIP_LAYOUT.padding;
  for (let start = 0; start < groups.length; start += columns) {
    const row = groups.slice(start, start + columns);
    const rowHeight = Math.max(...row.map((group) => group.height));
    let x = RELATIONSHIP_LAYOUT.padding;
    for (const group of row) {
      for (const node of group.nodes) nodes.push({ ...node, x: node.x + x, y: node.y + y });
      centers.set(group.key, { x: x + group.width / 2, y: y + group.height / 2 });
      x += group.width + RELATIONSHIP_LAYOUT.groupGap;
    }
    maximumRight = Math.max(maximumRight, x - RELATIONSHIP_LAYOUT.groupGap);
    y += rowHeight + RELATIONSHIP_LAYOUT.groupGap;
  }
  return {
    width: maximumRight + RELATIONSHIP_LAYOUT.padding,
    height: y - RELATIONSHIP_LAYOUT.groupGap + RELATIONSHIP_LAYOUT.padding,
    nodes,
    centers,
  };
}

function packingMetrics(
  packed: PackedGroups,
  relationships: Relationship[],
  groupByName: Map<string, string>,
  canvas: CanvasSize,
  groups: GroupBox[],
): PackingMetrics {
  const targetAspect = canvas.width / canvas.height;
  const packedAspect = packed.width / packed.height;
  const aspectError = Math.abs(Math.log(packedAspect / targetAspect));
  const usedArea = groups.reduce((sum, group) => sum + group.width * group.height, 0);
  const emptyRatio = Math.max(0, 1 - usedArea / Math.max(1, packed.width * packed.height));
  const diagonal = Math.max(1, Math.hypot(packed.width, packed.height));
  let crossSpan = 0;
  for (const relationship of relationships) {
    const fromGroup = groupByName.get(relationship.fromTable);
    const toGroup = groupByName.get(relationship.toTable);
    if (fromGroup === undefined || toGroup === undefined || fromGroup === toGroup) continue;
    const from = packed.centers.get(fromGroup)!;
    const to = packed.centers.get(toGroup)!;
    crossSpan += Math.hypot(from.x - to.x, from.y - to.y) / diagonal;
  }
  return {
    fitScale: fittedScale(packed.width, packed.height, canvas),
    aspectError,
    emptyRatio,
    crossSpan,
  };
}

function comparePackingCandidates(left: PackingCandidate, right: PackingCandidate): number {
  return compareDescending(left.metrics.fitScale, right.metrics.fitScale)
    || compareAscending(left.metrics.aspectError, right.metrics.aspectError)
    || compareAscending(left.metrics.emptyRatio, right.metrics.emptyRatio)
    || compareAscending(left.metrics.crossSpan, right.metrics.crossSpan)
    || left.columns - right.columns;
}

function fallbackGrid(
  graph: RelationshipGraph,
  canvas: CanvasSize,
  groupByName: Map<string, string>,
): RelationshipLayout {
  const columns = Math.max(1, Math.floor(
    (canvas.width - RELATIONSHIP_LAYOUT.padding * 2)
      / (RELATIONSHIP_LAYOUT.nodeWidth + RELATIONSHIP_LAYOUT.nodeGap),
  ));
  const tables = graph.tables.slice().sort((left, right) => compareTableNames(left.name, right.name));
  const rowHeights: number[] = [];
  for (let index = 0; index < tables.length; index += columns) {
    rowHeights.push(Math.max(...tables.slice(index, index + columns).map(tableHeight)));
  }
  const rowOffsets: number[] = [];
  for (let row = 0, y = RELATIONSHIP_LAYOUT.padding; row < rowHeights.length; row += 1) {
    rowOffsets.push(y);
    y += rowHeights[row] + RELATIONSHIP_LAYOUT.nodeGap;
  }
  return rebuildRelationshipLayout(graph, tables.map((table, index) => ({
    name: table.name,
    group: groupByName.get(table.name) ?? table.name,
    x: RELATIONSHIP_LAYOUT.padding
      + (index % columns) * (RELATIONSHIP_LAYOUT.nodeWidth + RELATIONSHIP_LAYOUT.nodeGap),
    y: rowOffsets[Math.floor(index / columns)],
    width: RELATIONSHIP_LAYOUT.nodeWidth,
    height: tableHeight(table),
  })));
}

function rankNames(names: string[], adjacency: Map<string, string[]>): Map<string, number> {
  if (names.length === 0) return new Map();
  const components = stronglyConnectedComponents(names, adjacency);
  const componentByName = new Map<string, number>();
  components.forEach((component, index) => {
    for (const name of component) componentByName.set(name, index);
  });
  const outgoing = components.map(() => new Set<number>());
  const incoming = components.map(() => 0);
  for (const [parent, children] of adjacency) {
    const parentComponent = componentByName.get(parent);
    if (parentComponent === undefined) continue;
    for (const child of children) {
      const childComponent = componentByName.get(child);
      if (childComponent === undefined
        || childComponent === parentComponent
        || outgoing[parentComponent].has(childComponent)) continue;
      outgoing[parentComponent].add(childComponent);
      incoming[childComponent] += 1;
    }
  }
  const key = (index: number): string => components[index][0];
  const ready = components.map((_, index) => index)
    .filter((index) => incoming[index] === 0)
    .sort((left, right) => compareTableNames(key(left), key(right)));
  const rankByComponent = new Map(ready.map((index) => [index, 0]));
  while (ready.length > 0) {
    const current = ready.shift()!;
    const children = [...outgoing[current]].sort((left, right) => (
      compareTableNames(key(left), key(right))
    ));
    for (const child of children) {
      rankByComponent.set(
        child,
        Math.max(rankByComponent.get(child) ?? 0, (rankByComponent.get(current) ?? 0) + 1),
      );
      incoming[child] -= 1;
      if (incoming[child] === 0) {
        ready.push(child);
        ready.sort((left, right) => compareTableNames(key(left), key(right)));
      }
    }
  }
  return new Map(names.map((name) => [name, rankByComponent.get(componentByName.get(name)!) ?? 0]));
}

function stronglyConnectedComponents(
  names: string[],
  adjacency: Map<string, string[]>,
): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const initialize = (name: string): void => {
    indices.set(name, nextIndex);
    lowLinks.set(name, nextIndex);
    nextIndex += 1;
    stack.push(name);
    onStack.add(name);
  };

  for (const start of names) {
    if (indices.has(start)) continue;
    initialize(start);
    const frames: Array<{ name: string; childIndex: number; parent: string | null }> = [
      { name: start, childIndex: 0, parent: null },
    ];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const children = adjacency.get(frame.name) ?? [];
      if (frame.childIndex < children.length) {
        const child = children[frame.childIndex++];
        if (!indices.has(child)) {
          initialize(child);
          frames.push({ name: child, childIndex: 0, parent: frame.name });
        } else if (onStack.has(child)) {
          lowLinks.set(frame.name, Math.min(lowLinks.get(frame.name)!, indices.get(child)!));
        }
        continue;
      }
      frames.pop();
      if (frame.parent !== null) {
        lowLinks.set(frame.parent, Math.min(lowLinks.get(frame.parent)!, lowLinks.get(frame.name)!));
      }
      if (lowLinks.get(frame.name) !== indices.get(frame.name)) continue;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.name);
      component.sort(compareTableNames);
      components.push(component);
    }
  }
  return components.sort((left, right) => compareTableNames(left[0], right[0]));
}

function nodeBounds(nodes: RelationshipNodeLayout[]): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return nodes.reduce((bounds, node) => ({
    minX: Math.min(bounds.minX, node.x),
    minY: Math.min(bounds.minY, node.y),
    maxX: Math.max(bounds.maxX, node.x + node.width),
    maxY: Math.max(bounds.maxY, node.y + node.height),
  }), {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  });
}

function tableHeight(table: RelationshipTable): number {
  return RELATIONSHIP_LAYOUT.headerHeight
    + Math.max(1, table.columns.length) * RELATIONSHIP_LAYOUT.rowHeight;
}

function safeCanvas(canvas: CanvasSize): CanvasSize {
  return {
    width: Number.isFinite(canvas.width) && canvas.width > 0 ? canvas.width : DEFAULT_CANVAS.width,
    height: Number.isFinite(canvas.height) && canvas.height > 0 ? canvas.height : DEFAULT_CANVAS.height,
  };
}

function isFiniteNode(node: RelationshipNodeLayout): boolean {
  return [node.x, node.y, node.width, node.height].every(Number.isFinite);
}

function isCoordinate(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_COORDINATE;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.round(clamp(value, minimum, maximum));
}

function compareAscending(left: number, right: number): number {
  return Math.abs(left - right) <= 1e-9 ? 0 : left < right ? -1 : 1;
}

function compareDescending(left: number, right: number): number {
  return compareAscending(right, left);
}
