# Database Relationship Graph Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed SQLite/MySQL relationship ordering with one shared, deterministic, viewport-aware graph layout whose draggable node positions and viewport are safely cached per database.

**Architecture:** Add a browser-safe `@itharbors/relationship-graph` workspace package containing generic graph types, identity-aware storage, name clustering, viewport-aware layout, state reconciliation, and DOM interaction. SQLite and MySQL keep database-specific loading, labels, themes, and table-opening callbacks while consuming the same shared implementation. SQLite core exposes a read-only file identity; MySQL derives its identity from normalized endpoint and selected database.

**Tech Stack:** TypeScript ES2022, Vitest/jsdom, Web Crypto, localStorage, Pointer Events, ResizeObserver, Harbors plugin request/broadcast runtime.

## Global Constraints

- Do not write layout metadata into SQLite or MySQL and do not require database write access.
- Do not add ELK, Dagre, a force-layout library, a language model, or a remote service.
- Never include MySQL passwords, tokens, or complete connection inputs in an identity, cache record, or log.
- The same graph, canvas size, and configuration must produce exactly the same layout; do not use randomness, time, or unstable object iteration.
- Name-neighbor generation must use a token index and a fixed per-node neighbor limit, never an unbounded all-pairs comparison.
- Cache errors are non-blocking; invalid, unavailable, or full storage falls back to an in-memory automatic layout.
- `storage` events do not live-update an already open graph; concurrent windows use last-completed-write-wins for the same identity.
- Search never changes layout; “适应窗口” changes only the viewport; “自动排列” replaces all node positions using the current canvas size.
- Schema changes retain valid surviving positions, discard removed tables, and place new tables near their name group without moving unrelated groups.
- Preserve existing relationship details, search, keyboard opening, ARIA, zoom, pan, cycles, self edges, parallel edges, and 5,000-table non-recursive behavior.
- Every commit on `optimize/database-relationship-graph-layout` uses `[Optimize] 摘要` with no trailing period.

---

### Task 1: Stable SQLite file identity in the public connection snapshot

**Files:**
- Modify: `packages/sqlite-contracts/src/contracts.ts`
- Modify: `kits/sqlite/plugins/sqlite-core/main/src/sqlite-service.ts`
- Modify: `kits/sqlite/plugins/sqlite-core/tests/sqlite-service.test.ts`
- Modify: `kits/sqlite/plugins/sqlite-core/tests/plugin-main.test.ts`

**Interfaces:**
- Produces: `ConnectionSnapshot.fileIdentity: string | null`.
- Produces: SQLite `ConnectionState.fileIdentity: string | null`, formatted like `dev:16777233:ino:923771` when `stat.ino > 0`, otherwise like `birth:1784710000123` when birth time is finite and positive, otherwise `null`.
- Consumes later: SQLite Relationships Panel combines `path` and `fileIdentity`; neither field is itself a cache key.

- [x] **Step 1: Write failing service and plugin snapshot tests**

Add exact assertions alongside the existing disconnected/open state expectations:

```ts
expect(service.getConnectionState()).toMatchObject({
  connected: false,
  path: null,
  fileIdentity: null,
});

const opened = service.openDatabase({ path: dbPath, create: false });
expect(opened.fileIdentity).toMatch(/^(dev:\d+:ino:\d+|birth:\d+(?:\.\d+)?)$/);
expect(service.getConnectionState().fileIdentity).toBe(opened.fileIdentity);
```

In `plugin-main.test.ts`, require `getConnectionState` and the connection-changed broadcast to contain the same non-null `fileIdentity` after open, then require `null` after close.

- [x] **Step 2: Run the focused tests and verify the contract is missing**

Run:

```bash
cd kits/sqlite
npx vitest run --config vitest.config.ts \
  plugins/sqlite-core/tests/sqlite-service.test.ts \
  plugins/sqlite-core/tests/plugin-main.test.ts
```

Expected: FAIL because `fileIdentity` is absent from the state and shared contract.

- [x] **Step 3: Add and populate the identity field**

Add the contract field:

```ts
export type ConnectionSnapshot = RevisionSnapshot & {
  connected: boolean;
  path: string | null;
  fileIdentity: string | null;
  fileName?: string | null;
  mode: 'readonly' | 'readwrite' | null;
  sqliteVersion: string | null;
  foreignKeys?: boolean | null;
  busyTimeout?: number | null;
};
```

Add a service field and pure formatter:

```ts
function formatFileIdentity(stat: fs.Stats): string | null {
  if (Number.isSafeInteger(stat.dev) && Number.isSafeInteger(stat.ino) && stat.ino > 0) {
    return `dev:${stat.dev}:ino:${stat.ino}`;
  }
  return Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
    ? `birth:${stat.birthtimeMs}`
    : null;
}
```

Set `this.fileIdentity = formatFileIdentity(fs.statSync(absolutePath))` only after the candidate connection and realpath validation succeed. Return it from `getConnectionState`, preserve it across mode changes, and clear it in `closeDatabase`. Do not use size or mtime because normal writes would change the cache identity.

- [x] **Step 4: Run focused tests and contracts build**

Run:

```bash
npm run build -w @itharbors/sqlite-contracts
cd kits/sqlite
npx vitest run --config vitest.config.ts \
  plugins/sqlite-core/tests/sqlite-service.test.ts \
  plugins/sqlite-core/tests/plugin-main.test.ts
```

Expected: contract build succeeds and both test files PASS.

- [x] **Step 5: Commit the focused change**

```bash
git add packages/sqlite-contracts/src/contracts.ts \
  kits/sqlite/plugins/sqlite-core/main/src/sqlite-service.ts \
  kits/sqlite/plugins/sqlite-core/tests/sqlite-service.test.ts \
  kits/sqlite/plugins/sqlite-core/tests/plugin-main.test.ts
git commit -m '[Optimize] 提供 SQLite 稳定文件身份'
```

### Task 2: Shared graph package, database identity, and collision-safe storage

**Files:**
- Create: `packages/relationship-graph/package.json`
- Create: `packages/relationship-graph/tsconfig.json`
- Create: `packages/relationship-graph/vitest.config.ts`
- Create: `packages/relationship-graph/src/types.ts`
- Create: `packages/relationship-graph/src/identity.ts`
- Create: `packages/relationship-graph/src/storage.ts`
- Create: `packages/relationship-graph/src/index.ts`
- Create: `packages/relationship-graph/tests/identity.test.ts`
- Create: `packages/relationship-graph/tests/storage.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `DatabaseLayoutIdentity`, `createDatabaseLayoutIdentity`, `RelationshipLayoutStore`, `createRelationshipLayoutStore`.
- Produces shared types: `RelationshipGraph`, `RelationshipTable`, `Relationship`, `RelationshipViewport`, `CanvasSize`, `NodePosition`, `RelationshipLayout`, and `PersistedRelationshipStateV1`.
- Storage dependency is injected as `Pick<Storage, 'getItem' | 'setItem'>`; tests do not patch global localStorage.

- [x] **Step 1: Scaffold package metadata and root build/test ordering**

Create `package.json`:

```json
{
  "name": "@itharbors/relationship-graph",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run --config vitest.config.ts"
  }
}
```

Use the same declaration/outDir/rootDir compiler options as `packages/mysql-contracts/tsconfig.json`. Set Vitest `environment: 'jsdom'` and include `tests/**/*.test.ts`. Insert `npm run build -w @itharbors/relationship-graph` after both contracts and before client/plugin builds; insert its test before Kit tests. Run `npm install` to update only the lockfile/workspace links.

- [x] **Step 2: Write failing identity and collision-bucket tests**

The tests must include these concrete cases:

```ts
const sqlite = createDatabaseLayoutIdentity('sqlite', ['/tmp/a.db', 'dev:1:ino:2']);
const otherSqlite = createDatabaseLayoutIdentity('sqlite', ['/tmp/b.db', 'dev:1:ino:3']);
expect(sqlite.canonical).toBe('sqlite|9:/tmp/a.db|11:dev:1:ino:2');
expect(otherSqlite.canonical).toBe('sqlite|9:/tmp/b.db|11:dev:1:ino:3');

const digest = vi.fn(async () => 'same-digest');
const store = createRelationshipLayoutStore(memoryStorage, { digest, now: () => 20 });
await store.save(sqlite, stateAt(10, 20));
await store.save(otherSqlite, stateAt(30, 40));
expect(await store.load(sqlite)).toEqual(stateAt(10, 20));
expect(await store.load(otherSqlite)).toEqual(stateAt(30, 40));
expect(JSON.parse(memoryStorage.value()).entries).toHaveLength(2);
```

Also cover engine-separated keys with the real digest, malformed JSON, wrong version, `NaN`/infinite/out-of-range coordinates, get/set throwing, an eight-entry bucket retaining the newest entries, and saving after another writer added a different identity to the same bucket.

- [x] **Step 3: Run the package tests and verify exports do not exist**

Run: `npm test -w @itharbors/relationship-graph`

Expected: FAIL because the package sources and exports do not exist.

- [x] **Step 4: Implement exact shared types and canonical identity**

Define the public foundations in `types.ts`:

```ts
export type RelationshipTable = {
  name: string;
  kind: string;
  columns: Array<{ name: string; type: string; primaryKeyOrder: number; foreignKey: boolean }>;
};
export type Relationship = {
  id: string;
  fromTable: string;
  toTable: string;
  columns: Array<{ from: string; to: string | null }>;
  onUpdate: string;
  onDelete: string;
};
export type RelationshipGraph = { tables: RelationshipTable[]; relationships: Relationship[] };
export type CanvasSize = { width: number; height: number };
export type RelationshipViewport = { x: number; y: number; scale: number };
export type NodePosition = { x: number; y: number };
export type RelationshipNodeLayout = NodePosition & {
  name: string; width: number; height: number; group: string;
};
export type RelationshipEdgeLayout = {
  id: string; fromTable: string; toTable: string; path: string;
};
export type RelationshipLayout = {
  width: number; height: number;
  nodes: RelationshipNodeLayout[];
  edges: RelationshipEdgeLayout[];
};
export type PersistedRelationshipStateV1 = {
  nodes: Record<string, NodePosition>;
  viewport: RelationshipViewport;
  canvas: CanvasSize;
};
```

In `identity.ts`, implement length-prefixed parts so embedded separators cannot alias:

```ts
export type DatabaseLayoutIdentity = {
  engine: 'sqlite' | 'mysql';
  canonical: string;
};

export function createDatabaseLayoutIdentity(
  engine: DatabaseLayoutIdentity['engine'],
  parts: readonly string[],
): DatabaseLayoutIdentity {
  return { engine, canonical: `${engine}${parts.map((part) => `|${part.length}:${part}`).join('')}` };
}
```

- [x] **Step 5: Implement defensive async storage**

Expose this interface:

```ts
export type RelationshipLayoutStore = {
  load(identity: DatabaseLayoutIdentity): Promise<PersistedRelationshipStateV1 | null>;
  save(identity: DatabaseLayoutIdentity, state: PersistedRelationshipStateV1): Promise<void>;
};

export function createRelationshipLayoutStore(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  options?: { digest?: (value: string) => Promise<string>; now?: () => number },
): RelationshipLayoutStore;
```

The default digest uses `crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))` and lowercase hex. If Web Crypto is absent or rejects, return a stable FNV-1a-derived hexadecimal fallback. Build keys as `itharbors:relationship-layout:v1:${identity.engine}:${digest}`. Each load/save validates `{ version: 1, entries: [...] }`, matches the full canonical identity, clones valid finite state, re-reads before save, and retains at most eight newest entries. Catch storage and digest failures; load returns `null`, save resolves without throwing.

- [x] **Step 6: Build and run the shared tests**

Run:

```bash
npm run build -w @itharbors/relationship-graph
npm test -w @itharbors/relationship-graph
```

Expected: build succeeds and identity/storage tests PASS.

- [x] **Step 7: Commit package foundations**

```bash
git add package.json package-lock.json packages/relationship-graph
git commit -m '[Optimize] 建立关系图身份与缓存基础'
```

### Task 3: Name-aware, viewport-aware deterministic graph layout

**Files:**
- Create: `packages/relationship-graph/src/names.ts`
- Create: `packages/relationship-graph/src/groups.ts`
- Create: `packages/relationship-graph/src/layout.ts`
- Create: `packages/relationship-graph/src/edges.ts`
- Modify: `packages/relationship-graph/src/index.ts`
- Create: `packages/relationship-graph/tests/names.test.ts`
- Create: `packages/relationship-graph/tests/layout.test.ts`

**Interfaces:**
- Produces: `tokenizeTableName(name: string): string[]`.
- Produces: `groupRelationshipGraph(graph: RelationshipGraph): Map<string, string>` mapping table name to stable group key.
- Produces: `layoutRelationshipGraph(graph: RelationshipGraph, canvas: CanvasSize): RelationshipLayout`.
- Produces: `fitRelationshipViewport(layout, canvas): RelationshipViewport`, `zoomRelationshipViewport`, `panRelationshipViewport`, and `moveRelationshipNode`.

- [x] **Step 1: Write failing token and grouping tests**

Require concrete normalization:

```ts
expect(tokenizeTableName('UserProfile2FA')).toEqual(['user', 'profile', '2', 'fa']);
expect(tokenizeTableName('users_roles')).toEqual(['user', 'role']);
expect(tokenizeTableName('audit-log')).toEqual(['audit', 'log']);

const groups = groupRelationshipGraph(graphOf([
  'user', 'user_profile', 'user_roles',
  'order', 'order_items', 'audit_log',
]));
expect(groups.get('user_profile')).toBe(groups.get('user_roles'));
expect(groups.get('order')).toBe(groups.get('order_items'));
expect(groups.get('audit_log')).not.toBe(groups.get('user'));
```

Add a 2,000-table candidate-generation test with an injected diagnostic counter exported only from `groups.ts` as `groupRelationshipGraph(graph, { onCandidatePair })`; assert candidates remain below `tables.length * 24`, proving the token index prevents all-pairs work.

- [x] **Step 2: Write failing layout, edge, and viewport tests**

Port all current SQLite/MySQL layout cases into the shared suite, then add:

```ts
const wide = layoutRelationshipGraph(businessGraph, { width: 1400, height: 500 });
const narrow = layoutRelationshipGraph(businessGraph, { width: 500, height: 1400 });
expect(wide.width / wide.height).toBeGreaterThan(narrow.width / narrow.height);
expect(assertNoNodeOverlap(wide)).toBeUndefined();
expect(assertNoNodeOverlap(narrow)).toBeUndefined();
expect(layoutRelationshipGraph(businessGraph, { width: 1400, height: 500 })).toEqual(wide);

const moved = moveRelationshipNode(wide, businessGraph, 'user_profile', { x: 50, y: 70 });
expect(moved.nodes.find((node) => node.name === 'user_profile')).toMatchObject({ x: 50, y: 70 });
expect(moved.edges.filter(isIncident('user_profile'))).not.toEqual(wide.edges.filter(isIncident('user_profile')));
```

Retain exact tests for reciprocal cycles, strongly connected components, self paths, parallel constraints, path coordinates inside bounds, variable node heights, missing relationship endpoints, scale clamp `0.3..2`, zoom anchors, pan, and a 5,000-table chain.

- [x] **Step 3: Run the new suites and verify the layout exports are absent**

Run:

```bash
npx vitest run --config packages/relationship-graph/vitest.config.ts \
  packages/relationship-graph/tests/names.test.ts \
  packages/relationship-graph/tests/layout.test.ts
```

Expected: FAIL on missing tokenizer, grouping, and layout exports.

- [x] **Step 4: Implement bounded token similarity and stable groups**

Use Unicode normalization and explicit boundaries before lowercase conversion. Conservative plural normalization removes `ies -> y` and a trailing `s` only for tokens longer than three characters and not ending in `ss`. Weight first shared business token highest; lower the contribution of `map`, `link`, `rel`, `history`, `log`, `detail`, `id`, and `data`. Build an inverted `Map<token, sorted table names>`; score only candidates sharing an indexed token or a normalized prefix of at least four characters. Keep at most six stable name neighbors per node.

Combine visible foreign-key edges and hidden name edges with deterministic union/find community growth capped by a fixed maximum soft-group size. An external-key edge may connect groups for adjacency without changing their business group key. Sort every input list with the existing case-insensitive/case-sensitive fallback comparator before traversal.

- [x] **Step 5: Implement two-level viewport packing and edge routing**

Keep these constants centralized in `layout.ts`:

```ts
export const RELATIONSHIP_LAYOUT = {
  padding: 48,
  nodeWidth: 260,
  headerHeight: 42,
  rowHeight: 26,
  layerGap: 60,
  nodeGap: 44,
  groupGap: 72,
} as const;
```

Within each group, rank the iterative strongly connected components of the visible FK graph, place ranked nodes left-to-right, and use natural-name grid order for nodes without directional information. Compute group boxes, then try every shelf column count from `1` through `min(groupCount, ceil(sqrt(groupCount * canvas.width / canvas.height)) + 2)`. Select the candidate minimizing normalized aspect-ratio error, unused shelf area, and cross-group FK span, with column count as a deterministic final tie-breaker.

Move routing into `edges.ts`. Route only valid visible relationships after final positions; include paths in bounds. `moveRelationshipNode` clones only the public layout values, moves one node, reroutes incident and affected parallel edges, then recomputes bounds. If any computed position is non-finite, return a natural-name adaptive grid using `max(1, floor((canvas.width - 96) / (nodeWidth + nodeGap)))` columns.

- [x] **Step 6: Run package tests and build**

Run:

```bash
npm test -w @itharbors/relationship-graph
npm run build -w @itharbors/relationship-graph
```

Expected: every shared package test PASS and TypeScript emits declarations.

- [x] **Step 7: Commit the deterministic layout**

```bash
git add packages/relationship-graph/src packages/relationship-graph/tests
git commit -m '[Optimize] 实现名称聚类与视口自适应布局'
```

### Task 4: Persistent graph session and Schema reconciliation

**Files:**
- Create: `packages/relationship-graph/src/session.ts`
- Modify: `packages/relationship-graph/src/index.ts`
- Create: `packages/relationship-graph/tests/session.test.ts`

**Interfaces:**
- Produces: `createRelationshipGraphSession(options): Promise<RelationshipGraphSession>`.
- `RelationshipGraphSession` exposes `snapshot`, `moveNode`, `setViewport`, `fit`, `autoArrange`, `updateGraph`, `flush`, and `dispose`.
- Consumes: Task 2 store and Task 3 layout functions.

- [x] **Step 1: Write failing lifecycle and reconciliation tests**

Use the exact public interface:

```ts
const session = await createRelationshipGraphSession({
  identity,
  graph: initialGraph,
  canvas: { width: 900, height: 600 },
  store,
});
expect(session.snapshot.source).toBe('automatic');

session.moveNode('user_profile', { x: 700, y: 80 });
session.setViewport({ x: 11, y: 12, scale: 0.8 });
await session.flush();

const restored = await createRelationshipGraphSession({ identity, graph: initialGraph, canvas, store });
expect(restored.snapshot.source).toBe('cache');
expect(positionOf(restored.snapshot.layout, 'user_profile')).toEqual({ x: 700, y: 80 });
expect(restored.snapshot.viewport).toEqual({ x: 11, y: 12, scale: 0.8 });
```

Then update to a graph that removes one table and adds `user_preferences`. Assert surviving positions are identical, the deleted node is absent, the new node does not overlap, and its center is closer to the user group than the order group. Add invalid cached viewport fallback, `fit` preserving node coordinates, `autoArrange` changing coordinates according to a new narrow canvas, debounced save coalescing, and idempotent `dispose` flushing once. Stale graph/session creation is covered at each Panel's connection-generation boundary in Tasks 6 and 7, where a still-pending factory Promise can actually race a database switch.

- [x] **Step 2: Run the session test and verify the API is missing**

Run: `npx vitest run --config packages/relationship-graph/vitest.config.ts packages/relationship-graph/tests/session.test.ts`

Expected: FAIL because `createRelationshipGraphSession` is not exported.

- [x] **Step 3: Implement the session state machine**

Define the public surface exactly:

```ts
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
```

Initialization loads cache, validates current table names, and either restores or automatically arranges. `updateGraph` removes dead nodes, retains exact surviving coordinates, generates an automatic candidate layout for new tables, translates each new node beside the current bounding box of its computed group, scans by `nodeGap` until it no longer overlaps, and locally auto-arranges only that group if no position is found within a bounded scan. Re-route all visible edges afterward.

Save a cloned `PersistedRelationshipStateV1` after a 150 ms debounce; `flush` cancels the timer and awaits the current save. `dispose` is idempotent, flushes once, and prevents later mutation. All public viewport/coordinate input is clamped to finite values before entering state.

- [x] **Step 4: Run session and full package tests**

Run:

```bash
npx vitest run --config packages/relationship-graph/vitest.config.ts packages/relationship-graph/tests/session.test.ts
npm test -w @itharbors/relationship-graph
```

Expected: session suite and all package tests PASS.

- [x] **Step 5: Commit the state layer**

```bash
git add packages/relationship-graph/src/session.ts \
  packages/relationship-graph/src/index.ts \
  packages/relationship-graph/tests/session.test.ts
git commit -m '[Optimize] 持久化关系图状态并协调结构变化'
```

### Task 5: Shared DOM renderer with draggable nodes

**Files:**
- Create: `packages/relationship-graph/src/render.ts`
- Modify: `packages/relationship-graph/src/index.ts`
- Create: `packages/relationship-graph/tests/render.test.ts`

**Interfaces:**
- Produces: `renderRelationshipView(options): HTMLElement`.
- Consumes: an already-computed `RelationshipLayout`; renderer never auto-arranges by itself.
- Emits node preview/commit and viewport callbacks without writing storage directly.

- [x] **Step 1: Port existing renderer tests and add pointer-drag assertions**

Use this exact options contract in tests:

```ts
const onNodeMove = vi.fn();
const onViewportChange = vi.fn();
const view = renderRelationshipView({
  graph,
  layout,
  viewport: { x: 0, y: 0, scale: 1 },
  query: 'user',
  tableKindLabel: (table) => table.kind === 'virtual' ? 'VIRTUAL' : 'TABLE',
  onNodeMove,
  onViewportChange,
  onOpenTable: vi.fn(),
});
```

Port current accessible node, column badges, summary, search dimming, wheel zoom, pointer pan, keyboard Enter/Space, marker, and DOM-order preservation assertions. Add a PointerEvent polyfill used only by tests, place `user_profile` at graph position `{ x: 0, y: 0 }` with scale `1`, then drag its card from screen point `(100, 100)` to `(160, 140)`. Assert the card transform and incident SVG path change during preview, the node list identity is unchanged, and pointerup calls:

```ts
expect(onNodeMove).toHaveBeenLastCalledWith('user_profile', { x: 60, y: 40 }, 'commit');
```

Move fewer than four CSS pixels and assert the following click/Enter path still calls `onOpenTable` exactly once.

- [x] **Step 2: Run render tests and verify the renderer is absent**

Run: `npx vitest run --config packages/relationship-graph/vitest.config.ts packages/relationship-graph/tests/render.test.ts`

Expected: FAIL because the shared renderer is not implemented.

- [x] **Step 3: Implement stable DOM and pointer interaction**

Export:

```ts
export type RenderRelationshipViewOptions = {
  graph: RelationshipGraph;
  layout: RelationshipLayout;
  viewport: RelationshipViewport;
  query: string;
  tableKindLabel(table: RelationshipTable): string;
  onNodeMove(name: string, position: NodePosition, phase: 'preview' | 'commit'): void;
  onViewportChange(viewport: RelationshipViewport): void;
  onOpenTable(name: string): void;
};
```

Build the current `.relationship-view`, toolbar, canvas, stage, SVG edges, cards, and relationship details with DOM text nodes. Apply the supplied layout rather than recomputing it. Pointerdown on a card calls `setPointerCapture`, stops canvas pan, and stores graph-space origin. Pointermove schedules at most one `requestAnimationFrame`; update only the card style and incident paths from `moveRelationshipNode`. On pointerup/cancel, classify movement below four screen pixels as a click and otherwise emit one commit. Canvas pointer handling continues to emit pan updates; wheel zoom keeps the pointer anchor. Do not recreate all cards during drag.

- [x] **Step 4: Run renderer and package tests**

Run:

```bash
npx vitest run --config packages/relationship-graph/vitest.config.ts packages/relationship-graph/tests/render.test.ts
npm test -w @itharbors/relationship-graph
```

Expected: all renderer and shared package tests PASS.

- [x] **Step 5: Commit shared rendering**

```bash
git add packages/relationship-graph/src/render.ts \
  packages/relationship-graph/src/index.ts \
  packages/relationship-graph/tests/render.test.ts
git commit -m '[Optimize] 支持关系图节点拖动交互'
```

### Task 6: SQLite Relationships Panel integration

**Files:**
- Modify: `kits/sqlite/plugins/sqlite-relationships/package.json`
- Modify: `kits/sqlite/plugins/sqlite-relationships/panel.relationships/src/index.ts`
- Modify: `kits/sqlite/plugins/sqlite-relationships/panel.relationships/src/index.css`
- Delete: `kits/sqlite/plugins/sqlite-relationships/panel.relationships/src/relationship-view.ts`
- Modify: `kits/sqlite/plugins/sqlite-relationships/tests/panel.test.ts`
- Delete: `kits/sqlite/plugins/sqlite-relationships/tests/relationship-view.test.ts`

**Interfaces:**
- Consumes: `ConnectionSnapshot.path`, `fileIdentity`, shared store/session/renderer, and existing SQLite core/explorer requests.
- Produces: SQLite-specific `tableKindLabel`, ARIA label, theme, “适应窗口”, and “自动排列” controls.

- [x] **Step 1: Rewrite Panel tests around the shared behavior**

Mock the core state with both identity fields:

```ts
const connection = {
  connected: true,
  path: '/tmp/app.sqlite',
  fileIdentity: 'dev:1:ino:2',
  fileName: 'app.sqlite',
  mode: 'readonly',
  sqliteVersion: '3.46.0',
  foreignKeys: true,
  busyTimeout: 5000,
  connectionRevision: 1,
  schemaRevision: 1,
  dataRevision: 1,
};
```

Use a real memory `Storage` through jsdom. Test first-load automatic layout, drag-and-unmount save, remount restore for the same identity, different path/file identity isolation, fit preserving node coordinates, automatic layout consuming stubbed `view-host.clientWidth/clientHeight`, Schema update preservation/new-node placement, data event no-op, search focus, keyboard table opening, disconnect disposal, and a late first connection request not replacing a later connection event.

- [x] **Step 2: Run SQLite relationship tests and verify old Panel behavior fails**

Run:

```bash
npx vitest run --config kits/sqlite/vitest.config.ts \
  kits/sqlite/plugins/sqlite-relationships/tests/panel.test.ts
```

Expected: FAIL because the Panel has no automatic-layout button, drag persistence, shared session, or file identity handling.

- [x] **Step 3: Replace local algorithm/rendering with shared package**

Add `"@itharbors/relationship-graph": "0.0.1"` to dependencies. Import:

```ts
import {
  createDatabaseLayoutIdentity,
  createRelationshipGraphSession,
  createRelationshipLayoutStore,
  renderRelationshipView,
  type CanvasSize,
  type RelationshipGraphSession,
} from '@itharbors/relationship-graph';
```

For a connected snapshot with `path`, create identity from `[path, fileIdentity ?? 'path-only']`. Create the store from `window.localStorage`. Render the host before measuring it; use `{ width: host.clientWidth || 960, height: host.clientHeight || 640 }`. Guard all async graph/session work with the existing incrementing sequence. Dispose the old session before accepting a new connection identity.

Wire renderer preview to its DOM-only behavior and commit to `session.moveNode`; viewport changes call `session.setViewport`. “适应窗口” calls `session.fit(currentCanvas())`; “自动排列” calls `session.autoArrange(currentCanvas())`. A `ResizeObserver` updates the last valid `CanvasSize` but never auto-arranges. On Schema events call `session.updateGraph(nextGraph, currentCanvas())`; data events remain no-op. Unmount awaits/best-effort triggers session disposal without writing after the connection generation changes.

Delete the local `relationship-view.ts` and its now-duplicated tests only after the shared package covers every old behavior.

- [x] **Step 4: Add the small CSS affordances**

Add `touch-action: none` and a grabbing cursor only during card drag; keep the current SQLite theme. Ensure toolbar controls wrap in a 480 px minimum Panel and the new automatic-layout button does not cover the search input. Preserve reduced-motion overrides and focus outlines.

- [x] **Step 5: Build/check the plugin and run SQLite suites**

Run:

```bash
npm run build -w @itharbors/relationship-graph
npm run build -w @itharbors/sqlite-contracts
node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-relationships
node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-relationships
npx vitest run --config kits/sqlite/vitest.config.ts \
  kits/sqlite/plugins/sqlite-relationships/tests \
  kits/sqlite/plugins/sqlite-core/tests/plugin-main.test.ts
```

Expected: build/check succeed and every selected SQLite test PASS.

- [x] **Step 6: Commit SQLite integration**

```bash
git add kits/sqlite/plugins/sqlite-relationships
git commit -m '[Optimize] 接入 SQLite 持久化关系图布局'
```

### Task 7: MySQL Relationships Panel integration

**Files:**
- Modify: `kits/mysql/plugins/mysql-relationships/package.json`
- Modify: `kits/mysql/plugins/mysql-relationships/panel.relationships/src/index.ts`
- Modify: `kits/mysql/plugins/mysql-relationships/panel.relationships/src/index.css`
- Delete: `kits/mysql/plugins/mysql-relationships/panel.relationships/src/relationship-view.ts`
- Modify: `kits/mysql/plugins/mysql-relationships/tests/panel.test.ts`
- Delete: `kits/mysql/plugins/mysql-relationships/tests/relationship-view.test.ts`

**Interfaces:**
- Consumes: `ConnectionSnapshot.endpoint`, `database`, shared store/session/renderer, and existing MySQL activity/open sequencing.
- Produces: MySQL-specific labels, theme, activity overlay, and database identity from `[endpoint, database]`.

- [x] **Step 1: Rewrite MySQL Panel tests around identity and activity safety**

Use this connected state:

```ts
const connection = {
  connected: true,
  endpoint: 'db.local:3306',
  database: 'app',
  mysqlVersion: '8.4.0',
  tls: true,
  connectionRevision: 1,
  schemaRevision: 1,
  dataRevision: 1,
};
```

Port the SQLite persistence/fit/automatic/Schema cases with MySQL identity variants: same endpoint/database restores; changed database or endpoint does not. Retain current tests for spinner, aria-busy, retry, stale loads, duplicate table-open suppression, and activity controls. Require “自动排列” to be disabled during both graph load and table opening.

- [x] **Step 2: Run MySQL relationship tests and verify missing shared behavior**

Run: `npx vitest run --config kits/mysql/vitest.config.ts kits/mysql/plugins/mysql-relationships/tests/panel.test.ts`

Expected: FAIL on persistence, drag, and automatic-layout expectations.

- [x] **Step 3: Replace the local implementation with the shared session/renderer**

Add the shared package dependency and use the same imports and current-canvas helper as SQLite. Only create an identity when both `endpoint` and `database` are non-null:

```ts
const identity = createDatabaseLayoutIdentity('mysql', [connection.endpoint, connection.database]);
```

Preserve the existing `RelationshipActivity` state and sequence checks. The session is created only after graph load succeeds; reconnect/select-database disposes the prior session. Schema reload calls `session.updateGraph`; failed reload keeps the warm current graph/session and shows the existing error treatment without destroying cached coordinates. renderer callbacks are disabled while activity is non-null. Dispose on unmount/disconnect.

Delete the MySQL-local view implementation and duplicated view tests after the shared tests prove parity.

- [x] **Step 4: Update MySQL CSS without changing its visual identity**

Add the same drag/touch and toolbar wrap rules under the MySQL variables. Preserve activity-layer stacking, dimming, focus-visible, relationship details, and reduced-motion behavior.

- [x] **Step 5: Build/check and run MySQL suites**

Run:

```bash
npm run build -w @itharbors/relationship-graph
node scripts/ce-plugin.mjs build kits/mysql/plugins/mysql-relationships
node scripts/ce-plugin.mjs check kits/mysql/plugins/mysql-relationships
npx vitest run --config kits/mysql/vitest.config.ts kits/mysql/plugins/mysql-relationships/tests
```

Expected: build/check succeed and every MySQL relationship test PASS.

- [x] **Step 6: Commit MySQL integration**

```bash
git add kits/mysql/plugins/mysql-relationships
git commit -m '[Optimize] 接入 MySQL 持久化关系图布局'
```

### Task 8: Repository verification and manual product smoke test

**Files:**
- Modify only if verification exposes a goal-related defect; keep each correction in the owning file from Tasks 1–7.
- Regenerate tracked plugin `dist` files only through `scripts/ce-plugin.mjs build` if the repository records them.

**Interfaces:**
- Verifies the full design against authoritative tests, builds, plugin checks, and running products.
- Produces a clean worktree ready for `change-workflow` finish.

- [x] **Step 1: Run focused shared and Kit tests**

Run:

```bash
npm test -w @itharbors/relationship-graph
npm run test -w @itharbors/kit-sqlite
npm run test -w @itharbors/kit-mysql
```

Expected: all three commands PASS. If a failure is unrelated and pre-existing, capture exact evidence; do not weaken or delete coverage.

- [x] **Step 2: Run repository build and plugin checks**

Run:

```bash
npm run build
npm run plugins:check
```

Expected: TypeScript, client/server, all plugins, and all manifest checks succeed.

- [x] **Step 3: Run the full repository test suite**

Run: `npm test`

Expected: every repository test PASS, including change-workflow tests.

- [ ] **Step 4: Smoke-test SQLite in the Electron app**

Environment note: attempted twice on 2026-07-22, including after `npm rebuild electron`;
the Electron process was terminated by the host with `SIGKILL` before creating a window.
The real SQLite runtime integration suite passed, but this manual UI step remains unverified.

Run: `npm run dev -- --kit ./kits/sqlite`

Verify with a database containing related and similarly named tables:

1. First open groups similarly named tables and fits the current Relationships Panel.
2. Drag two nodes, pan, and zoom; leave/reopen the database and confirm all three restore.
3. “适应窗口” changes no node position.
4. Resize narrow and wide, click “自动排列”, and confirm the graph changes column packing to use the current region.
5. Add/drop a table through SQL, return to Relationships, and confirm surviving nodes stay fixed while the new table appears near its name group and the removed table disappears.
6. Open a different file with the same base filename and confirm it does not inherit the first file’s layout.

Stop only the process started by this command; do not use broad kill commands.

- [ ] **Step 5: Smoke-test MySQL in the Electron app**

Environment note: the same Electron host failure blocks the window, and no live MySQL service or
credentials are configured. The existing live MySQL integration test remains skipped by its own
environment guard; no manual result is claimed.

Run: `npm run dev -- --kit ./kits/mysql`

Verify the same drag/persist/fit/automatic/Schema behavior. Switch between two databases on the same endpoint and confirm their caches are isolated, then switch back and confirm the original layout restores. Confirm table opening, loading overlay, retry, search, keyboard access, relationship details, self edges, and parallel constraints still work.

- [x] **Step 6: Audit every objective and inspect the final diff**

Run:

```bash
git status --short
git diff --check 654b5697a569a58974b9c3f7b2e2a3fc979b1d37..HEAD
git diff --stat 654b5697a569a58974b9c3f7b2e2a3fc979b1d37..HEAD
rg -n "layoutRelationshipGraph|renderRelationshipView" \
  kits/sqlite/plugins/sqlite-relationships \
  kits/mysql/plugins/mysql-relationships \
  packages/relationship-graph
```

Expected: no unstaged generated debris; no whitespace errors; layout and rendering implementations exist only in the shared package; both Panels import them. Match evidence to each design goal: stable database ID with exact-identity conflict handling, cached node/viewport restoration, name clustering, viewport-aware automatic layout, draggable nodes, Schema reconciliation, and SQLite/MySQL parity.

- [x] **Step 7: Commit any generated artifacts or verification fixes**

If verification changed the tracked relationship plugin output, inspect `git status --short`, confirm every path belongs to this feature, then stage these exact output directories together with the already identified owning source/test file:

```bash
git add kits/sqlite/plugins/sqlite-relationships/main/dist \
  kits/sqlite/plugins/sqlite-relationships/panel.relationships/dist \
  kits/mysql/plugins/mysql-relationships/main/dist \
  kits/mysql/plugins/mysql-relationships/panel.relationships/dist
git commit -m '[Optimize] 完成数据库关系图回归验证'
```

If only a focused source/test defect changed, stage the exact owning path named by `git status --short` instead of the output directories. If `git status --short` is already empty, do not create an empty commit.

- [ ] **Step 8: Finish through the repository workflow**

Create a body file outside the repository containing exact commands that passed:

```md
## Summary

- 统一 SQLite 与 MySQL 的名称聚类关系图布局
- 按数据库身份持久化节点和视口并处理缓存冲突
- 支持节点拖动、结构增量协调和视口自适应自动排列

## Testing

- `npm test -w @itharbors/relationship-graph`
- `npm run test -w @itharbors/kit-sqlite`
- `npm run test -w @itharbors/kit-mysql`
- `npm run build`
- `npm run plugins:check`
- `npm test`
```

Run the bundled workflow script from the primary checkout or by absolute path:

```bash
/Users/bytedance/Project/harbors/.agents/skills/change-workflow/scripts/finish-change.sh \
  '优化数据库关系图布局与缓存' \
  /tmp/harbors-database-relationship-graph-pr.md
```

Expected: the script verifies a clean worktree and prints `PR_URL=`. Do not report completion from a compare URL or push alone.
