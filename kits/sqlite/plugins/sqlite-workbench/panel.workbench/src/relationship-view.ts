export type RelationshipColumn = {
  name: string;
  type: string;
  primaryKeyOrder: number;
  foreignKey: boolean;
};

export type RelationshipTable = {
  name: string;
  kind: 'table' | 'virtual';
  columns: RelationshipColumn[];
};

export type Relationship = {
  id: string;
  fromTable: string;
  toTable: string;
  columns: Array<{ from: string; to: string | null }>;
  onUpdate: string;
  onDelete: string;
};

export type RelationshipGraph = {
  tables: RelationshipTable[];
  relationships: Relationship[];
};

export type RelationshipViewport = { x: number; y: number; scale: number };

export type RelationshipNodeLayout = {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RelationshipEdgeLayout = {
  id: string;
  fromTable: string;
  toTable: string;
  path: string;
};

export type RelationshipLayout = {
  width: number;
  height: number;
  nodes: RelationshipNodeLayout[];
  edges: RelationshipEdgeLayout[];
};

export const RELATIONSHIP_LAYOUT = {
  padding: 48,
  nodeWidth: 260,
  headerHeight: 42,
  rowHeight: 26,
  layerGap: 140,
  nodeGap: 44,
  isolatedGap: 72,
  isolatedColumns: 3,
} as const;

const MIN_SCALE = 0.3;
const MAX_SCALE = 2;
const PARALLEL_EDGE_GAP = 12;

const compareNames = (left: string, right: string): number => (
  left.localeCompare(right, 'en', { sensitivity: 'base' })
  || left.localeCompare(right, 'en')
);

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function tableHeight(table: RelationshipTable): number {
  return RELATIONSHIP_LAYOUT.headerHeight
    + Math.max(1, table.columns.length) * RELATIONSHIP_LAYOUT.rowHeight;
}

function findStronglyConnectedComponents(
  names: string[],
  adjacency: Map<string, string[]>,
): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (name: string): void => {
    indices.set(name, nextIndex);
    lowLinks.set(name, nextIndex);
    nextIndex += 1;
    stack.push(name);
    onStack.add(name);

    for (const child of adjacency.get(name) ?? []) {
      if (!indices.has(child)) {
        visit(child);
        lowLinks.set(name, Math.min(lowLinks.get(name)!, lowLinks.get(child)!));
      } else if (onStack.has(child)) {
        lowLinks.set(name, Math.min(lowLinks.get(name)!, indices.get(child)!));
      }
    }

    if (lowLinks.get(name) !== indices.get(name)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== name);
    component.sort(compareNames);
    components.push(component);
  };

  for (const name of names) {
    if (!indices.has(name)) visit(name);
  }
  return components.sort((left, right) => compareNames(left[0], right[0]));
}

function rankComponents(
  components: string[][],
  adjacency: Map<string, string[]>,
): Map<number, number> {
  const componentByName = new Map<string, number>();
  components.forEach((component, index) => {
    for (const name of component) componentByName.set(name, index);
  });

  const outgoing = components.map(() => new Set<number>());
  const incomingCount = components.map(() => 0);
  for (const [parent, children] of adjacency) {
    const parentComponent = componentByName.get(parent)!;
    for (const child of children) {
      const childComponent = componentByName.get(child)!;
      if (parentComponent === childComponent || outgoing[parentComponent].has(childComponent)) continue;
      outgoing[parentComponent].add(childComponent);
      incomingCount[childComponent] += 1;
    }
  }

  const componentKey = (index: number): string => components[index][0];
  const ready = components
    .map((_, index) => index)
    .filter((index) => incomingCount[index] === 0)
    .sort((left, right) => compareNames(componentKey(left), componentKey(right)));
  const ranks = new Map<number, number>();
  for (const index of ready) ranks.set(index, 0);

  while (ready.length > 0) {
    const component = ready.shift()!;
    const children = [...outgoing[component]].sort((left, right) => (
      compareNames(componentKey(left), componentKey(right))
    ));
    for (const child of children) {
      ranks.set(child, Math.max(ranks.get(child) ?? 0, (ranks.get(component) ?? 0) + 1));
      incomingCount[child] -= 1;
      if (incomingCount[child] === 0) {
        ready.push(child);
        ready.sort((left, right) => compareNames(componentKey(left), componentKey(right)));
      }
    }
  }
  return ranks;
}

function routeRelationships(
  relationships: Relationship[],
  nodes: RelationshipNodeLayout[],
): RelationshipEdgeLayout[] {
  const nodeByName = new Map(nodes.map((node) => [node.name, node]));
  const sorted = relationships
    .filter((relationship) => (
      nodeByName.has(relationship.fromTable) && nodeByName.has(relationship.toTable)
    ))
    .slice()
    .sort((left, right) => compareNames(left.id, right.id));
  const groups = new Map<string, Relationship[]>();
  for (const relationship of sorted) {
    const key = `${relationship.fromTable}\u0000${relationship.toTable}`;
    const group = groups.get(key) ?? [];
    group.push(relationship);
    groups.set(key, group);
  }

  return sorted.map((relationship) => {
    const from = nodeByName.get(relationship.fromTable)!;
    const to = nodeByName.get(relationship.toTable)!;
    const group = groups.get(`${relationship.fromTable}\u0000${relationship.toTable}`)!;
    const parallelOffset = (group.indexOf(relationship) - (group.length - 1) / 2) * PARALLEL_EDGE_GAP;
    const fromY = from.y + from.height / 2;
    const toY = to.y + to.height / 2;
    let path: string;

    if (from.name === to.name) {
      const right = from.x + from.width;
      const loopWidth = RELATIONSHIP_LAYOUT.padding - 12 + parallelOffset;
      path = `M ${right} ${fromY} C ${right + loopWidth} ${fromY - 36} ${right + loopWidth} ${fromY + 36} ${right} ${fromY}`;
    } else if (from.x === to.x) {
      const right = from.x + from.width;
      const midpoint = right + RELATIONSHIP_LAYOUT.layerGap / 2 + parallelOffset;
      path = `M ${right} ${fromY} H ${midpoint} V ${toY} H ${right}`;
    } else {
      const targetIsRight = to.x > from.x;
      const fromX = targetIsRight ? from.x + from.width : from.x;
      const toX = targetIsRight ? to.x : to.x + to.width;
      const midpoint = (fromX + toX) / 2 + parallelOffset;
      path = `M ${fromX} ${fromY} H ${midpoint} V ${toY} H ${toX}`;
    }

    return {
      id: relationship.id,
      fromTable: relationship.fromTable,
      toTable: relationship.toTable,
      path,
    };
  });
}

export function layoutRelationshipGraph(graph: RelationshipGraph): RelationshipLayout {
  const tables = graph.tables.slice().sort((left, right) => compareNames(left.name, right.name));
  const tableByName = new Map(tables.map((table) => [table.name, table]));
  const relatedNames = new Set<string>();
  const adjacency = new Map<string, string[]>();

  for (const relationship of graph.relationships) {
    if (!tableByName.has(relationship.fromTable) || !tableByName.has(relationship.toTable)) continue;
    relatedNames.add(relationship.fromTable);
    relatedNames.add(relationship.toTable);
    const children = adjacency.get(relationship.toTable) ?? [];
    if (!children.includes(relationship.fromTable)) children.push(relationship.fromTable);
    adjacency.set(relationship.toTable, children);
  }
  for (const name of relatedNames) {
    const children = adjacency.get(name) ?? [];
    children.sort(compareNames);
    adjacency.set(name, children);
  }

  const sortedRelatedNames = [...relatedNames].sort(compareNames);
  const components = findStronglyConnectedComponents(sortedRelatedNames, adjacency);
  const componentRanks = rankComponents(components, adjacency);
  const rankByName = new Map<string, number>();
  components.forEach((component, index) => {
    for (const name of component) rankByName.set(name, componentRanks.get(index) ?? 0);
  });

  const layers = new Map<number, RelationshipTable[]>();
  for (const name of sortedRelatedNames) {
    const rank = rankByName.get(name)!;
    const layer = layers.get(rank) ?? [];
    layer.push(tableByName.get(name)!);
    layers.set(rank, layer);
  }

  const nodes: RelationshipNodeLayout[] = [];
  let relatedBottom = 0;
  for (const rank of [...layers.keys()].sort((left, right) => left - right)) {
    let y = RELATIONSHIP_LAYOUT.padding;
    for (const table of layers.get(rank)!.sort((left, right) => compareNames(left.name, right.name))) {
      const height = tableHeight(table);
      nodes.push({
        name: table.name,
        x: RELATIONSHIP_LAYOUT.padding + rank * (RELATIONSHIP_LAYOUT.nodeWidth + RELATIONSHIP_LAYOUT.layerGap),
        y,
        width: RELATIONSHIP_LAYOUT.nodeWidth,
        height,
      });
      relatedBottom = Math.max(relatedBottom, y + height);
      y += height + RELATIONSHIP_LAYOUT.nodeGap;
    }
  }

  const isolated = tables.filter((table) => !relatedNames.has(table.name));
  const isolatedStartY = relatedBottom > 0
    ? relatedBottom + RELATIONSHIP_LAYOUT.isolatedGap
    : RELATIONSHIP_LAYOUT.padding;
  const isolatedRowHeights: number[] = [];
  for (let index = 0; index < isolated.length; index += RELATIONSHIP_LAYOUT.isolatedColumns) {
    isolatedRowHeights.push(Math.max(
      ...isolated.slice(index, index + RELATIONSHIP_LAYOUT.isolatedColumns).map(tableHeight),
    ));
  }
  const isolatedRowOffsets: number[] = [];
  for (let row = 0, y = isolatedStartY; row < isolatedRowHeights.length; row += 1) {
    isolatedRowOffsets.push(y);
    y += isolatedRowHeights[row] + RELATIONSHIP_LAYOUT.nodeGap;
  }
  isolated.forEach((table, index) => {
    const row = Math.floor(index / RELATIONSHIP_LAYOUT.isolatedColumns);
    const column = index % RELATIONSHIP_LAYOUT.isolatedColumns;
    nodes.push({
      name: table.name,
      x: RELATIONSHIP_LAYOUT.padding
        + column * (RELATIONSHIP_LAYOUT.nodeWidth + RELATIONSHIP_LAYOUT.layerGap),
      y: isolatedRowOffsets[row],
      width: RELATIONSHIP_LAYOUT.nodeWidth,
      height: tableHeight(table),
    });
  });

  nodes.sort((left, right) => compareNames(left.name, right.name));
  const right = nodes.reduce((maximum, node) => Math.max(maximum, node.x + node.width), 0);
  const bottom = nodes.reduce((maximum, node) => Math.max(maximum, node.y + node.height), 0);
  return {
    width: Math.max(RELATIONSHIP_LAYOUT.padding * 2, right + RELATIONSHIP_LAYOUT.padding),
    height: Math.max(RELATIONSHIP_LAYOUT.padding * 2, bottom + RELATIONSHIP_LAYOUT.padding),
    nodes,
    edges: routeRelationships(graph.relationships, nodes),
  };
}

export function fitRelationshipViewport(
  layout: RelationshipLayout,
  width: number,
  height: number,
): RelationshipViewport {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = clamp(
    Math.min(safeWidth / layout.width, safeHeight / layout.height, 1),
    MIN_SCALE,
    MAX_SCALE,
  );
  return {
    scale,
    x: (safeWidth - layout.width * scale) / 2,
    y: (safeHeight - layout.height * scale) / 2,
  };
}

export function zoomRelationshipViewport(
  viewport: RelationshipViewport,
  factor: number,
  anchor: { x: number; y: number },
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

export function matchesRelationshipSearch(name: string, query: string): boolean {
  return name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

export function relationshipSummary(relationship: Relationship): string {
  const mappings = relationship.columns
    .map((column) => (
      `${relationship.fromTable}.${column.from} → ${relationship.toTable}.${column.to ?? '?'}`
    ))
    .join('，');
  return `${mappings}；ON DELETE ${relationship.onDelete}；ON UPDATE ${relationship.onUpdate}`;
}
