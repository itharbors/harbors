# MySQL Kit Plugin Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monolithic MySQL workbench with six independently loaded plugins and add a tested whole-database foreign-key relationship graph.

**Architecture:** `mysql-core` owns the only MySQL pool and publishes revisioned connection/schema/data events. `mysql-explorer` owns selection; Data, Schema, Relationships, and SQL Panels recover from request snapshots and use broadcasts only for invalidation. `mysql-contracts` is the browser-safe shared protocol package.

**Tech Stack:** TypeScript, Vitest/jsdom, mysql2, Harbors plugin request/broadcast runtime, native Kit `LayoutNode`.

## Global Constraints

- Preserve all existing MySQL connection, schema, paging, CRUD, transaction, value-serialization, SQL-result, and error-code behavior.
- Add only the relationship graph; do not add SQLite-only undo, export, SQL cancellation, query planning, file browsing, or read/write modes.
- The Kit workspace installs `mysql2`; among plugin packages only `@itharbors/mysql-core` may depend on or import it, and only core may create/close a pool.
- Panels may import `@itharbors/mysql-contracts` and files inside their own plugin only; they may not import another plugin implementation.
- Relationship nodes are current-database `BASE TABLE` objects only; edges are declared MySQL constraints grouped by constraint and ordered by `ORDINAL_POSITION`.
- Broadcasts invalidate state; mount-time requests remain the authoritative recovery path.
- Use repository commit titles `[Feature] 摘要` and stage explicit paths only.

---

### Task 1: Shared contracts and graph-producing core service

**Files:**
- Create: `packages/mysql-contracts/package.json`
- Create: `packages/mysql-contracts/tsconfig.json`
- Create: `packages/mysql-contracts/src/contracts.ts`
- Create: `packages/mysql-contracts/src/request.ts`
- Create: `packages/mysql-contracts/src/index.ts`
- Create: `kits/mysql/plugins/mysql-core/package.json`
- Copy, then delete during Task 7: `kits/mysql/plugins/mysql-workbench/main/src/mysql-driver.ts` to `kits/mysql/plugins/mysql-core/main/src/mysql-driver.ts`
- Copy, then delete during Task 7: `kits/mysql/plugins/mysql-workbench/main/src/protocol.ts` to `kits/mysql/plugins/mysql-core/main/src/protocol.ts`
- Copy, then delete during Task 7: `kits/mysql/plugins/mysql-workbench/main/src/mysql-service.ts` to `kits/mysql/plugins/mysql-core/main/src/mysql-service.ts`
- Copy, then delete during Task 7: `kits/mysql/plugins/mysql-workbench/tests/fake-driver.ts` to `kits/mysql/plugins/mysql-core/tests/fake-driver.ts`
- Copy, then delete during Task 7: `kits/mysql/plugins/mysql-workbench/tests/mysql-driver.test.ts` to `kits/mysql/plugins/mysql-core/tests/mysql-driver.test.ts`
- Copy, then delete during Task 7: `kits/mysql/plugins/mysql-workbench/tests/protocol.test.ts` to `kits/mysql/plugins/mysql-core/tests/protocol.test.ts`
- Copy, then delete during Task 7: `kits/mysql/plugins/mysql-workbench/tests/mysql-service.test.ts` to `kits/mysql/plugins/mysql-core/tests/mysql-service.test.ts`
- Create: `kits/mysql/plugins/mysql-core/tests/contracts.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `MYSQL_CORE`, `MYSQL_EXPLORER`, `CORE_TOPICS`, `SELECTION_CHANGED_TOPIC`, `RevisionSnapshot`, `ConnectionSnapshot`, `SchemaSnapshot<T>`, `SelectionSnapshot`, `DataChangedEvent`, `MysqlErrorEnvelope`, and `unwrapMysqlResponse<T>` from `@itharbors/mysql-contracts`.
- Produces: `MysqlService.getRelationshipGraph(): Promise<RelationshipGraph>` where a graph contains `tables` and constraint-grouped `relationships`.

- [ ] **Step 1: Write failing contract and relationship graph tests**

Add contract tests that require a `$mysqlError` envelope to become `MysqlRequestError`, and add service expectations shaped as:

```ts
expect(await service.getRelationshipGraph()).toEqual({
  tables: [
    {
      name: 'children',
      kind: 'table',
      columns: [
        { name: 'child_id', type: 'int', primaryKeyOrder: 1, foreignKey: false },
        { name: 'parent_tenant_id', type: 'int', primaryKeyOrder: 0, foreignKey: true },
        { name: 'parent_id', type: 'bigint', primaryKeyOrder: 0, foreignKey: true },
      ],
    },
    expect.objectContaining({ name: 'parents', kind: 'table' }),
  ],
  relationships: [{
    id: 'children:children_parent_fk',
    fromTable: 'children',
    toTable: 'parents',
    columns: [
      { from: 'parent_tenant_id', to: 'tenant_id' },
      { from: 'parent_id', to: 'id' },
    ],
    onUpdate: 'CASCADE',
    onDelete: 'RESTRICT',
  }],
});
```

The fake driver must assert parameterized `information_schema` queries for tables/columns/keys and include a view row that is excluded.

- [ ] **Step 2: Run the new tests and verify RED**

Run: `npx vitest run --config kits/mysql/vitest.config.ts kits/mysql/plugins/mysql-core/tests/contracts.test.ts kits/mysql/plugins/mysql-core/tests/mysql-service.test.ts`

Expected: FAIL because `@itharbors/mysql-contracts` and `getRelationshipGraph` do not exist.

- [ ] **Step 3: Implement contracts, move the service, and add graph normalization**

Define the public graph types exactly as:

```ts
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
  columns: Array<{ from: string; to: string }>;
  onUpdate: string;
  onDelete: string;
};
export type RelationshipGraph = {
  tables: RelationshipTable[];
  relationships: Relationship[];
};
```

Implement `getRelationshipGraph` using current database as a bound parameter. Query `information_schema.TABLES` for `BASE TABLE`, `COLUMNS` for ordered names/types, `STATISTICS` for `PRIMARY`, and `KEY_COLUMN_USAGE` joined with `REFERENTIAL_CONSTRAINTS` for declared foreign keys. Group rows by `(TABLE_NAME, CONSTRAINT_NAME)`, preserve ordinal order, mark participating source columns as foreign keys, and return deterministic table/relationship order.

Add `@itharbors/mysql-contracts` to root build before client/server/plugin builds. Keep `mysql2` only in `mysql-core/package.json`.

- [ ] **Step 4: Run core service and contract tests and verify GREEN**

Run: `npm install && npx vitest run --config kits/mysql/vitest.config.ts kits/mysql/plugins/mysql-core/tests/contracts.test.ts kits/mysql/plugins/mysql-core/tests/protocol.test.ts kits/mysql/plugins/mysql-core/tests/mysql-driver.test.ts kits/mysql/plugins/mysql-core/tests/mysql-service.test.ts`

Expected: all migrated tests and new graph tests PASS.

- [ ] **Step 5: Commit the service boundary**

Stage only the contract package, root package files, and `mysql-core` service/test files. Commit: `[Feature] 建立 MySQL 核心服务与关系协议`.

---

### Task 2: Revisioned core runtime

**Files:**
- Create: `kits/mysql/plugins/mysql-core/main/src/index.ts`
- Copy and rewrite, then delete the source during Task 7: `kits/mysql/plugins/mysql-workbench/tests/plugin-main.test.ts` to `kits/mysql/plugins/mysql-core/tests/plugin-main.test.ts`

**Interfaces:**
- Consumes: contract constants and snapshots from Task 1.
- Produces: request methods declared in `mysql-core/package.json` and broadcasts `connectionChanged`, `schemaChanged`, and `dataChanged`.

- [ ] **Step 1: Write a failing runtime test**

Capture `editor.plugin.define`, load a fake runtime with `message.broadcast`, and verify:

```ts
expect(await definition.methods.connect(connectionInput)).toMatchObject({
  connected: true,
  connectionRevision: 1,
  schemaRevision: 1,
  dataRevision: 1,
});
expect(broadcast).toHaveBeenCalledWith(
  '@itharbors/mysql.connection.changed',
  expect.objectContaining({ connectionRevision: 1 }),
);
```

Also require successful CRUD to publish object-specific data changes, DDL SQL to publish schema changes, DML SQL to publish data changes, failed operations to return `$mysqlError` without broadcasts, and unload to dispose once safely.

- [ ] **Step 2: Run the runtime test and verify RED**

Run: `npx vitest run --config kits/mysql/vitest.config.ts kits/mysql/plugins/mysql-core/tests/plugin-main.test.ts`

Expected: FAIL because the revisioned core entry is missing.

- [ ] **Step 3: Implement the runtime adapter**

Keep revisions in the plugin entry, not in `MysqlService`. Convert thrown or rejected service failures to:

```ts
{ $mysqlError: { code: error.code, message: error.message } }
```

On successful connect/disconnect, increment all revisions and publish a connection snapshot. On CRUD, increment data revision and publish the named object. Classify successful mutation SQL by its first executable keyword; schema keywords are `CREATE`, `ALTER`, `DROP`, `RENAME`, and `TRUNCATE`; known data mutations publish data only; unknown mutation statements conservatively publish schema and data invalidation.

- [ ] **Step 4: Run the core runtime suite and verify GREEN**

Run: `npx vitest run --config kits/mysql/vitest.config.ts kits/mysql/plugins/mysql-core/tests`

Expected: every core test PASS.

- [ ] **Step 5: Commit the runtime**

Stage only the core entry, manifest, and runtime test. Commit: `[Feature] 增加 MySQL 核心状态广播`.

---

### Task 3: Explorer plugin and authoritative selection

**Files:**
- Create: `kits/mysql/plugins/mysql-explorer/package.json`
- Create: `kits/mysql/plugins/mysql-explorer/main/src/index.ts`
- Create: `kits/mysql/plugins/mysql-explorer/panel.explorer/src/index.html`
- Create: `kits/mysql/plugins/mysql-explorer/panel.explorer/src/index.css`
- Create: `kits/mysql/plugins/mysql-explorer/panel.explorer/src/index.ts`
- Create: `kits/mysql/plugins/mysql-explorer/tests/selection.test.ts`
- Create: `kits/mysql/plugins/mysql-explorer/tests/panel.test.ts`

**Interfaces:**
- Consumes: `mysql-core.getConnectionState/connect/disconnect/getSchema`.
- Produces: `getSelection(): SelectionSnapshot`, `selectObject({ connectionRevision, objectName }): SelectionSnapshot`, and selection broadcasts.

- [ ] **Step 1: Write failing selection and Explorer Panel tests**

Require `selectObject` to reject stale connection revisions and names absent from the current schema. Require the Panel to mount from snapshots, render table/view groups, submit `{ host, port, user, password, database, tls }`, clear the password after success, preserve the old connected view after failed reconnect, and restore or choose selection on schema changes.

- [ ] **Step 2: Run Explorer tests and verify RED**

Run: `npx vitest run --config kits/mysql/vitest.config.ts kits/mysql/plugins/mysql-explorer/tests`

Expected: FAIL because the Explorer plugin is absent.

- [ ] **Step 3: Implement Explorer main and Panel**

The main stores only:

```ts
let selection: SelectionSnapshot = { connectionRevision: 0, objectName: null };
```

It validates candidate objects against `mysql-core.getSchema`, and publishes `SELECTION_CHANGED_TOPIC` only when the snapshot changes. The Panel moves the existing connection form, connection summary, object grouping, refresh, disconnect, and object buttons from the old workbench. It must use DOM text nodes for server-supplied values.

- [ ] **Step 4: Run Explorer tests and verify GREEN**

Run: `npx vitest run --config kits/mysql/vitest.config.ts kits/mysql/plugins/mysql-explorer/tests`

Expected: all Explorer tests PASS.

- [ ] **Step 5: Build/check and commit Explorer**

Run: `node scripts/ce-plugin.mjs build kits/mysql/plugins/mysql-explorer && node scripts/ce-plugin.mjs check kits/mysql/plugins/mysql-explorer`

Expected: both commands exit 0. Commit: `[Feature] 拆分 MySQL 资源管理器插件`.

---

### Task 4: Data and Schema plugins

**Files:**
- Create: `kits/mysql/plugins/mysql-data/package.json`
- Create: `kits/mysql/plugins/mysql-data/main/src/index.ts`
- Create: `kits/mysql/plugins/mysql-data/panel.data/src/index.html`
- Create: `kits/mysql/plugins/mysql-data/panel.data/src/index.css`
- Copy, then delete during Task 7: `kits/mysql/plugins/mysql-workbench/panel.workbench/src/view-model.ts` to `kits/mysql/plugins/mysql-data/panel.data/src/view-model.ts`
- Copy, then delete during Task 7: `kits/mysql/plugins/mysql-workbench/panel.workbench/src/copy.ts` to `kits/mysql/plugins/mysql-data/panel.data/src/copy.ts`
- Create: `kits/mysql/plugins/mysql-data/panel.data/src/index.ts`
- Copy and split, then delete the source during Task 7: `kits/mysql/plugins/mysql-workbench/tests/view-model.test.ts` to `kits/mysql/plugins/mysql-data/tests/view-model.test.ts`
- Create: `kits/mysql/plugins/mysql-data/tests/panel.test.ts`
- Create: `kits/mysql/plugins/mysql-schema/package.json`
- Create: `kits/mysql/plugins/mysql-schema/main/src/index.ts`
- Create: `kits/mysql/plugins/mysql-schema/panel.schema/src/index.html`
- Create: `kits/mysql/plugins/mysql-schema/panel.schema/src/index.css`
- Create: `kits/mysql/plugins/mysql-schema/panel.schema/src/index.ts`
- Create: `kits/mysql/plugins/mysql-schema/tests/panel.test.ts`

**Interfaces:**
- Data consumes connection/selection snapshots plus core `getObjectSchema/getRows/insertRow/updateRow/deleteRow`.
- Schema consumes connection/selection snapshots plus core `getObjectSchema`.

- [ ] **Step 1: Write failing Data and Schema Panel tests**

For Data, cover initial page 1, page size 50, next/previous boundaries, row selection, insert/edit/delete payloads, table-without-PK edit restrictions, view restrictions, object-switch reset, data-event refresh, and stale-response rejection. For Schema, require columns, primary/index/foreign-key sections and literal safe DDL text rendering.

- [ ] **Step 2: Run both Panel suites and verify RED**

Run: `npx vitest run --config kits/mysql/vitest.config.ts kits/mysql/plugins/mysql-data/tests kits/mysql/plugins/mysql-schema/tests`

Expected: FAIL because both plugins are absent.

- [ ] **Step 3: Extract Data and Schema behavior**

Data must use the existing `createRecordDraft`, `editableValueFromInput`, and `formatValue` behavior without changing serialized-value semantics. Schema renders each server string via `textContent`; DDL is a `<pre>` whose `textContent` is the returned SQL. Each Panel requests fresh snapshots on mount and compares `connectionRevision` and selected object before rendering an async result.

- [ ] **Step 4: Run Panel and migrated model tests and verify GREEN**

Run: `npx vitest run --config kits/mysql/vitest.config.ts kits/mysql/plugins/mysql-data/tests kits/mysql/plugins/mysql-schema/tests`

Expected: all Data and Schema tests PASS.

- [ ] **Step 5: Build/check and commit both plugins**

Run both plugin build/check pairs. Commit: `[Feature] 拆分 MySQL 数据与结构插件`.

---

### Task 5: Relationships plugin

**Files:**
- Create: `kits/mysql/plugins/mysql-relationships/package.json`
- Create: `kits/mysql/plugins/mysql-relationships/main/src/index.ts`
- Create: `kits/mysql/plugins/mysql-relationships/panel.relationships/src/index.html`
- Create: `kits/mysql/plugins/mysql-relationships/panel.relationships/src/index.css`
- Create: `kits/mysql/plugins/mysql-relationships/panel.relationships/src/index.ts`
- Create: `kits/mysql/plugins/mysql-relationships/panel.relationships/src/relationship-view.ts`
- Create: `kits/mysql/plugins/mysql-relationships/tests/relationship-view.test.ts`
- Create: `kits/mysql/plugins/mysql-relationships/tests/panel.test.ts`

**Interfaces:**
- Consumes: `mysql-core.getConnectionState/getRelationshipGraph`, core connection/schema events, `mysql-explorer.selectObject`, and `context.panel.openPanel`.
- Produces: deterministic graph layout and MySQL relationship Panel UI.

- [ ] **Step 1: Write failing layout and Panel tests**

Adapt the SQLite relationship suite to MySQL graph types. Keep coverage for deterministic layout, 5,000-table chains, reciprocal cycles, self references, parallel constraints, search dimming, zoom anchor, pointer pan, fit, visible relationship details, and keyboard activation. Panel activation must assert:

```ts
expect(request).toHaveBeenCalledWith('@itharbors/mysql-explorer', 'selectObject', {
  connectionRevision: 4,
  objectName: 'users',
});
expect(openPanel).toHaveBeenCalledWith('@itharbors/mysql-schema.schema');
```

- [ ] **Step 2: Run relationship suites and verify RED**

Run: `npx vitest run --config kits/mysql/vitest.config.ts kits/mysql/plugins/mysql-relationships/tests`

Expected: FAIL because the relationship renderer and Panel are absent.

- [ ] **Step 3: Implement the MySQL graph renderer and Panel**

Port the proven SQLite graph algorithm into the MySQL plugin, changing identifiers and accessible labels to MySQL. Do not import SQLite implementation files. Cache the graph by `(connectionRevision, schemaRevision)`; data-only events must keep it warm, while schema events reload it. Use a normal DOM relationship list in addition to SVG paths.

- [ ] **Step 4: Run relationship suites and verify GREEN**

Run: `npx vitest run --config kits/mysql/vitest.config.ts kits/mysql/plugins/mysql-relationships/tests`

Expected: all relationship tests PASS.

- [ ] **Step 5: Build/check and commit Relationships**

Run the plugin build/check pair. Commit: `[Feature] 添加 MySQL 全库关系图插件`.

---

### Task 6: SQL plugin

**Files:**
- Create: `kits/mysql/plugins/mysql-sql/package.json`
- Create: `kits/mysql/plugins/mysql-sql/main/src/index.ts`
- Create: `kits/mysql/plugins/mysql-sql/panel.sql/src/index.html`
- Create: `kits/mysql/plugins/mysql-sql/panel.sql/src/index.css`
- Create: `kits/mysql/plugins/mysql-sql/panel.sql/src/index.ts`
- Create: `kits/mysql/plugins/mysql-sql/tests/panel.test.ts`

**Interfaces:**
- Consumes: core connection snapshots, connection/schema broadcasts, and `executeSql`.
- Produces: the standalone MySQL SQL workspace.

- [ ] **Step 1: Write failing SQL Panel tests**

Require an explicit execute button, `textarea[aria-label="SQL"]`, row and mutation result rendering, 500-row truncation notice, elapsed time, error display, draft preservation after error, and draft preservation across selection broadcasts.

- [ ] **Step 2: Run SQL tests and verify RED**

Run: `npx vitest run --config kits/mysql/vitest.config.ts kits/mysql/plugins/mysql-sql/tests`

Expected: FAIL because the SQL plugin is absent.

- [ ] **Step 3: Extract and implement the SQL workspace**

Move only SQL-specific state and rendering from the old workbench. Use `unwrapMysqlResponse` for errors. A connection change clears old results but not the textarea value; unmount clears all module state.

- [ ] **Step 4: Run SQL tests and verify GREEN**

Run: `npx vitest run --config kits/mysql/vitest.config.ts kits/mysql/plugins/mysql-sql/tests`

Expected: all SQL tests PASS.

- [ ] **Step 5: Build/check and commit SQL**

Run the plugin build/check pair. Commit: `[Feature] 拆分 MySQL SQL 插件`.

---

### Task 7: Kit cutover, old plugin removal, and end-to-end verification

**Files:**
- Modify: `kits/mysql/package.json`
- Modify: `kits/mysql/layout.json`
- Create: `kits/mysql/README.md`
- Modify: `kits/mysql/tests/kit-manifest.test.ts`
- Modify: `kits/mysql/tests/runtime-integration.test.ts`
- Delete: `kits/mysql/plugins/mysql-workbench/`
- Modify: `docs/guides/developing-plugins-and-kits.md`
- Modify: generated plugin `dist` files under `kits/mysql/plugins/*`

**Interfaces:**
- Consumes: all six plugin contracts and Panel names.
- Produces: the final MySQL Kit assembly with no old plugin references.

- [ ] **Step 1: Write failing manifest and runtime integration tests**

Require the exact plugin list:

```ts
[
  '@itharbors/mysql-core',
  '@itharbors/mysql-explorer',
  '@itharbors/mysql-data',
  '@itharbors/mysql-schema',
  '@itharbors/mysql-relationships',
  '@itharbors/mysql-sql',
]
```

Require a 300px Explorer leaf plus a four-child tab group with Data active. Update runtime calls to `@itharbors/mysql-core`, add `getRelationshipGraph` expectations for the created composite foreign key, and verify all six plugins unload cleanly.

- [ ] **Step 2: Run Kit tests and verify RED**

Run: `npm run test -w @itharbors/kit-mysql`

Expected: manifest/runtime tests FAIL while the Kit still declares `mysql-workbench`.

- [ ] **Step 3: Cut over the Kit and remove the monolith**

Update manifest/layout/docs, keep `mysql2` in the Kit workspace as the nested plugin installation bridge, delete the remaining old Panel/tests/plugin package, and update the guide example from `mysql-workbench` to the all-plugin build command. Run:

```bash
rg -n '@itharbors/mysql-workbench|plugins/mysql-workbench' . --glob '!docs/superpowers/**'
```

Expected: no matches.

- [ ] **Step 4: Build and check all six plugins**

Run `node scripts/ce-plugin.mjs build` and `check` separately for `mysql-core`, `mysql-explorer`, `mysql-data`, `mysql-schema`, `mysql-relationships`, and `mysql-sql`.

Expected: all twelve commands exit 0 and generated `dist` matches source.

- [ ] **Step 5: Run MySQL and repository gates**

Run: `npm run test -w @itharbors/kit-mysql`.

Run: `npm run check`.

If `MYSQL_TEST_URL` is set, confirm the integration test executes instead of skipping and covers relationship graph plus revision broadcasts. Otherwise report the skip explicitly and do not claim a live-database smoke test.

- [ ] **Step 6: Audit requirements and commit final cutover**

Inspect `git status --short`, `git diff`, and `git diff --cached`; verify only intended MySQL/contract/root/docs changes remain. Check every completion criterion in the design against source and command evidence. Commit: `[Feature] 完成 MySQL Kit 多插件迁移`.
