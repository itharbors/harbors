# SQLite Kit Multi-Plugin Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monolithic SQLite workbench with one connection-owning core plugin and five independently built UI plugins while preserving all current SQLite behavior.

**Architecture:** `@itharbors/sqlite-core` is the only owner of `better-sqlite3`, revisions, undo state, and SQL workers. Explorer owns the selected-object state; Data, Schema, Relationships, and SQL are separate panels that synchronize through declared request and broadcast contracts. The Kit composes the panels with a native Explorer-plus-tab-group layout.

**Tech Stack:** TypeScript, CE Editor plugin runtime, `better-sqlite3`, Vitest, jsdom, JSON manifests and `LayoutNode`.

## Global Constraints

- The final plugin set is exactly `sqlite-core`, `sqlite-explorer`, `sqlite-data`, `sqlite-schema`, `sqlite-relationships`, and `sqlite-sql`.
- Only `sqlite-core` may depend on or import `better-sqlite3`, Node filesystem APIs, or worker threads.
- Preserve Chinese copy, readonly-by-default behavior, explicit write confirmation, object write restrictions, ten-second single-use undo, 25/50 row pages, 10,000 row export cap, 50 row SQL render pages, SQL risk confirmation, cancellation, and existing accessibility behavior.
- Cross-plugin interaction uses declared `message.request` and `message.broadcast`; panels do not import another plugin implementation.
- Shared code under `kits/sqlite/shared/` is serializable protocol or browser-safe pure code only.
- Final source, manifest, tests, docs, and dist contain no reference to `@itharbors/sqlite-workbench` and the old plugin directory is absent.
- Follow repository commit titles: `[Feature]` for capability/tests/docs and `[Optimize]` for structure-only moves, with concise Chinese summaries.

---

### Task 1: Shared protocol and revision-aware core plugin

**Files:**
- Create: `kits/sqlite/shared/src/contracts.ts`
- Create: `kits/sqlite/shared/src/request.ts`
- Create: `kits/sqlite/plugins/sqlite-core/package.json`
- Create: `kits/sqlite/plugins/sqlite-core/main/src/index.ts`
- Move unchanged into core: `file-browser.ts`, `protocol.ts`, `sql-analysis.ts`, `sql-worker-runner.ts`, `sql-worker.ts`, `sqlite-service.ts`
- Create/move tests: `kits/sqlite/plugins/sqlite-core/tests/*.test.ts`

**Interfaces:**
- Produces `SQLITE_CORE`, `CORE_TOPICS`, `RevisionSnapshot`, `ConnectionSnapshot`, `SchemaSnapshot`, `DataChangedEvent`, `SqliteErrorEnvelope`, `unwrapSqliteResponse()`.
- Produces every core request named in the design spec under `@itharbors/sqlite-core`.

- [ ] **Step 1: Write failing shared-contract and core-main tests**

```ts
expect(CORE_TOPICS).toEqual({
  connectionChanged: '@itharbors/sqlite.connection.changed',
  schemaChanged: '@itharbors/sqlite.schema.changed',
  dataChanged: '@itharbors/sqlite.data.changed',
});
expect(() => unwrapSqliteResponse({ $sqliteError: { code: 'X', message: '失败' } }))
  .toThrow('失败');
expect(Object.keys(definition.methods)).toEqual(expect.arrayContaining([
  'openDatabase', 'getSchema', 'getRows', 'insertRow', 'analyzeSql', 'executeSql', 'cancelSql',
]));
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run --config kits/sqlite/vitest.config.ts kits/sqlite/plugins/sqlite-core/tests/contracts.test.ts kits/sqlite/plugins/sqlite-core/tests/plugin-main.test.ts`

Expected: FAIL because the shared contract and core plugin do not exist.

- [ ] **Step 3: Add the exact shared public contract**

```ts
export const SQLITE_CORE = '@itharbors/sqlite-core';
export const SQLITE_EXPLORER = '@itharbors/sqlite-explorer';
export const CORE_TOPICS = {
  connectionChanged: '@itharbors/sqlite.connection.changed',
  schemaChanged: '@itharbors/sqlite.schema.changed',
  dataChanged: '@itharbors/sqlite.data.changed',
} as const;
export const SELECTION_CHANGED_TOPIC = '@itharbors/sqlite.selection.changed';

export type RevisionSnapshot = {
  connectionRevision: number;
  schemaRevision: number;
  dataRevision: number;
};
export type ConnectionSnapshot = RevisionSnapshot & {
  connected: boolean;
  path: string | null;
  fileName?: string | null;
  mode: 'readonly' | 'readwrite' | null;
  sqliteVersion: string | null;
};
export type SchemaSnapshot<TObject = unknown> = RevisionSnapshot & { objects: TObject[] };
export type DataChangedEvent = RevisionSnapshot & { objectName: string | null };
export type SelectionSnapshot = { connectionRevision: number; objectName: string | null };
export type SqlitePublicError = { code: string; message: string; detail?: string };
export type SqliteErrorEnvelope = { $sqliteError: SqlitePublicError };
```

`unwrapSqliteResponse<T>(value: unknown): T` must throw a `SqliteRequestError` when `$sqliteError` is present and otherwise return `value as T`.

- [ ] **Step 4: Move service code and wrap successful mutations with revisions and broadcasts**

Keep `SqliteService` validation/query behavior unchanged. In the core main, create one service and counters initialized to zero. Increment all three after a successful connection transition; increment data after CRUD/undo/DML; increment schema and data after DDL. Broadcast only after success. Wrap sync and async errors as `{ $sqliteError: toPublicError(error) }`.

```ts
editor.plugin.define({
  lifecycle: {
    load(ctx: any) { runtime = ctx; },
    unload() { runtime = undefined; return service.dispose(); },
  },
  methods: {
    getConnectionState: () => withRevisions(service.getConnectionState()),
    getSchema: () => withRevisions(service.getSchema()),
    openDatabase: (input: unknown) => transitionConnection(() => service.openDatabase(input)),
    setConnectionMode: (input: unknown) => transitionConnection(() => service.setConnectionMode(input)),
    closeDatabase: () => transitionConnection(() => service.closeDatabase()),
    insertRow: (input: unknown) => mutateData(objectNameOf(input), () => service.insertRow(input)),
    updateRow: (input: unknown) => mutateData(objectNameOf(input), () => service.updateRow(input)),
    deleteRow: (input: unknown) => mutateData(objectNameOf(input), () => service.deleteRow(input)),
    undoLastMutation: (input: unknown) => mutateData(null, () => service.undoLastMutation(input)),
  },
});
```

Expose the remaining existing service methods without semantic changes. Use SQL analysis result to classify a successful `executeSql` broadcast.

- [ ] **Step 5: Move and extend service tests, then build/check core**

Run: `npx vitest run --config kits/sqlite/vitest.config.ts kits/sqlite/plugins/sqlite-core/tests`

Expected: PASS, including failure-does-not-increment and success-broadcast tests.

Run: `node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-core && node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-core`

Expected: both commands exit 0.

- [ ] **Step 6: Commit the core boundary**

```bash
git add kits/sqlite/shared/src/contracts.ts kits/sqlite/shared/src/request.ts kits/sqlite/plugins/sqlite-core
git commit -m "[Feature] 建立 SQLite 核心插件"
```

### Task 2: Explorer plugin and authoritative selection

**Files:**
- Create: `kits/sqlite/plugins/sqlite-explorer/package.json`
- Create: `kits/sqlite/plugins/sqlite-explorer/main/src/index.ts`
- Create: `kits/sqlite/plugins/sqlite-explorer/panel.explorer/src/{index.html,index.css,index.ts,copy.ts,controller.ts,dialogs.ts,schema-view.ts}`
- Create: `kits/sqlite/plugins/sqlite-explorer/tests/{selection.test.ts,panel.test.ts,file-browser-panel.test.ts,accessibility.test.ts}`

**Interfaces:**
- Consumes core `listDirectory`, recent database, connection, open/mode/close, and schema requests.
- Produces `getSelection(): SelectionSnapshot` and `selectObject({ connectionRevision, objectName }): SelectionSnapshot`.
- Broadcasts `SELECTION_CHANGED_TOPIC` after every effective selection change.

- [ ] **Step 1: Write failing selection-store tests**

```ts
expect(await methods.selectObject({ connectionRevision: 2, objectName: 'users' }))
  .toEqual({ connectionRevision: 2, objectName: 'users' });
expect(runtime.message.broadcast).toHaveBeenCalledWith(
  '@itharbors/sqlite.selection.changed',
  { connectionRevision: 2, objectName: 'users' },
);
await expect(methods.selectObject({ connectionRevision: 1, objectName: 'stale' }))
  .rejects.toThrow(/connection revision/i);
```

- [ ] **Step 2: Run and observe the missing-plugin failure**

Run: `npx vitest run --config kits/sqlite/vitest.config.ts kits/sqlite/plugins/sqlite-explorer/tests/selection.test.ts`

Expected: FAIL because the Explorer main is missing.

- [ ] **Step 3: Implement selection ownership in Explorer main**

Keep `{ connectionRevision: 0, objectName: null }`, validate candidate names against `core.getSchema()`, reject mismatched revisions, broadcast only changed snapshots, and clear selection on `CORE_TOPICS.connectionChanged`. Expose `getSelection` and `selectObject` in the manifest.

- [ ] **Step 4: Extract connection dialog and object tree into the Explorer Panel**

Move the existing file dialog, recent path, write-mode confirmation, connection summary, object grouping and tree event handlers without changing Chinese copy. Replace direct workbench requests with `requestCore()`. On schema load, preserve a valid selection or select the first ordinary table; otherwise select the first object; otherwise select `null`.

- [ ] **Step 5: Verify Explorer behavior and build output**

Run: `npx vitest run --config kits/sqlite/vitest.config.ts kits/sqlite/plugins/sqlite-explorer/tests`

Expected: PASS for controlled file browsing, write confirmation, object groups, selection broadcasts, stale responses, focus trapping and unmount cleanup.

Run: `node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-explorer && node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-explorer`

Expected: exit 0.

- [ ] **Step 6: Commit Explorer**

```bash
git add kits/sqlite/plugins/sqlite-explorer
git commit -m "[Feature] 拆分 SQLite 对象浏览插件"
```

### Task 3: Data browsing and editing plugin

**Files:**
- Create: `kits/sqlite/plugins/sqlite-data/package.json`
- Create: `kits/sqlite/plugins/sqlite-data/main/src/index.ts`
- Create: `kits/sqlite/plugins/sqlite-data/panel.data/src/{index.html,index.css,index.ts,copy.ts,controller.ts,data-view.ts,dialogs.ts,export.ts,state.ts,view-model.ts}`
- Create: `kits/sqlite/plugins/sqlite-data/tests/*.test.ts`

**Interfaces:**
- Consumes core connection, schema, rows, export, CRUD and undo requests.
- Consumes Explorer `getSelection` plus connection, selection and data broadcasts.
- Produces one `data` Panel and no database-facing request methods.

- [ ] **Step 1: Write a failing mount-and-refresh test**

```ts
await definition.mount(ctx);
expect(ctx.message.request).toHaveBeenCalledWith('@itharbors/sqlite-explorer', 'getSelection');
expect(ctx.message.request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'getRows', expect.objectContaining({
  name: 'users', page: 1, pageSize: 25,
}));
const requestCount = ctx.message.request.mock.calls.length;
await definition.methods.onDataChanged({ connectionRevision: 1, schemaRevision: 1, dataRevision: 2, objectName: 'users' });
expect(ctx.message.request.mock.calls.length).toBeGreaterThan(requestCount);
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run --config kits/sqlite/vitest.config.ts kits/sqlite/plugins/sqlite-data/tests/panel.test.ts`

Expected: FAIL because the Data Panel is missing.

- [ ] **Step 3: Extract Data-only state and rendering**

Move existing row query, view-model, export, record dialog, delete dialog, undo timer and focus behavior. Remove connection/file/tree/schema/relationship/SQL state. Initialize from connection and selection snapshots, and clear rows immediately on revision or selection mismatch.

- [ ] **Step 4: Declare broadcast routes and stale-response guards**

```json
"broadcast": {
  "@itharbors/sqlite.connection.changed": ["panel.onConnectionChanged"],
  "@itharbors/sqlite.selection.changed": ["panel.onSelectionChanged"],
  "@itharbors/sqlite.data.changed": ["panel.onDataChanged"],
  "@itharbors/sqlite.schema.changed": ["panel.onSchemaChanged"]
}
```

The handlers compare `connectionRevision`, selected object and local request sequence before updating DOM. Data broadcasts for another known object do not reload the current table; `objectName: null` reloads conservatively.

- [ ] **Step 5: Run Data tests and build/check**

Run: `npx vitest run --config kits/sqlite/vitest.config.ts kits/sqlite/plugins/sqlite-data/tests`

Expected: PASS for paging, search, filters, sorts, copy/export, typed CRUD, read-only rules, undo expiry, dialogs, focus, row/table semantics, stale responses and unmount.

Run: `node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-data && node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-data`

Expected: exit 0.

- [ ] **Step 6: Commit Data**

```bash
git add kits/sqlite/plugins/sqlite-data
git commit -m "[Feature] 拆分 SQLite 数据编辑插件"
```

### Task 4: Schema plugin

**Files:**
- Create: `kits/sqlite/plugins/sqlite-schema/package.json`
- Create: `kits/sqlite/plugins/sqlite-schema/main/src/index.ts`
- Create: `kits/sqlite/plugins/sqlite-schema/panel.schema/src/{index.html,index.css,index.ts,copy.ts,controller.ts,schema-view.ts}`
- Create: `kits/sqlite/plugins/sqlite-schema/tests/{panel.test.ts,schema-view.test.ts,accessibility.test.ts}`

**Interfaces:**
- Consumes core connection and `getObjectSchema`.
- Consumes Explorer selection plus connection, selection and schema broadcasts.
- Produces the single-instance `schema` Panel.

- [ ] **Step 1: Write a failing selected-object schema test**

```ts
await definition.mount(ctx);
expect(ctx.message.request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'getObjectSchema', { name: 'users' });
expect(document.body.textContent).toContain('CREATE TABLE users');
await definition.methods.onSelectionChanged({ connectionRevision: 1, objectName: 'orders' });
expect(ctx.message.request).toHaveBeenLastCalledWith('@itharbors/sqlite-core', 'getObjectSchema', { name: 'orders' });
```

- [ ] **Step 2: Run and confirm missing Panel failure**

Run: `npx vitest run --config kits/sqlite/vitest.config.ts kits/sqlite/plugins/sqlite-schema/tests/panel.test.ts`

Expected: FAIL.

- [ ] **Step 3: Extract Schema rendering and state**

Move `groupSchemaObjects`, `renderSqlCode`, DDL copy and wrap toggle. Keep only selected object, object schema, loading/error, wrap and request sequence state. Empty or disconnected selection renders the existing Chinese empty state.

- [ ] **Step 4: Run tests and build/check**

Run: `npx vitest run --config kits/sqlite/vitest.config.ts kits/sqlite/plugins/sqlite-schema/tests`

Expected: PASS for fields, indexes, foreign keys, triggers, safe DDL tokens, copy, wrap, stale selection and accessible headings.

Run: `node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-schema && node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-schema`

Expected: exit 0.

- [ ] **Step 5: Commit Schema**

```bash
git add kits/sqlite/plugins/sqlite-schema
git commit -m "[Feature] 拆分 SQLite 结构查看插件"
```

### Task 5: Relationship graph plugin

**Files:**
- Create: `kits/sqlite/plugins/sqlite-relationships/package.json`
- Create: `kits/sqlite/plugins/sqlite-relationships/main/src/index.ts`
- Create: `kits/sqlite/plugins/sqlite-relationships/panel.relationships/src/{index.html,index.css,index.ts,copy.ts,controller.ts,relationship-view.ts}`
- Create: `kits/sqlite/plugins/sqlite-relationships/tests/{panel.test.ts,relationship-view.test.ts,accessibility.test.ts}`

**Interfaces:**
- Consumes core connection and relationship graph requests.
- Consumes Explorer `selectObject` and core connection/schema broadcasts.
- Produces the single-instance `relationships` Panel.

- [ ] **Step 1: Write a failing graph-load and schema-jump test**

```ts
await definition.mount(ctx);
expect(ctx.message.request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'getRelationshipGraph');
document.querySelector<HTMLElement>('[data-relationship-table="users"]')!.click();
expect(ctx.message.request).toHaveBeenCalledWith('@itharbors/sqlite-explorer', 'selectObject', {
  connectionRevision: 1,
  objectName: 'users',
});
expect(ctx.panel.openPanel).toHaveBeenCalledWith('@itharbors/sqlite-schema.schema');
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run --config kits/sqlite/vitest.config.ts kits/sqlite/plugins/sqlite-relationships/tests/panel.test.ts`

Expected: FAIL.

- [ ] **Step 3: Extract graph renderer and revision cache**

Move `layoutRelationshipGraph`, render, fit, zoom, pointer capture, keyboard activation, search and summary code unchanged. Cache by `{ connectionRevision, schemaRevision }`; data-only broadcasts do nothing. A schema revision keeps the old graph visible while refresh is pending, then rejects stale responses before replacing it.

- [ ] **Step 4: Run graph tests and build/check**

Run: `npx vitest run --config kits/sqlite/vitest.config.ts kits/sqlite/plugins/sqlite-relationships/tests`

Expected: PASS including empty schema, no-FK schema, error retry, stale connection/schema, 5,000-table chain, cycles, self-loops, parallel edges, pointer zoom/pan, keyboard and summaries.

Run: `node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-relationships && node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-relationships`

Expected: exit 0.

- [ ] **Step 5: Commit Relationships**

```bash
git add kits/sqlite/plugins/sqlite-relationships
git commit -m "[Feature] 拆分 SQLite 关系图插件"
```

### Task 6: SQL workspace plugin

**Files:**
- Create: `kits/sqlite/plugins/sqlite-sql/package.json`
- Create: `kits/sqlite/plugins/sqlite-sql/main/src/index.ts`
- Create: `kits/sqlite/plugins/sqlite-sql/panel.sql/src/{index.html,index.css,index.ts,copy.ts,controller.ts,dialogs.ts,export.ts,sql-format.ts,sql-view.ts}`
- Create: `kits/sqlite/plugins/sqlite-sql/tests/*.test.ts`

**Interfaces:**
- Consumes core connection, schema, analyze, execute, cancel and explain requests.
- Consumes connection and schema broadcasts.
- Produces the single-instance `sql` Panel.

- [ ] **Step 1: Write a failing execution and cancellation test**

```ts
await definition.mount(ctx);
setSqlText('SELECT * FROM users');
click('[data-action="run-sql"]');
expect(ctx.message.request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'analyzeSql', {
  sql: 'SELECT * FROM users',
});
expect(ctx.message.request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'executeSql', expect.objectContaining({
  sql: 'SELECT * FROM users', page: 1,
}));
click('[data-action="cancel-sql"]');
expect(ctx.message.request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'cancelSql', expect.any(Object));
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run --config kits/sqlite/vitest.config.ts kits/sqlite/plugins/sqlite-sql/tests/panel.test.ts`

Expected: FAIL.

- [ ] **Step 3: Extract SQL-only state and rendering**

Move SQL formatting, completion, line numbers, analysis confirmation, execution id, cancellation, explain, result paging, copy/export and history. Keep draft/history across selection and schema changes; refresh completion candidates after schema change. Clear active execution and reject late results after a connection revision change.

- [ ] **Step 4: Run SQL tests and build/check**

Run: `npx vitest run --config kits/sqlite/vitest.config.ts kits/sqlite/plugins/sqlite-sql/tests`

Expected: PASS for protected-token formatting, completion, risk copy, target names, readonly enforcement, 50-row paging, history cap, copy/export, errors, cancellation and stale execution.

Run: `node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-sql && node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-sql`

Expected: exit 0.

- [ ] **Step 5: Commit SQL**

```bash
git add kits/sqlite/plugins/sqlite-sql
git commit -m "[Feature] 拆分 SQLite SQL 插件"
```

### Task 7: Assemble the Kit and retire the monolith

**Files:**
- Modify: `kits/sqlite/package.json`
- Modify: `kits/sqlite/layout.json`
- Modify: `kits/sqlite/tests/kit-manifest.test.ts`
- Modify: `kits/sqlite/tests/runtime-integration.test.ts`
- Delete: `kits/sqlite/plugins/sqlite-workbench/`

**Interfaces:**
- Consumes all six plugin manifests and their dist outputs.
- Produces the final Kit assembly and native multi-panel layout.

- [ ] **Step 1: Change Kit tests first**

Assert the exact plugin array:

```ts
expect(manifest['ce-editor'].kit.plugin).toEqual([
  '@itharbors/sqlite-core',
  '@itharbors/sqlite-explorer',
  '@itharbors/sqlite-data',
  '@itharbors/sqlite-schema',
  '@itharbors/sqlite-relationships',
  '@itharbors/sqlite-sql',
]);
```

Assert root `hsplit`, `sizes: [300, 1]`, Explorer left leaf, a right `tab` with Data/Schema/Relationships/SQL leaves, `activeIndex: 0`, and `activePanel: '@itharbors/sqlite-data.data'`.

- [ ] **Step 2: Run and confirm the old assembly fails**

Run: `npx vitest run --config kits/sqlite/vitest.config.ts kits/sqlite/tests/kit-manifest.test.ts kits/sqlite/tests/runtime-integration.test.ts`

Expected: FAIL because the Kit still declares the monolith.

- [ ] **Step 3: Apply the exact final manifest and layout**

```json
{
  "type": "hsplit",
  "sizes": [300, 1],
  "children": [
    { "type": "leaf", "panel": "@itharbors/sqlite-explorer.explorer" },
    {
      "type": "tab",
      "activeIndex": 0,
      "children": [
        { "type": "leaf", "panel": "@itharbors/sqlite-data.data" },
        { "type": "leaf", "panel": "@itharbors/sqlite-schema.schema" },
        { "type": "leaf", "panel": "@itharbors/sqlite-relationships.relationships" },
        { "type": "leaf", "panel": "@itharbors/sqlite-sql.sql" }
      ]
    }
  ]
}
```

Update runtime integration targets from workbench to core and add selection route assertions for Explorer.

- [ ] **Step 4: Remove old plugin and prove no stale references**

Delete `kits/sqlite/plugins/sqlite-workbench/` only after all behavior tests have moved. Run:

`rg -n '@itharbors/sqlite-workbench|plugins/sqlite-workbench' kits/sqlite`

Expected: no matches in the assembled Kit.

- [ ] **Step 5: Run all SQLite tests**

Run: `npm test -w @itharbors/kit-sqlite`

Expected: PASS with all service, panel, accessibility, manifest and real-runtime tests.

- [ ] **Step 6: Commit final assembly**

```bash
git add kits/sqlite/package.json kits/sqlite/layout.json kits/sqlite/tests kits/sqlite/plugins
git commit -m "[Feature] 启用 SQLite 多插件工作台"
```

### Task 8: Documentation, generated artifacts and full verification

**Files:**
- Modify: `kits/sqlite/README.md`
- Modify: `docs/guides/developing-plugins-and-kits.md`
- Modify: all six plugin `main/dist` and `panel.*/dist` outputs through the build command

**Interfaces:**
- Produces user/developer documentation and verified distributable artifacts.

- [ ] **Step 1: Update docs with exact build commands and architecture**

Document that `sqlite-core` owns the connection; Explorer owns selection; Data, Schema, Relationships and SQL are separate tabs. Replace the old single build command with:

```bash
for plugin in sqlite-core sqlite-explorer sqlite-data sqlite-schema sqlite-relationships sqlite-sql; do
  node scripts/ce-plugin.mjs build "kits/sqlite/plugins/$plugin"
done
npm run dev -- --kit ./kits/sqlite
```

- [ ] **Step 2: Build and check all plugins**

Run the build loop above, then the same loop with `check`.

Expected: all twelve commands exit 0; each manifest points only to existing dist files.

- [ ] **Step 3: Run focused and repository gates**

Run: `npm test -w @itharbors/kit-sqlite`

Expected: PASS.

Run: `npm run check`

Expected: PASS with no lint, type, unit, integration or plugin validation failures.

- [ ] **Step 4: Run structural completion audit**

```bash
test ! -e kits/sqlite/plugins/sqlite-workbench
test "$(find kits/sqlite/plugins -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" = "6"
rg -n 'better-sqlite3' kits/sqlite/plugins --glob '!sqlite-core/**'
rg -n '@itharbors/sqlite-workbench|plugins/sqlite-workbench' kits/sqlite docs/guides/developing-plugins-and-kits.md
```

Expected: both `test` commands succeed and both `rg` commands return no matches.

- [ ] **Step 5: Perform manual smoke test**

Run: `npm run dev -- --kit ./kits/sqlite`

Verify: open and create; readonly-to-write confirmation; object selection drives Data and Schema; CRUD and undo refresh Data; relationship node selects the object and focuses Schema; SQL SELECT/write confirmation/cancel works; native tab layout and narrow-window controls remain usable.

- [ ] **Step 6: Inspect and commit only intended documentation and generated files**

```bash
git status --short
git diff
git diff --cached
git add kits/sqlite/README.md docs/guides/developing-plugins-and-kits.md kits/sqlite/plugins/*/main/dist kits/sqlite/plugins/*/panel.*/dist
git commit -m "[Feature] 完善 SQLite 多插件文档与产物"
```

- [ ] **Step 7: Final clean-tree verification**

Run: `git status --short --branch && git log --oneline --decorate -10`

Expected: clean `codex/sqlite-plugin-split` worktree with the design, plan and implementation commits ahead of `origin/main`.
