# SQLite Relationship Diagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a database-level interactive relationship diagram that shows every user table, its visible columns, and every declared SQLite foreign-key relationship.

**Architecture:** Add one synchronous `getRelationshipGraph()` service request that returns a JSON-safe database snapshot, then render it in a new global workbench tab. Keep deterministic graph layout, viewport math, and DOM rendering in a focused `relationship-view.ts` module; keep `index.ts` responsible only for request lifecycle, state, tab integration, and navigation to the existing schema view.

**Tech Stack:** TypeScript, `better-sqlite3`, native DOM/SVG/CSS, Vitest, jsdom, existing CE Editor plugin request runtime. No new runtime dependency or bundler.

## Global Constraints

- Show ordinary tables and user-created virtual tables, including isolated tables; exclude views and SQLite shadow tables.
- Derive relationships only from `PRAGMA foreign_key_list`; never infer them from column names.
- Preserve composite, self-referential, cyclic, and parallel foreign keys.
- Show every non-hidden column with its declared type and PK/FK markers.
- Keep a single complete in-memory graph snapshot; do not paginate or collapse tables.
- Keep zoom between 30% and 200%; search highlights matches without changing layout.
- Do not add Mermaid, a graph package, a bundler, shared server routes, or database mutations.
- Maintain existing Chinese product copy, dark theme, keyboard navigation, and stale-response protections.

---

## File Structure

- `kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts`: define relationship snapshot types and build the graph from existing schema metadata.
- `kits/sqlite/plugins/sqlite-workbench/main/src/index.ts`: expose the new service method through the plugin bridge.
- `kits/sqlite/plugins/sqlite-workbench/package.json`: allow the `getRelationshipGraph` request.
- `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/relationship-view.ts`: own graph types, deterministic layout, viewport math, accessible DOM/SVG rendering, and pointer/wheel interaction.
- `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts`: add relationship state, request lifecycle, tab behavior, and table-to-schema navigation.
- `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/copy.ts`: add relationship tab, controls, status, and empty-state copy.
- `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.css`: style the toolbar, canvas, table cards, relationship paths, focus, search dimming, and responsive behavior.
- `kits/sqlite/plugins/sqlite-workbench/tests/sqlite-service.test.ts`: verify real SQLite graph extraction.
- `kits/sqlite/plugins/sqlite-workbench/tests/plugin-main.test.ts`: verify the new method is exposed.
- `kits/sqlite/plugins/sqlite-workbench/tests/relationship-view.test.ts`: verify deterministic layout, paths, viewport constraints, search, and summaries.
- `kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts`: verify the complete tab/request/render/navigation interaction.
- `kits/sqlite/plugins/sqlite-workbench/tests/accessibility.test.ts`: verify tab semantics, focusable nodes, readable relationship summaries, and minimum control labels.
- `kits/sqlite/tests/runtime-integration.test.ts`: verify the request is reachable in an assembled SQLite Kit session.
- `kits/sqlite/README.md`: document the relationship diagram workflow.

### Task 1: Relationship graph service contract

**Files:**
- Modify: `kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/main/src/index.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/package.json`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/sqlite-service.test.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/plugin-main.test.ts`

**Interfaces:**
- Consumes: existing `getSchema()`, `getObjectSchema({ name })`, `ColumnSchema`, and `ForeignKeySchema`.
- Produces: `RelationshipGraph`, `RelationshipTable`, `Relationship`, and `SqliteService.getRelationshipGraph(): RelationshipGraph`; plugin request name `getRelationshipGraph`.

- [ ] **Step 1: Write the failing real-database graph test**

Add a test that extends the fixture with composite, self, cycle, isolated, view, and special-name cases, then asserts the exact public snapshot:

```ts
it('builds a complete user-table relationship graph', () => {
  const fixture = new Database(dbPath);
  fixture.exec(`
    CREATE TABLE regions (country TEXT, code TEXT, PRIMARY KEY (country, code));
    CREATE TABLE offices (
      id INTEGER PRIMARY KEY,
      country TEXT,
      region_code TEXT,
      parent_id INTEGER REFERENCES offices(id),
      FOREIGN KEY (country, region_code) REFERENCES regions(country, code)
    );
    CREATE TABLE cycle_a (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES cycle_b(id));
    CREATE TABLE cycle_b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES cycle_a(id));
    CREATE TABLE isolated (id INTEGER PRIMARY KEY, note TEXT);
    CREATE TABLE "odd table" ("odd id" INTEGER PRIMARY KEY);
    CREATE VIEW office_names AS SELECT id FROM offices;
  `);
  fixture.close();
  service.openDatabase({ path: dbPath, create: false });

  const graph = service.getRelationshipGraph();

  expect(graph.tables.map((table) => table.name)).toEqual(expect.arrayContaining([
    'chunk_fts', 'cycle_a', 'cycle_b', 'isolated', 'memberships', 'odd table', 'offices', 'regions', 'users',
  ]));
  expect(graph.tables.map((table) => table.name)).not.toContain('active_users');
  expect(graph.tables.map((table) => table.name)).not.toContain('chunk_fts_data');
  expect(graph.tables.find((table) => table.name === 'offices')).toMatchObject({
    kind: 'table',
    columns: expect.arrayContaining([
      { name: 'id', type: 'INTEGER', primaryKeyOrder: 1, foreignKey: false },
      { name: 'parent_id', type: 'INTEGER', primaryKeyOrder: 0, foreignKey: true },
    ]),
  });
  expect(graph.relationships).toEqual(expect.arrayContaining([
    expect.objectContaining({
      fromTable: 'offices',
      toTable: 'regions',
      columns: [{ from: 'country', to: 'country' }, { from: 'region_code', to: 'code' }],
    }),
    expect.objectContaining({
      fromTable: 'offices',
      toTable: 'offices',
      columns: [{ from: 'parent_id', to: 'id' }],
    }),
  ]));
});
```

- [ ] **Step 2: Verify the graph test fails for the missing method**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/sqlite-service.test.ts`

Expected: FAIL with `service.getRelationshipGraph is not a function`.

- [ ] **Step 3: Define the service types and minimal graph builder**

Add these exact exported types beside the existing schema types:

```ts
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
```

Implement the method with stable table, foreign-key-id, and sequence ordering:

```ts
getRelationshipGraph(): RelationshipGraph {
  const objects = this.getSchema().objects.filter(
    (object): object is SchemaObject & { kind: 'table' | 'virtual' } => (
      object.kind === 'table' || object.kind === 'virtual'
    ),
  );
  const visibleNames = new Set(objects.map((object) => object.name));
  const schemas = objects.map((object) => this.getObjectSchema({ name: object.name }));
  const tables = schemas.map((schema) => {
    const foreignColumns = new Set(schema.foreignKeys.map((key) => key.from));
    return {
      name: schema.name,
      kind: schema.kind as 'table' | 'virtual',
      columns: schema.columns
        .filter((column) => !column.hidden)
        .map((column) => ({
          name: column.name,
          type: column.type,
          primaryKeyOrder: column.primaryKeyOrder,
          foreignKey: foreignColumns.has(column.name),
        })),
    };
  });
  const relationships = schemas.flatMap((schema) => {
    const groups = new Map<number, ForeignKeySchema[]>();
    for (const key of schema.foreignKeys) {
      const group = groups.get(key.id) ?? [];
      group.push(key);
      groups.set(key.id, group);
    }
    return [...groups.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([id, keys]) => {
        const ordered = [...keys].sort((left, right) => left.sequence - right.sequence);
        const first = ordered[0];
        if (!first || !visibleNames.has(first.table)) return [];
        return [{
          id: `${schema.name}:${id}`,
          fromTable: schema.name,
          toTable: first.table,
          columns: ordered.map((key) => ({ from: key.from, to: key.to })),
          onUpdate: first.onUpdate,
          onDelete: first.onDelete,
        }];
      });
  });
  return { tables, relationships };
}
```

- [ ] **Step 4: Run the service test and verify it passes**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/sqlite-service.test.ts`

Expected: PASS with the new graph test and all existing service tests green.

- [ ] **Step 5: Add failing bridge and manifest expectations**

Add `getRelationshipGraph` to the expected method list in `plugin-main.test.ts`, then assert it returns the fixture table:

```ts
expect(definition!.methods.getRelationshipGraph()).toMatchObject({
  tables: [expect.objectContaining({ name: 'items' })],
  relationships: [],
});
```

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/plugin-main.test.ts`

Expected: FAIL because the bridge does not expose `getRelationshipGraph`.

- [ ] **Step 6: Expose the request and re-run bridge tests**

Add this plugin method:

```ts
getRelationshipGraph: () => callService('getRelationshipGraph'),
```

Add this manifest entry:

```json
"getRelationshipGraph": ["getRelationshipGraph"]
```

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/plugin-main.test.ts && node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-workbench`

Expected: test PASS and plugin build exits 0.

- [ ] **Step 7: Commit the service contract**

```bash
git add kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts \
  kits/sqlite/plugins/sqlite-workbench/main/src/index.ts \
  kits/sqlite/plugins/sqlite-workbench/package.json \
  kits/sqlite/plugins/sqlite-workbench/tests/sqlite-service.test.ts \
  kits/sqlite/plugins/sqlite-workbench/tests/plugin-main.test.ts
git commit -m "[Feature] 提供 SQLite 表关系快照"
```

### Task 2: Deterministic layout and viewport model

**Files:**
- Create: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/relationship-view.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/relationship-view.test.ts`

**Interfaces:**
- Consumes: the JSON shape produced by `getRelationshipGraph()`; duplicated browser-side types avoid importing Node service code into the Panel.
- Produces: `layoutRelationshipGraph(graph)`, `fitRelationshipViewport(layout, width, height)`, `zoomRelationshipViewport(viewport, factor, anchor)`, `panRelationshipViewport(viewport, dx, dy)`, `matchesRelationshipSearch(name, query)`, and `relationshipSummary(relationship)`.

- [ ] **Step 1: Write failing pure-function tests**

Create `relationship-view.test.ts` with a graph containing a parent, child, self-reference, two-node cycle, parallel edges, and isolated table. Assert deterministic non-overlapping placement and viewport behavior:

```ts
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
    { name: 'parents', kind: 'table', columns: [{ name: 'id', type: 'INTEGER', primaryKeyOrder: 1, foreignKey: false }] },
    { name: 'children', kind: 'table', columns: [{ name: 'parent_id', type: 'INTEGER', primaryKeyOrder: 0, foreignKey: true }] },
    { name: 'isolated', kind: 'table', columns: [] },
  ],
  relationships: [{
    id: 'children:0', fromTable: 'children', toTable: 'parents',
    columns: [{ from: 'parent_id', to: 'id' }], onUpdate: 'NO ACTION', onDelete: 'CASCADE',
  }],
};

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
      expect(left.x + left.width <= right.x || right.x + right.width <= left.x
        || left.y + left.height <= right.y || right.y + right.height <= left.y).toBe(true);
    }
  }
});

it('constrains fit, zoom, pan, search, and readable summaries', () => {
  const layout = layoutRelationshipGraph(graph);
  expect(fitRelationshipViewport(layout, 800, 500).scale).toBeGreaterThanOrEqual(0.3);
  expect(zoomRelationshipViewport({ x: 0, y: 0, scale: 1 }, 99, { x: 100, y: 100 }).scale).toBe(2);
  expect(zoomRelationshipViewport({ x: 0, y: 0, scale: 1 }, 0.001, { x: 100, y: 100 }).scale).toBe(0.3);
  expect(panRelationshipViewport({ x: 1, y: 2, scale: 1 }, 5, -3)).toEqual({ x: 6, y: -1, scale: 1 });
  expect(matchesRelationshipSearch('UserAccounts', 'account')).toBe(true);
  expect(relationshipSummary(graph.relationships[0])).toContain('children.parent_id → parents.id');
});
```

- [ ] **Step 2: Verify the pure-function tests fail for the missing module**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/relationship-view.test.ts`

Expected: FAIL because `relationship-view.ts` does not exist.

- [ ] **Step 3: Implement graph types, layout constants, Tarjan SCC ranking, and path routing**

Export these exact public structures:

```ts
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
  name: string; x: number; y: number; width: number; height: number;
};
export type RelationshipEdgeLayout = {
  id: string; fromTable: string; toTable: string; path: string;
};
export type RelationshipLayout = {
  width: number; height: number;
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
```

Implement Tarjan strongly connected components over parent-to-child adjacency, collapse components into a DAG, assign each component the longest-path rank, and sort ties with `localeCompare('en', { sensitivity: 'base' })`. Compute node height as `headerHeight + Math.max(1, visibleColumnCount) * rowHeight`; place related nodes by rank and isolated nodes in a three-column grid below the related graph. Route normal edges with `M ... H ... V ... H ...`, self edges with a right-side `C` loop, and offset parallel-edge midpoints by 12px in stable relationship-id order.

Implement the pure viewport helpers exactly around the graph bounds:

```ts
const MIN_SCALE = 0.3;
const MAX_SCALE = 2;

export function fitRelationshipViewport(layout: RelationshipLayout, width: number, height: number): RelationshipViewport {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = clamp(Math.min(safeWidth / layout.width, safeHeight / layout.height, 1), MIN_SCALE, MAX_SCALE);
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
```

`panRelationshipViewport` adds deltas without changing scale. `matchesRelationshipSearch` trims and lowercases with `toLocaleLowerCase()`. `relationshipSummary` joins composite mappings with `，` and appends `ON DELETE` / `ON UPDATE` only to the accessible description.

- [ ] **Step 4: Run layout tests and fix only implementation defects**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/relationship-view.test.ts`

Expected: PASS, including deterministic equality and non-overlap assertions.

- [ ] **Step 5: Add cycle, self-loop, and parallel-edge regression tests**

Add a second fixture and assertions:

```ts
expect(layout.edges.find((edge) => edge.id === 'employees:0')!.path).toContain('C');
expect(new Set(layout.edges.filter((edge) => edge.fromTable === 'links' && edge.toTable === 'targets')
  .map((edge) => edge.path)).size).toBe(2);
expect(layout.nodes.filter((node) => ['cycle_a', 'cycle_b'].includes(node.name))).toHaveLength(2);
```

Run the same test command and expect PASS.

- [ ] **Step 6: Commit deterministic graph primitives**

```bash
git add kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/relationship-view.ts \
  kits/sqlite/plugins/sqlite-workbench/tests/relationship-view.test.ts
git commit -m "[Feature] 实现 SQLite 关系图布局"
```

### Task 3: Accessible relationship canvas renderer

**Files:**
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/relationship-view.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/relationship-view.test.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.css`

**Interfaces:**
- Consumes: `RelationshipGraph`, `RelationshipLayout`, `RelationshipViewport`, and pure helpers from Task 2.
- Produces: `renderRelationshipView(options): HTMLElement`, with callbacks for viewport changes and opening an existing schema view.

- [ ] **Step 1: Add failing jsdom renderer tests**

Mark `relationship-view.test.ts` with `// @vitest-environment jsdom` and add:

```ts
it('renders accessible table nodes, SVG edges, search emphasis, and summaries', () => {
  const onOpenTable = vi.fn();
  const view = renderRelationshipView({
    graph,
    viewport: { x: 0, y: 0, scale: 1 },
    query: 'child',
    onViewportChange: vi.fn(),
    onOpenTable,
  });
  document.body.append(view);
  expect(view.querySelectorAll('[data-relationship-table]')).toHaveLength(3);
  expect(view.querySelector('[data-relationship-table="children"]')?.textContent).toContain('FK');
  expect(view.querySelector('[data-relationship-table="parents"]')?.getAttribute('data-dimmed')).toBe('true');
  expect(view.querySelectorAll('svg [data-relationship-edge]')).toHaveLength(1);
  expect(view.querySelector('[data-relationship-summary]')?.textContent).toContain('children.parent_id → parents.id');
  const child = view.querySelector<HTMLElement>('[data-relationship-table="children"]')!;
  child.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(onOpenTable).toHaveBeenCalledWith('children');
});
```

- [ ] **Step 2: Verify renderer tests fail because the export is missing**

Run the focused relationship-view test; expect FAIL for missing `renderRelationshipView`.

- [ ] **Step 3: Implement the DOM/SVG renderer and direct-transform interaction**

Use this public options shape:

```ts
export type RenderRelationshipViewOptions = {
  graph: RelationshipGraph;
  viewport: RelationshipViewport;
  query: string;
  onViewportChange(viewport: RelationshipViewport): void;
  onOpenTable(name: string): void;
};
```

The returned element must have `id="sqlite-view-relationships"`, `role="tabpanel"`, `aria-labelledby="sqlite-tab-relationships"`, `data-view="relationships"`, and contain:

1. `.relationship-canvas` with pointer capture and non-passive wheel handler;
2. `.relationship-stage` whose inline transform is `translate(xpx, ypx) scale(scale)`;
3. an `aria-hidden="true"` SVG with one `<path data-relationship-edge>` and `<title>` per relationship;
4. one absolute-positioned `<article role="button" tabindex="0" data-relationship-table>` per table;
5. a visually-hidden `<ul data-relationship-summary>` with one `relationshipSummary()` item per edge.

Render PK/FK markers as text badges, use `textContent` for every database identifier, and set `data-dimmed="true"` when a non-empty query does not match. Pointer movement must update only `.relationship-stage.style.transform` and call `onViewportChange`; it must not rebuild nodes. Wheel uses factor `1.1` or `1 / 1.1` around the canvas-relative pointer. `Enter` and `Space` both call `onOpenTable`.

- [ ] **Step 4: Add focused relationship CSS**

Add `.relationship-view`, `.relationship-toolbar`, `.relationship-canvas`, `.relationship-stage`, `.relationship-edges`, `.relationship-table`, `.relationship-column`, `.relationship-key`, `.relationship-empty`, and `.sr-only` rules. Use existing `--grid`, `--grid-strong`, `--teal`, `--ink`, and mono font variables; keep field text at least 12px and helper text at least 11px. Set transform origin to `0 0`, use `touch-action: none`, and add strong `:focus-visible` outlines. Under 720px, make the toolbar horizontally scrollable without wrapping controls. Under `prefers-reduced-motion`, disable transition effects.

- [ ] **Step 5: Run renderer tests and plugin build**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/relationship-view.test.ts && node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-workbench`

Expected: PASS and build exits 0.

- [ ] **Step 6: Commit the accessible canvas**

```bash
git add kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/relationship-view.ts \
  kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.css \
  kits/sqlite/plugins/sqlite-workbench/tests/relationship-view.test.ts
git commit -m "[Feature] 绘制可交互 SQLite 关系画布"
```

### Task 4: Workbench tab and request lifecycle

**Files:**
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/copy.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/accessibility.test.ts`

**Interfaces:**
- Consumes: `renderRelationshipView`, viewport helpers, and the `getRelationshipGraph` plugin request.
- Produces: global `relationships` tab, cached graph state, stale-response protection, toolbar controls, and table-to-schema navigation.

- [ ] **Step 1: Add failing Panel request/render/navigation tests**

Extend the mock with a graph and request case:

```ts
const relationshipGraph = {
  tables: [
    { name: 'users', kind: 'table', columns: [{ name: 'id', type: 'INTEGER', primaryKeyOrder: 1, foreignKey: false }] },
    { name: 'teams', kind: 'table', columns: [{ name: 'id', type: 'INTEGER', primaryKeyOrder: 1, foreignKey: false }] },
    { name: 'memberships', kind: 'table', columns: [
      { name: 'user_id', type: 'INTEGER', primaryKeyOrder: 1, foreignKey: true },
      { name: 'team_id', type: 'INTEGER', primaryKeyOrder: 2, foreignKey: true },
    ] },
  ],
  relationships: [{
    id: 'memberships:0', fromTable: 'memberships', toTable: 'users',
    columns: [{ from: 'user_id', to: 'id' }], onUpdate: 'NO ACTION', onDelete: 'CASCADE',
  }],
};
```

Add tests that open the database, click `[data-tab="relationships"]`, wait one microtask, and assert:

```ts
expect(request).toHaveBeenCalledWith(PLUGIN, 'getRelationshipGraph');
expect(root.querySelectorAll('[data-relationship-table]')).toHaveLength(3);
expect(root.querySelector('[data-view="relationships"]')?.textContent).toContain('memberships');
root.querySelector<HTMLElement>('[data-relationship-table="memberships"]')!.click();
await vi.waitFor(() => expect(root.querySelector('[data-view="schema"]')).not.toBeNull());
expect(request).toHaveBeenCalledWith(PLUGIN, 'getObjectSchema', { name: 'memberships' });
```

Also test that the relationship tab remains enabled when `getSchema()` returns `{ objects: [] }`, and that returning to the tab does not issue a second graph request until refresh.

- [ ] **Step 2: Verify Panel tests fail for the missing tab**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/panel.test.ts`

Expected: FAIL because `[data-tab="relationships"]` is absent.

- [ ] **Step 3: Extend workbench state and lifecycle**

Add imports from `relationship-view.js`, extend `activeTab` to `'data' | 'schema' | 'relationships' | 'sql'`, and add:

```ts
relationshipGraph: RelationshipGraph | null;
relationshipViewport: RelationshipViewport;
relationshipQuery: string;
relationshipNeedsFit: boolean;
```

Initialize them to `null`, `{ x: 0, y: 0, scale: 1 }`, `''`, and `true`. Clear graph/query and reset viewport on open, close, connection switch, and schema refresh. Use the existing `viewRequestSequence` and `connectionGeneration` guards when loading `getRelationshipGraph`.

Update `loadActiveView()` so `relationships` is handled before the `selectedName` guard:

```ts
if (state.activeTab === 'relationships') {
  if (state.relationshipGraph) return;
  const graph = await request<RelationshipGraph>('getRelationshipGraph');
  if (sequence !== viewRequestSequence || generation !== connectionGeneration
    || state.activeTab !== 'relationships' || !state.connection.connected) return;
  state.relationshipGraph = graph;
  state.relationshipNeedsFit = true;
  state.status = sqliteCopy.relationships.status(graph.tables.length, graph.relationships.length);
  return;
}
if (!state.selectedName) return;
```

- [ ] **Step 4: Integrate heading, tab semantics, controls, and node navigation**

Add the fourth button between structure and SQL:

```html
<button type="button" role="tab" data-tab="relationships">${sqliteCopy.tabs.relationships}</button>
```

Disable tabs with this predicate:

```ts
const globalTab = tab === 'sql' || tab === 'relationships';
button.disabled = !state.connection.connected || (!globalTab && !state.selectedName);
```

Render relationship view before the selected-object empty state. Wrap it with a toolbar containing search, `−`, `+`, and “适应窗口”. Use `fitRelationshipViewport` with canvas `clientWidth/clientHeight`, falling back to 960×640 in jsdom. The node callback must set the selected table, switch to `schema`, clear stale object state, render, and call `loadActiveView()`.

When `activeTab === 'relationships'`, render the title eyebrow as `数据库` and name as the connected file name. Add exact copy keys:

```ts
tabs: { relationships: '关系图' },
relationships: {
  search: '搜索表',
  zoomOut: '缩小关系图',
  zoomIn: '放大关系图',
  fit: '适应窗口',
  loading: '正在加载表关系…',
  empty: '此数据库还没有可展示的表。',
  noRelationships: '未检测到已声明的外键关系。',
  status: (tables: number, relationships: number) => `${tables} 个表 · ${relationships} 条关系`,
},
```

- [ ] **Step 5: Add stale-response, empty-state, and accessibility regressions**

Add tests that delay the graph response, close or switch the connection, resolve the old response, and verify no relationship nodes appear. Add empty database and no-relationship graph assertions. In `accessibility.test.ts`, assert the relationship tab participates in roving tabindex, all nodes have `role="button"` and `tabindex="0"`, toolbar icon controls have labels, SVG is hidden, and the relationship summary remains available to assistive technology.

- [ ] **Step 6: Run Panel and accessibility tests**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/panel.test.ts plugins/sqlite-workbench/tests/accessibility.test.ts`

Expected: PASS with all old and new panel behavior green.

- [ ] **Step 7: Commit the workbench integration**

```bash
git add kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts \
  kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/copy.ts \
  kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts \
  kits/sqlite/plugins/sqlite-workbench/tests/accessibility.test.ts
git commit -m "[Feature] 接入 SQLite 全库关系图"
```

### Task 5: Runtime evidence and documentation

**Files:**
- Modify: `kits/sqlite/tests/runtime-integration.test.ts`
- Modify: `kits/sqlite/README.md`

**Interfaces:**
- Consumes: assembled plugin request bridge and completed relationship tab.
- Produces: runtime-level proof and user-facing usage documentation.

- [ ] **Step 1: Add a failing assembled-session request assertion**

Extend the runtime fixture database with a parent and child table, then call the assembled `getRelationshipGraph` request through the same route helper used by existing connection/schema assertions. Assert:

```ts
expect(graph).toMatchObject({
  tables: expect.arrayContaining([
    expect.objectContaining({ name: 'parents' }),
    expect.objectContaining({ name: 'children' }),
  ]),
  relationships: [expect.objectContaining({
    fromTable: 'children',
    toTable: 'parents',
    columns: [{ from: 'parent_id', to: 'id' }],
  })],
});
```

- [ ] **Step 2: Run the runtime test and verify the new assertion fails before assembly rebuild**

Run: `npm test -w @itharbors/kit-sqlite -- --run tests/runtime-integration.test.ts`

Expected: FAIL if the request is not exposed or built; after Task 1 build artifacts are current, it may already PASS, which is acceptable because the test covers assembled behavior rather than a new production unit.

- [ ] **Step 3: Document the relationship workflow**

Add this section to `kits/sqlite/README.md`:

```md
## 全库关系图

- “关系图”页签展示普通表、虚拟表、字段、主键和 SQLite 已声明的外键；视图与 SQLite 影子表不会混入关系图。
- 没有外键的表仍会作为独立节点出现。关系来自数据库声明，不根据字段名称推断。
- 使用搜索高亮表，拖拽平移画布，滚轮或工具栏缩放，并可一键适应窗口。
- 点击或使用键盘激活表节点，会跳转到该表的“结构”页查看完整定义。
```

- [ ] **Step 4: Run SQLite Kit tests and plugin checks**

Run: `npm test -w @itharbors/kit-sqlite && node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-workbench && node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-workbench`

Expected: all SQLite tests PASS and both plugin commands exit 0.

- [ ] **Step 5: Commit runtime evidence and docs**

```bash
git add kits/sqlite/tests/runtime-integration.test.ts kits/sqlite/README.md
git commit -m "[Feature] 补充 SQLite 关系图验收说明"
```

### Task 6: Full verification and completion audit

**Files:**
- Verify only; modify a feature file only if a failing check proves a feature defect.

**Interfaces:**
- Consumes: all committed tasks and the design completion criteria.
- Produces: authoritative test/build/status evidence for every requested behavior.

- [ ] **Step 1: Run the repository gate**

Run: `npm run check`

Expected: client build/tests, server build/tests, SQLite/MySQL Kit tests, plugin builds/checks, workflow tests, and all TypeScript checks PASS.

- [ ] **Step 2: Audit each completion criterion against evidence**

Check all of the following without substituting narrower evidence:

```text
all user tables present -> real sqlite service + runtime tests
all declared foreign keys present -> composite/self/cycle/parallel service tests
isolated/empty/no-relation states -> service + panel tests
search/zoom/pan/fit -> pure helper + renderer + panel tests
keyboard and screen reader behavior -> renderer + accessibility tests
table node opens schema -> panel interaction test
plugin is buildable/reachable -> build, manifest bridge, runtime test
whole repository remains healthy -> npm run check
```

- [ ] **Step 3: Inspect final Git state**

Run: `git status --short && git log --oneline origin/main..HEAD`

Expected: clean worktree and focused `[Feature]` commits for design, service, layout, canvas, integration, and verification documentation.
