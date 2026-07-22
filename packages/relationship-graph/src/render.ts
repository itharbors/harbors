import {
  moveRelationshipNode,
  panRelationshipViewport,
  zoomRelationshipViewport,
} from './layout.js';
import type {
  NodePosition,
  Relationship,
  RelationshipGraph,
  RelationshipLayout,
  RelationshipTable,
  RelationshipViewport,
} from './types.js';

export type RenderRelationshipViewOptions = {
  graph: RelationshipGraph;
  layout: RelationshipLayout;
  viewport: RelationshipViewport;
  query: string;
  selectedTable: string | null;
  tableKindLabel(table: RelationshipTable): string;
  onNodeMove(name: string, position: NodePosition, phase: 'preview' | 'commit'): void;
  onViewportChange(viewport: RelationshipViewport): void;
  onSelectTable(name: string | null): void;
  onOpenTable(name: string): void;
};

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const DRAG_THRESHOLD_PX = 4;

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

export function renderRelationshipView(options: RenderRelationshipViewOptions): HTMLElement {
  const query = options.query.trim();
  const relationshipById = new Map(
    options.graph.relationships.map((relationship) => [relationship.id, relationship]),
  );
  const tableByName = new Map(options.graph.tables.map((table) => [table.name, table]));
  const selectedTable = options.selectedTable !== null && tableByName.has(options.selectedTable)
    ? options.selectedTable
    : null;
  const relatedTables = directNeighbors(options.graph, selectedTable);
  let workingLayout = cloneLayout(options.layout);
  let currentViewport = { ...options.viewport };

  const view = document.createElement('section');
  view.className = 'relationship-view';
  view.setAttribute('role', 'tabpanel');
  view.dataset.view = 'relationships';

  const toolbar = document.createElement('div');
  toolbar.className = 'relationship-toolbar';
  const toolbarLabel = document.createElement('strong');
  toolbarLabel.textContent = '关系画布';
  const toolbarCount = document.createElement('span');
  toolbarCount.textContent = `${options.graph.tables.length} 张表 · ${workingLayout.edges.length} 条关系`;
  const toolbarHelp = document.createElement('small');
  toolbarHelp.textContent = '单击选择 · 双击或回车打开 · 拖动调整布局 · 滚轮缩放';
  toolbar.append(toolbarLabel, toolbarCount, toolbarHelp);
  view.append(toolbar);

  const canvas = document.createElement('div');
  canvas.className = 'relationship-canvas';
  canvas.setAttribute('aria-label', '表关系画布');

  const stage = document.createElement('div');
  stage.className = 'relationship-stage';
  stage.style.width = `${workingLayout.width}px`;
  stage.style.height = `${workingLayout.height}px`;
  stage.style.transform = relationshipTransform(currentViewport);

  const edges = document.createElementNS(SVG_NAMESPACE, 'svg');
  edges.classList.add('relationship-edges');
  setSvgBounds(edges, workingLayout);
  edges.setAttribute('aria-hidden', 'true');
  edges.append(renderMarker());
  for (const edge of workingLayout.edges) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', edge.path);
    path.setAttribute('marker-end', 'url(#relationship-arrow)');
    path.dataset.relationshipEdge = edge.id;
    path.dataset.focus = relationshipFocus(edge, selectedTable);
    path.dataset.dimmed = String(
      query.length > 0
      && !matchesRelationshipSearch(edge.fromTable, query)
      && !matchesRelationshipSearch(edge.toTable, query)
    );
    const relationship = relationshipById.get(edge.id);
    if (relationship !== undefined) {
      const title = document.createElementNS(SVG_NAMESPACE, 'title');
      title.textContent = relationshipSummary(relationship);
      path.append(title);
    }
    edges.append(path);
  }
  stage.append(edges);

  for (const node of workingLayout.nodes) {
    const table = tableByName.get(node.name);
    if (table === undefined) continue;
    const card = renderTableCard(
      table,
      options.tableKindLabel(table),
      query,
      tableFocus(table.name, selectedTable, relatedTables),
    );
    applyNodeStyle(card, node);
    installTableInteraction(card, table.name, options, () => currentViewport, {
      get layout() { return workingLayout; },
      apply(nextLayout, position) {
        workingLayout = nextLayout;
        applyNodeStyle(card, nextLayout.nodes.find((candidate) => candidate.name === table.name)!);
        stage.style.width = `${nextLayout.width}px`;
        stage.style.height = `${nextLayout.height}px`;
        setSvgBounds(edges, nextLayout);
        for (const edge of nextLayout.edges) {
          if (edge.fromTable !== table.name && edge.toTable !== table.name) continue;
          edges.querySelector<SVGPathElement>(`[data-relationship-edge="${cssEscape(edge.id)}"]`)
            ?.setAttribute('d', edge.path);
        }
        options.onNodeMove(table.name, position, 'preview');
      },
    });
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

  if (workingLayout.edges.length > 0) {
    view.append(renderRelationshipDetails(
      workingLayout,
      relationshipById,
      query,
      selectedTable,
    ));
  }

  const updateViewport = (viewport: RelationshipViewport): void => {
    currentViewport = viewport;
    stage.style.transform = relationshipTransform(currentViewport);
    options.onViewportChange({ ...currentViewport });
  };
  installCanvasInteraction(
    canvas,
    () => currentViewport,
    updateViewport,
    () => options.onSelectTable(null),
  );
  return view;
}

function renderTableCard(
  table: RelationshipTable,
  kindLabel: string,
  query: string,
  focus: 'selected' | 'related' | 'muted' | 'idle',
): HTMLElement {
  const card = document.createElement('article');
  card.className = 'relationship-table';
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.dataset.relationshipTable = table.name;
  card.dataset.focus = focus;
  card.setAttribute('aria-pressed', String(focus === 'selected'));
  if (query && !matchesRelationshipSearch(table.name, query)) card.dataset.dimmed = 'true';

  const heading = document.createElement('header');
  heading.className = 'relationship-table-heading';
  const tableName = document.createElement('strong');
  tableName.textContent = table.name;
  const tableKind = document.createElement('span');
  tableKind.textContent = kindLabel;
  heading.append(tableName, tableKind);
  card.append(heading);

  if (table.columns.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'relationship-column relationship-column-empty';
    empty.textContent = '无字段';
    card.append(empty);
  } else {
    for (const column of table.columns) {
      const row = document.createElement('div');
      row.className = 'relationship-column';
      const name = document.createElement('span');
      name.className = 'relationship-column-name';
      name.textContent = column.name;
      const type = document.createElement('span');
      type.className = 'relationship-column-type';
      type.textContent = column.type || '—';
      const keys = document.createElement('span');
      keys.className = 'relationship-column-keys';
      if (column.primaryKeyOrder > 0) keys.append(renderKey('pk', 'PK'));
      if (column.foreignKey) keys.append(renderKey('fk', 'FK'));
      row.append(name, type, keys);
      card.append(row);
    }
  }
  return card;
}

function installTableInteraction(
  card: HTMLElement,
  tableName: string,
  options: RenderRelationshipViewOptions,
  viewport: () => RelationshipViewport,
  layoutState: {
    readonly layout: RelationshipLayout;
    apply(layout: RelationshipLayout, position: NodePosition): void;
  },
): void {
  let pointerId: number | null = null;
  let pointerStart = { x: 0, y: 0 };
  let nodeStart = { x: 0, y: 0 };
  let pendingPosition: NodePosition | null = null;
  let frame: number | null = null;
  let dragged = false;
  let suppressClick = false;

  card.addEventListener('click', (event) => {
    event.stopPropagation();
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      return;
    }
    options.onSelectTable(tableName);
  });
  card.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    options.onOpenTable(tableName);
  });
  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (event.key === 'Enter') options.onOpenTable(tableName);
    else options.onSelectTable(tableName);
  });
  card.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    if (event.button !== 0 || pointerId !== null) return;
    const node = layoutState.layout.nodes.find((candidate) => candidate.name === tableName);
    if (node === undefined) return;
    pointerId = event.pointerId;
    pointerStart = { x: event.clientX, y: event.clientY };
    nodeStart = { x: node.x, y: node.y };
    dragged = false;
    pendingPosition = null;
    card.setPointerCapture?.(event.pointerId);
  });

  const applyPending = (): void => {
    if (pendingPosition === null) return;
    const position = pendingPosition;
    pendingPosition = null;
    layoutState.apply(
      moveRelationshipNode(layoutState.layout, options.graph, tableName, position),
      position,
    );
  };
  const schedulePending = (): void => {
    if (frame !== null) return;
    const requested = requestAnimationFrame(() => {
      frame = null;
      applyPending();
    });
    if (pendingPosition !== null) frame = requested;
  };

  card.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - pointerStart.x;
    const dy = event.clientY - pointerStart.y;
    if (!dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    dragged = true;
    event.preventDefault();
    card.dataset.dragging = 'true';
    pendingPosition = {
      x: nodeStart.x + dx / viewport().scale,
      y: nodeStart.y + dy / viewport().scale,
    };
    schedulePending();
  });

  const finish = (event: PointerEvent): void => {
    event.stopPropagation();
    if (event.pointerId !== pointerId) return;
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    applyPending();
    if (dragged) {
      const node = layoutState.layout.nodes.find((candidate) => candidate.name === tableName)!;
      options.onNodeMove(tableName, { x: node.x, y: node.y }, 'commit');
      suppressClick = true;
    }
    delete card.dataset.dragging;
    pointerId = null;
    if (card.hasPointerCapture?.(event.pointerId)) card.releasePointerCapture?.(event.pointerId);
  };
  card.addEventListener('pointerup', finish);
  card.addEventListener('pointercancel', finish);
  card.addEventListener('lostpointercapture', (event) => {
    if (event.pointerId === pointerId) pointerId = null;
  });
}

function installCanvasInteraction(
  canvas: HTMLElement,
  viewport: () => RelationshipViewport,
  updateViewport: (viewport: RelationshipViewport) => void,
  clearSelection: () => void,
): void {
  let pointerId: number | null = null;
  let previous = { x: 0, y: 0 };
  let pointerStart = { x: 0, y: 0 };
  let moved = false;
  let suppressClick = false;
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    previous = { x: event.clientX, y: event.clientY };
    pointerStart = { ...previous };
    moved = false;
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    if (Math.hypot(
      event.clientX - pointerStart.x,
      event.clientY - pointerStart.y,
    ) >= DRAG_THRESHOLD_PX) moved = true;
    updateViewport(panRelationshipViewport(
      viewport(),
      event.clientX - previous.x,
      event.clientY - previous.y,
    ));
    previous = { x: event.clientX, y: event.clientY };
  });
  const finish = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    if (moved) suppressClick = true;
    pointerId = null;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture?.(event.pointerId);
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('lostpointercapture', (event) => {
    if (event.pointerId === pointerId) pointerId = null;
  });
  canvas.addEventListener('click', () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    clearSelection();
  });
  canvas.addEventListener('wheel', (event) => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    updateViewport(zoomRelationshipViewport(
      viewport(),
      event.deltaY < 0 ? 1.1 : 1 / 1.1,
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
    ));
  }, { passive: false });
}

function renderRelationshipDetails(
  layout: RelationshipLayout,
  relationships: Map<string, Relationship>,
  query: string,
  selectedTable: string | null,
): HTMLElement {
  const details = document.createElement('aside');
  details.className = 'relationship-details';
  details.setAttribute('role', 'region');
  details.setAttribute('aria-label', '关系映射明细');
  const heading = document.createElement('strong');
  heading.textContent = `关系明细 (${layout.edges.length})`;
  const list = document.createElement('ul');
  list.dataset.relationshipSummary = '';
  for (const edge of layout.edges) {
    const relationship = relationships.get(edge.id);
    if (relationship === undefined) continue;
    const item = document.createElement('li');
    item.dataset.relationshipDetail = edge.id;
    item.dataset.focus = relationshipFocus(edge, selectedTable);
    item.dataset.dimmed = String(
      query.length > 0
      && !matchesRelationshipSearch(edge.fromTable, query)
      && !matchesRelationshipSearch(edge.toTable, query)
    );
    item.textContent = relationshipSummary(relationship);
    list.append(item);
  }
  details.append(heading, list);
  return details;
}

function directNeighbors(graph: RelationshipGraph, selectedTable: string | null): Set<string> {
  const related = new Set<string>();
  if (selectedTable === null) return related;
  for (const relationship of graph.relationships) {
    if (relationship.fromTable === selectedTable) related.add(relationship.toTable);
    if (relationship.toTable === selectedTable) related.add(relationship.fromTable);
  }
  return related;
}

function tableFocus(
  name: string,
  selectedTable: string | null,
  relatedTables: Set<string>,
): 'selected' | 'related' | 'muted' | 'idle' {
  if (selectedTable === null) return 'idle';
  if (name === selectedTable) return 'selected';
  return relatedTables.has(name) ? 'related' : 'muted';
}

function relationshipFocus(
  edge: Pick<Relationship, 'fromTable' | 'toTable'>,
  selectedTable: string | null,
): 'related' | 'muted' | 'idle' {
  if (selectedTable === null) return 'idle';
  return edge.fromTable === selectedTable || edge.toTable === selectedTable ? 'related' : 'muted';
}

function renderMarker(): SVGDefsElement {
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
  return definitions;
}

function renderKey(kind: 'pk' | 'fk', label: string): HTMLElement {
  const key = document.createElement('span');
  key.className = 'relationship-key';
  key.dataset.key = kind;
  key.textContent = label;
  return key;
}

function applyNodeStyle(
  card: HTMLElement,
  node: { x: number; y: number; width: number; height: number },
): void {
  card.style.left = `${node.x}px`;
  card.style.top = `${node.y}px`;
  card.style.width = `${node.width}px`;
  card.style.height = `${node.height}px`;
}

function setSvgBounds(edges: SVGSVGElement, layout: RelationshipLayout): void {
  edges.setAttribute('width', String(layout.width));
  edges.setAttribute('height', String(layout.height));
  edges.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
}

function relationshipTransform(viewport: RelationshipViewport): string {
  return `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`;
}

function cloneLayout(layout: RelationshipLayout): RelationshipLayout {
  return {
    width: layout.width,
    height: layout.height,
    nodes: layout.nodes.map((node) => ({ ...node })),
    edges: layout.edges.map((edge) => ({ ...edge })),
  };
}

function cssEscape(value: string): string {
  return globalThis.CSS?.escape?.(value) ?? value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}
