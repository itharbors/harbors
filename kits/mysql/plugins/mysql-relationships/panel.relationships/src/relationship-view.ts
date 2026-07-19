export type RelationshipColumn = {
  name: string;
  type: string;
  primaryKeyOrder: number;
  foreignKey: boolean;
};

export type RelationshipTable = {
  name: string;
  kind: 'table';
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
    const frames: Array<{ name: string; nextChild: number; parent: string | null }> = [
      { name: start, nextChild: 0, parent: null },
    ];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const children = adjacency.get(frame.name) ?? [];
      if (frame.nextChild < children.length) {
        const child = children[frame.nextChild++];
        if (!indices.has(child)) {
          initialize(child);
          frames.push({ name: child, nextChild: 0, parent: frame.name });
        } else if (onStack.has(child)) {
          lowLinks.set(frame.name, Math.min(lowLinks.get(frame.name)!, indices.get(child)!));
        }
        continue;
      }

      frames.pop();
      if (frame.parent !== null) {
        lowLinks.set(
          frame.parent,
          Math.min(lowLinks.get(frame.parent)!, lowLinks.get(frame.name)!),
        );
      }
      if (lowLinks.get(frame.name) !== indices.get(frame.name)) continue;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.name);
      component.sort(compareNames);
      components.push(component);
    }
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
): { edges: RelationshipEdgeLayout[]; maxX: number; maxY: number } {
  const nodeByName = new Map(nodes.map((node) => [node.name, node]));
  const sorted = relationships
    .filter((relationship) => (
      nodeByName.has(relationship.fromTable) && nodeByName.has(relationship.toTable)
    ))
    .slice()
    .sort((left, right) => compareNames(left.id, right.id));
  const groups = new Map<string, Relationship[]>();
  for (const relationship of sorted) {
    const pair = [relationship.fromTable, relationship.toTable].sort(compareNames);
    const key = `${pair[0]}\u0000${pair[1]}`;
    const group = groups.get(key) ?? [];
    group.push(relationship);
    groups.set(key, group);
  }

  let maxX = 0;
  let maxY = 0;
  const edges = sorted.map((relationship) => {
    const from = nodeByName.get(relationship.fromTable)!;
    const to = nodeByName.get(relationship.toTable)!;
    const pair = [relationship.fromTable, relationship.toTable].sort(compareNames);
    const group = groups.get(`${pair[0]}\u0000${pair[1]}`)!;
    const parallelOffset = group.indexOf(relationship) * PARALLEL_EDGE_GAP;
    const fromY = from.y + from.height / 2;
    const toY = to.y + to.height / 2;
    let path: string;

    if (from.name === to.name) {
      const right = from.x + from.width;
      const loopWidth = RELATIONSHIP_LAYOUT.padding - 12 + parallelOffset;
      path = `M ${right} ${fromY} C ${right + loopWidth} ${fromY - 36} ${right + loopWidth} ${fromY + 36} ${right} ${fromY}`;
      maxX = Math.max(maxX, right + loopWidth);
      maxY = Math.max(maxY, fromY + 36);
    } else if (from.x === to.x) {
      const right = from.x + from.width;
      const midpoint = right + RELATIONSHIP_LAYOUT.layerGap / 2 + parallelOffset;
      path = `M ${right} ${fromY} H ${midpoint} V ${toY} H ${right}`;
      maxX = Math.max(maxX, midpoint);
      maxY = Math.max(maxY, fromY, toY);
    } else {
      const targetIsRight = to.x > from.x;
      const fromX = targetIsRight ? from.x + from.width : from.x;
      const toX = targetIsRight ? to.x : to.x + to.width;
      const midpoint = (fromX + toX) / 2 + parallelOffset;
      path = `M ${fromX} ${fromY} H ${midpoint} V ${toY} H ${toX}`;
      maxX = Math.max(maxX, fromX, midpoint, toX);
      maxY = Math.max(maxY, fromY, toY);
    }

    return {
      id: relationship.id,
      fromTable: relationship.fromTable,
      toTable: relationship.toTable,
      path,
    };
  });
  return { edges, maxX, maxY };
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
  const routed = routeRelationships(graph.relationships, nodes);
  return {
    width: Math.max(
      RELATIONSHIP_LAYOUT.padding * 2,
      right + RELATIONSHIP_LAYOUT.padding,
      routed.maxX + RELATIONSHIP_LAYOUT.padding,
    ),
    height: Math.max(
      RELATIONSHIP_LAYOUT.padding * 2,
      bottom + RELATIONSHIP_LAYOUT.padding,
      routed.maxY + RELATIONSHIP_LAYOUT.padding,
    ),
    nodes,
    edges: routed.edges,
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

export type RenderRelationshipViewOptions = {
  graph: RelationshipGraph;
  viewport: RelationshipViewport;
  query: string;
  onViewportChange(viewport: RelationshipViewport): void;
  onOpenTable(name: string): void;
};

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function relationshipTransform(viewport: RelationshipViewport): string {
  return `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`;
}

function renderRelationshipColumn(column: RelationshipColumn): HTMLElement {
  const row = document.createElement('div');
  row.className = 'relationship-column';

  const name = document.createElement('span');
  name.className = 'relationship-column-name';
  name.textContent = column.name;
  row.append(name);

  const type = document.createElement('span');
  type.className = 'relationship-column-type';
  type.textContent = column.type || '—';
  row.append(type);

  const keys = document.createElement('span');
  keys.className = 'relationship-column-keys';
  if (column.primaryKeyOrder > 0) {
    const primaryKey = document.createElement('span');
    primaryKey.className = 'relationship-key';
    primaryKey.dataset.key = 'pk';
    primaryKey.textContent = 'PK';
    keys.append(primaryKey);
  }
  if (column.foreignKey) {
    const foreignKey = document.createElement('span');
    foreignKey.className = 'relationship-key';
    foreignKey.dataset.key = 'fk';
    foreignKey.textContent = 'FK';
    keys.append(foreignKey);
  }
  row.append(keys);
  return row;
}

export function renderRelationshipView(options: RenderRelationshipViewOptions): HTMLElement {
  const layout = layoutRelationshipGraph(options.graph);
  const query = options.query.trim();
  const relationshipById = new Map(
    options.graph.relationships.map((relationship) => [relationship.id, relationship]),
  );
  const tableByName = new Map(options.graph.tables.map((table) => [table.name, table]));

  const view = document.createElement('section');
  view.id = 'mysql-view-relationships';
  view.className = 'relationship-view';
  view.setAttribute('role', 'tabpanel');
  view.setAttribute('aria-labelledby', 'mysql-tab-relationships');
  view.dataset.view = 'relationships';

  const toolbar = document.createElement('div');
  toolbar.className = 'relationship-toolbar';
  const toolbarLabel = document.createElement('strong');
  toolbarLabel.textContent = '关系画布';
  const toolbarCount = document.createElement('span');
  toolbarCount.textContent = `${options.graph.tables.length} 张表 · ${layout.edges.length} 条关系`;
  const toolbarHelp = document.createElement('small');
  toolbarHelp.textContent = '拖动画布平移 · 滚轮缩放 · 回车打开表结构';
  toolbar.append(toolbarLabel, toolbarCount, toolbarHelp);
  view.append(toolbar);

  const canvas = document.createElement('div');
  canvas.className = 'relationship-canvas';
  canvas.setAttribute('aria-label', 'MySQL 表关系画布');

  const stage = document.createElement('div');
  stage.className = 'relationship-stage';
  stage.style.width = `${layout.width}px`;
  stage.style.height = `${layout.height}px`;
  let currentViewport = { ...options.viewport };
  stage.style.transform = relationshipTransform(currentViewport);

  const edges = document.createElementNS(SVG_NAMESPACE, 'svg');
  edges.classList.add('relationship-edges');
  edges.setAttribute('width', String(layout.width));
  edges.setAttribute('height', String(layout.height));
  edges.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  edges.setAttribute('aria-hidden', 'true');
  const definitions = document.createElementNS(SVG_NAMESPACE, 'defs');
  const marker = document.createElementNS(SVG_NAMESPACE, 'marker');
  marker.id = 'relationship-arrow';
  marker.setAttribute('viewBox', '0 0 8 8');
  marker.setAttribute('refX', '7');
  marker.setAttribute('refY', '4');
  marker.setAttribute('markerWidth', '7');
  marker.setAttribute('markerHeight', '7');
  marker.setAttribute('orient', 'auto-start-reverse');
  const arrow = document.createElementNS(SVG_NAMESPACE, 'path');
  arrow.setAttribute('d', 'M 0 0 L 8 4 L 0 8 Z');
  marker.append(arrow);
  definitions.append(marker);
  edges.append(definitions);
  for (const edge of layout.edges) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', edge.path);
    path.setAttribute('marker-end', 'url(#relationship-arrow)');
    path.dataset.relationshipEdge = edge.id;
    path.dataset.dimmed = String(
      query.length > 0
      && !matchesRelationshipSearch(edge.fromTable, query)
      && !matchesRelationshipSearch(edge.toTable, query),
    );
    const title = document.createElementNS(SVG_NAMESPACE, 'title');
    title.textContent = relationshipSummary(relationshipById.get(edge.id)!);
    path.append(title);
    edges.append(path);
  }
  stage.append(edges);

  for (const node of layout.nodes) {
    const table = tableByName.get(node.name)!;
    const card = document.createElement('article');
    card.className = 'relationship-table';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.dataset.relationshipTable = table.name;
    if (query && !matchesRelationshipSearch(table.name, query)) {
      card.dataset.dimmed = 'true';
    }
    card.style.left = `${node.x}px`;
    card.style.top = `${node.y}px`;
    card.style.width = `${node.width}px`;
    card.style.height = `${node.height}px`;

    const heading = document.createElement('header');
    heading.className = 'relationship-table-heading';
    const tableName = document.createElement('strong');
    tableName.textContent = table.name;
    const tableKind = document.createElement('span');
    tableKind.textContent = 'TABLE';
    heading.append(tableName, tableKind);
    card.append(heading);

    if (table.columns.length === 0) {
      const emptyColumn = document.createElement('div');
      emptyColumn.className = 'relationship-column relationship-column-empty';
      emptyColumn.textContent = '无字段';
      card.append(emptyColumn);
    } else {
      for (const column of table.columns) card.append(renderRelationshipColumn(column));
    }

    const openTable = (): void => options.onOpenTable(table.name);
    card.addEventListener('click', openTable);
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openTable();
    });
    card.addEventListener('pointerdown', (event) => event.stopPropagation());
    stage.append(card);
  }

  if (options.graph.tables.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'relationship-empty';
    empty.textContent = '当前数据库中没有可绘制的表';
    stage.append(empty);
  }
  canvas.append(stage);
  view.append(canvas);

  if (layout.edges.length > 0) {
    const details = document.createElement('aside');
    details.className = 'relationship-details';
    details.setAttribute('aria-label', '关系映射明细');
    const heading = document.createElement('strong');
    heading.textContent = `关系明细 (${layout.edges.length})`;
    const list = document.createElement('ul');
    list.dataset.relationshipSummary = '';
    for (const edge of layout.edges) {
      const relationship = relationshipById.get(edge.id)!;
      const item = document.createElement('li');
      item.dataset.relationshipDetail = edge.id;
      item.dataset.dimmed = String(
        query.length > 0
        && !matchesRelationshipSearch(edge.fromTable, query)
        && !matchesRelationshipSearch(edge.toTable, query),
      );
      item.textContent = relationshipSummary(relationship);
      list.append(item);
    }
    details.append(heading, list);
    view.append(details);
  }

  const updateViewport = (viewport: RelationshipViewport): void => {
    currentViewport = viewport;
    stage.style.transform = relationshipTransform(currentViewport);
    options.onViewportChange({ ...currentViewport });
  };

  let pointerId: number | null = null;
  let previousPointer = { x: 0, y: 0 };
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    previousPointer = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    const next = panRelationshipViewport(
      currentViewport,
      event.clientX - previousPointer.x,
      event.clientY - previousPointer.y,
    );
    previousPointer = { x: event.clientX, y: event.clientY };
    updateViewport(next);
  });
  const finishPointer = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener('pointerup', finishPointer);
  canvas.addEventListener('pointercancel', finishPointer);
  canvas.addEventListener('lostpointercapture', (event) => {
    if (event.pointerId === pointerId) pointerId = null;
  });
  canvas.addEventListener('wheel', (event) => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    updateViewport(zoomRelationshipViewport(currentViewport, factor, {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    }));
  }, { passive: false });

  return view;
}
