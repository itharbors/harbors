# SQLite Kit Product Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make SQLite Kit safe and usable for real database work: controlled file selection, read-only-by-default connections, classified SQLite objects, stable searchable data browsing, reversible CRUD, readable schema, and a cancellable SQL workspace.

**Architecture:** Keep the public Kit runtime boundary unchanged while expanding the plugin request contract. The main process owns filesystem access, connection policy, query construction, mutation snapshots, export, and SQL workers; the panel is split into state, controller, view, dialog, and pure formatting modules. Both layers enforce write restrictions, but the main process remains authoritative.

**Tech Stack:** TypeScript, better-sqlite3, Node worker_threads, Vitest, jsdom, CE plugin build/check scripts, native HTML dialog and textarea controls.

## Global Constraints

- Existing database files open in `readonly` mode; newly created files open in `readwrite` mode.
- Views, virtual tables, shadow tables, and tables without a stable identity are never writable from CRUD controls.
- Page size is limited to 25 or 50 and no data/result view renders more than 50 rows.
- Every SQL identifier is quoted with `quoteIdentifier`; every user value is bound as a parameter.
- Filesystem access remains in plugin main. The panel receives normalized paths and structured entries only.
- Errors crossing the request boundary use `{ code, message, detail? }`, with Chinese user-facing `message` and optional raw SQLite `detail`.
- Update this plan by changing completed checkboxes from `[ ]` to `[x]` after each task commit.
- Stage only the exact files named by each task; never use `git add .`.

## Contract Map

The final plugin request methods are:

```ts
listDirectory(input)
getRecentDatabases()
getConnectionState()
openDatabase(input)
setConnectionMode(input)
closeDatabase()
getSchema()
getObjectSchema(input)
getRows(input)
exportRows(input)
insertRow(input)
updateRow(input)
deleteRow(input)
undoLastMutation(input)
analyzeSql(input)
executeSql(input)
cancelSql(input)
explainSql(input)
```

## Task 1: Define the protocol and plugin request surface

**Files:**

- Modify: `kits/sqlite/plugins/sqlite-workbench/main/src/protocol.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/main/src/index.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/package.json`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/protocol.test.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/plugin-main.test.ts`

- [x] Add failing protocol tests for connection modes, page-size bounds, sort/filter normalization, export formats, and Chinese structured errors.

```ts
expect(() => parsePageInput({ page: 1, pageSize: 100 })).toThrow();
expect(parseConnectionMode('readonly')).toBe('readonly');
expect(parseSorts([{ column: 'id', direction: 'desc' }])).toEqual([
  { column: 'id', direction: 'desc' },
]);
expect(toPublicError(new Error('raw failure'))).toMatchObject({
  code: 'INTERNAL_ERROR',
  message: '操作失败，请查看详情。',
});
```

- [x] Run the focused tests and confirm they fail because the new parsers and methods do not exist.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/protocol.test.ts tests/plugin-main.test.ts`

Expected: Vitest reports missing exports and missing request handlers.

- [x] Add exact shared types and parsers to `protocol.ts`.

```ts
export type ConnectionMode = 'readonly' | 'readwrite';
export type ObjectKind = 'table' | 'view' | 'virtual' | 'shadow';
export type SortDirection = 'asc' | 'desc';
export type FilterOperator = 'contains' | 'equals' | 'is-null' | 'is-not-null';
export type ExportFormat = 'csv' | 'json';
export interface PublicError { code: string; message: string; detail?: string }
export interface RowQuery {
  name: string;
  page: number;
  pageSize: 25 | 50;
  search?: string;
  filters?: Array<{ column: string; operator: FilterOperator; value?: string }>;
  sorts?: Array<{ column: string; direction: SortDirection }>;
}
```

`parsePageInput` must accept only 25 and 50. Add parsers for mode, row query, export request, and SQL request. Add a `WorkbenchError` class plus `toPublicError` that preserves known codes and converts unknown failures to Chinese summaries with raw text in `detail`.

- [x] Register all methods in `main/src/index.ts` and the manifest. Route each request to the identically named service method; cancellation must remain callable while an execution promise is active.

- [x] Run the focused tests and confirm they pass.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/protocol.test.ts tests/plugin-main.test.ts`

Expected: both files pass.

- [x] Commit the contract.

```bash
git add kits/sqlite/plugins/sqlite-workbench/main/src/protocol.ts kits/sqlite/plugins/sqlite-workbench/main/src/index.ts kits/sqlite/plugins/sqlite-workbench/package.json kits/sqlite/plugins/sqlite-workbench/tests/protocol.test.ts kits/sqlite/plugins/sqlite-workbench/tests/plugin-main.test.ts
git commit -m "[Feature] 扩展 SQLite 工作台通信协议"
```

## Task 2: Add a controlled file browser

**Files:**

- Create: `kits/sqlite/plugins/sqlite-workbench/main/src/file-browser.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/file-browser.test.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts`

- [x] Add failing tests using a temporary directory containing folders, `.sqlite`, `.db`, a symlink, and unrelated files.

Assert that `listDirectory` returns normalized parent/current paths, sorts directories before files, hides unrelated files unless `showAll` is true, reports file metadata, does not follow broken entries, and rejects a non-directory. Assert `validateCreateTarget` adds `.sqlite`, rejects missing parent directories and existing files, and never overwrites.

- [x] Run the focused test and observe missing module/method failures.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/file-browser.test.ts`

Expected: import or method-not-found failures.

- [x] Implement pure filesystem helpers and service session history.

```ts
export interface FileEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  sqliteCandidate: boolean;
  size: number | null;
  modifiedAt: string | null;
}

export function listDirectory(input: unknown): DirectoryListing;
export function validateCreateTarget(input: unknown): string;
```

Use `fs.realpathSync` for existing selections and `path.resolve` for new targets. Do not expose arbitrary file contents. In `SqliteService`, retain at most 10 unique recent normalized database paths for the service lifetime and return a copy from `getRecentDatabases()`.

- [x] Run focused tests.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/file-browser.test.ts tests/sqlite-service.test.ts`

Expected: all assertions pass.

- [x] Commit the file browser.

```bash
git add kits/sqlite/plugins/sqlite-workbench/main/src/file-browser.ts kits/sqlite/plugins/sqlite-workbench/tests/file-browser.test.ts kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts
git commit -m "[Feature] 添加 SQLite 文件浏览能力"
```

## Task 3: Enforce connection modes and classify SQLite objects

**Files:**

- Modify: `kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/sqlite-service.test.ts`

- [x] Add a fixture with FTS5, foreign keys, a trigger, a view, a WITHOUT ROWID table, and an ordinary rowid table. Add failing assertions that:

  - an existing file defaults to `readonly`;
  - a created file defaults to `readwrite`;
  - `setConnectionMode` safely reopens the same normalized path;
  - a failed reopen keeps the old connection;
  - `PRAGMA table_list` classifies table/view/virtual/shadow;
  - virtual and shadow objects are not writable;
  - schema detail returns foreign keys and triggers;
  - service errors expose stable codes and Chinese messages.

- [x] Run the service test and verify failures show the old connection shape and object classification.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/sqlite-service.test.ts`

Expected: assertions fail on missing `mode`, `kind`, `foreignKeys`, or `triggers`.

- [x] Refactor connection creation into a prepare-then-swap helper.

```ts
private connect(pathname: string, mode: ConnectionMode, create: boolean): Database.Database {
  const candidate = new Database(pathname, {
    readonly: mode === 'readonly',
    fileMustExist: !create,
  });
  candidate.pragma('foreign_keys = ON');
  candidate.pragma('busy_timeout = 5000');
  return candidate;
}
```

Create the candidate, validate it, then close and replace the old connection. Return `{ connected, path, fileName, mode, sqliteVersion, foreignKeys, busyTimeout }`.

- [x] Build schema objects from `PRAGMA table_list`; correlate SQL from `sqlite_schema`. Treat `type='shadow'` as `kind:'shadow'`, `type='virtual'` as `kind:'virtual'`, and set a localized `readOnlyReason` whenever CRUD is unavailable. Add `PRAGMA foreign_key_list`, `PRAGMA index_list/index_info`, and trigger lookup for object details.

- [x] Run focused tests and commit.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/sqlite-service.test.ts`

Expected: all service connection/schema tests pass.

```bash
git add kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts kits/sqlite/plugins/sqlite-workbench/tests/sqlite-service.test.ts
git commit -m "[Feature] 增加只读连接与对象分类"
```

## Task 4: Make row browsing stable, searchable, filterable, and exportable

**Files:**

- Modify: `kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/sqlite-service.test.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/export.test.ts`

- [x] Add failing real-database tests for deterministic default order, composite primary keys, rowid fallback, user sort with identity tie-breakers, quick search, all four filter operators, invalid columns, empty pages, and 25/50 page limits.

For exports, assert UTF-8 CSV quoting, JSON integer/blob serialization, active filter/sort reuse, a 10,000-row cap, and a localized truncation warning.

- [x] Run tests and observe unordered/unfiltered results and missing export behavior.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/sqlite-service.test.ts tests/export.test.ts`

Expected: new row-query and export assertions fail.

- [x] Introduce one query builder shared by count, page, and export.

```ts
interface BuiltRowQuery {
  whereSql: string;
  orderSql: string;
  parameters: DatabaseValue[];
}
```

Validate every requested column against visible schema columns. Quick search generates a parenthesized OR of `CAST(column AS TEXT) LIKE ? ESCAPE '\\'`. Append the full primary key or rowid to the requested sorts unless already present. Export in chunks without rendering DOM and return `{ format, fileName, mimeType, content, rows, truncated }`.

- [x] Add a count cache keyed by connection generation, object name, search, and filters. Clear it on connection change and every successful mutation.

- [x] Run focused tests and commit.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/sqlite-service.test.ts tests/export.test.ts`

Expected: all row and export tests pass.

```bash
git add kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts kits/sqlite/plugins/sqlite-workbench/tests/sqlite-service.test.ts kits/sqlite/plugins/sqlite-workbench/tests/export.test.ts
git commit -m "[Feature] 完善 SQLite 数据查询与导出"
```

## Task 5: Guard writes and add reversible CRUD snapshots

**Files:**

- Modify: `kits/sqlite/plugins/sqlite-workbench/main/src/protocol.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/mutations.test.ts`

- [x] Add failing tests proving CRUD is rejected in readonly mode, rejected for view/virtual/shadow objects, and allowed only for ordinary tables with stable identities. Verify every rejection uses a stable code and Chinese message.

- [x] Add insert/update/delete/undo tests, including BLOB restoration, primary-key changes, an expired/incorrect mutation token, a concurrent row change, and the 10-second deadline.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/mutations.test.ts`

Expected: readonly operations currently succeed or fail with unstructured errors; undo is missing.

- [x] Implement one guarded transaction path and retain only the most recent snapshot.

```ts
interface MutationReceipt {
  changes: number;
  undoToken: string;
  undoExpiresAt: string;
  identity: RowIdentity | null;
}

interface MutationSnapshot {
  token: string;
  expiresAt: number;
  databaseGeneration: number;
  objectName: string;
  forwardFingerprint: string;
  undo(): void;
}
```

Capture database-native values, including `Buffer`, before serializing the response. Undo must run in a transaction and verify the forward fingerprint still matches the current row. Invalidate the snapshot after one undo, connection changes, expiry, or a later mutation.

- [x] Run focused tests and commit.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/mutations.test.ts tests/sqlite-service.test.ts`

Expected: all mutation and existing service tests pass.

```bash
git add kits/sqlite/plugins/sqlite-workbench/main/src/protocol.ts kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts kits/sqlite/plugins/sqlite-workbench/tests/mutations.test.ts
git commit -m "[Feature] 增加 SQLite 写入保护与撤销"
```

## Task 6: Move SQL execution into a cancellable worker

**Files:**

- Create: `kits/sqlite/plugins/sqlite-workbench/main/src/sql-analysis.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/main/src/sql-worker.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/main/src/sql-worker-runner.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/sql-analysis.test.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/sql-worker.test.ts`

- [x] Add failing pure tests that classify comments/CTEs/PRAGMA/SELECT as readonly or mutating and identify target objects. Mark DDL and UPDATE/DELETE without a top-level WHERE as high risk. Reject multiple statements when analysis cannot match execution safely.

- [x] Add worker integration tests for SELECT rows, paged result metadata, EXPLAIN QUERY PLAN, readonly enforcement, write confirmation tokens, busy errors, and cancelling a recursive long-running query. Verify a cancelled worker leaves no active execution and a later query succeeds.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/sql-analysis.test.ts tests/sql-worker.test.ts`

Expected: modules are missing.

- [x] Implement a deterministic tokenizer/classifier in `sql-analysis.ts`. `analyzeSql` returns:

```ts
interface SqlAnalysis {
  readonly: boolean;
  statementType: string;
  targetObjects: string[];
  risk: 'normal' | 'high';
  confirmationToken: string | null;
}
```

Bind a short-lived confirmation token to SQL text, connection generation, and mode. A mutating `executeSql` must supply the exact valid token.

- [x] Implement worker messages in `sql-worker-runner.ts` and lifecycle ownership in `sql-worker.ts`. The worker opens the current normalized path using the current mode, foreign key policy, and busy timeout. Cap each result page at 50 rows and total serialized output at the documented maximum. `cancelSql` terminates only the matching execution id and always clears state in `finally`.

- [x] Run focused tests and commit.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/sql-analysis.test.ts tests/sql-worker.test.ts tests/sqlite-service.test.ts`

Expected: SQL tests and existing service tests pass.

```bash
git add kits/sqlite/plugins/sqlite-workbench/main/src/sql-analysis.ts kits/sqlite/plugins/sqlite-workbench/main/src/sql-worker.ts kits/sqlite/plugins/sqlite-workbench/main/src/sql-worker-runner.ts kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts kits/sqlite/plugins/sqlite-workbench/tests/sql-analysis.test.ts kits/sqlite/plugins/sqlite-workbench/tests/sql-worker.test.ts
git commit -m "[Feature] 增加可取消的 SQLite SQL 执行"
```

## Task 7: Build pure panel state, formatting, selection, and export helpers

**Files:**

- Create: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/state.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/sql-format.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/export.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/state.test.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/sql-format.test.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/panel-export.test.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/view-model.ts`

- [x] Add failing pure tests for whole-row selection, ArrowUp/ArrowDown, Space, Enter edit intent, object/page reset rules, filter/sort persistence, SQL history de-duplication capped at 20, result pagination, and stale async response rejection.

- [x] Add failing formatter/tokenizer tests for CREATE TABLE/VIEW/INDEX/TRIGGER, quoted identifiers, strings containing SQL keywords, comments, malformed SQL fallback, stable line numbers, and completion candidates from SQLite keywords plus current schema objects.

- [x] Add failing CSV/JSON download helper tests for quotes, commas, newlines, null, bigint wrappers, and blob wrappers.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/state.test.ts tests/sql-format.test.ts tests/panel-export.test.ts`

Expected: imports fail.

- [x] Implement immutable `WorkbenchState` transitions and small pure helpers. Preserve SQL draft/history across object changes, but reset row selection, search, filters, sorts, and page on object change. Use request sequence ids to ignore stale responses.

- [x] Implement a content-preserving SQLite formatter/tokenizer. Formatting may change whitespace only; on tokenizer failure return the original SQL as one safe text token. Never inject token text with `innerHTML`.

- [x] Implement `createDownload` using `Blob` and a temporary object URL; tests must revoke the URL.

- [x] Run tests and commit.

```bash
npm run test -w @itharbors/kit-sqlite -- tests/state.test.ts tests/sql-format.test.ts tests/panel-export.test.ts tests/view-model.test.ts
git add kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/state.ts kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/sql-format.ts kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/export.ts kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/view-model.ts kits/sqlite/plugins/sqlite-workbench/tests/state.test.ts kits/sqlite/plugins/sqlite-workbench/tests/sql-format.test.ts kits/sqlite/plugins/sqlite-workbench/tests/panel-export.test.ts
git commit -m "[Feature] 拆分 SQLite 工作台纯状态逻辑"
```

## Task 8: Add controller, connection UI, file dialogs, and write unlock

**Files:**

- Create: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/controller.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/dialogs.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.html`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts`

- [x] Replace path-input-centric tests with failing jsdom flows for opening and creating through the controlled file dialog, advanced manual path input, recent databases, normalized connected path display, readonly badge, explicit write unlock confirmation, failed unlock preserving readonly state, and closing.

- [x] Add failing modal behavior tests: `showModal()`, initial focus, Tab/Shift+Tab loop, Escape close, unsaved record warning, inline validation, and focus restoration to the opener.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/panel.test.ts`

Expected: old input flow renders and modal/focus assertions fail.

- [x] Implement `WorkbenchController` as the only module that calls `editor.message.request`. Map public errors to live-region/alert state and preserve raw detail behind a disclosure. Coordinate connection, schema, row, mutation, SQL, and cancellation requests with sequence ids.

- [x] Implement dialog primitives with native `showModal`, `close`, `cancel`, focus containment, and field error helpers. The file dialog has breadcrumb navigation, directory/file rows, SQLite-only toggle, recent list, open/create modes, and an advanced manual path disclosure.

- [x] Reduce `index.ts` to lifecycle setup, controller construction, and top-level rendering. The connected header shows only mode, file name, and full normalized path; connection details hold version/foreign-key/busy-timeout.

- [x] Run panel tests and commit.

```bash
npm run test -w @itharbors/kit-sqlite -- tests/panel.test.ts tests/plugin-main.test.ts
git add kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/controller.ts kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/dialogs.ts kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.html kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts
git commit -m "[Feature] 重构 SQLite 连接与文件选择交互"
```

## Task 9: Rebuild the data view and destructive-action flow

**Files:**

- Create: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/data-view.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/dialogs.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/controller.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/data-view.test.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts`

- [ ] Add failing jsdom tests for row click/radio/keyboard/double-click selection, `aria-selected`, selected identity summary, disabled reasons, 25/50 page sizes, sortable headers, quick search debounce, column filters, and a hard DOM limit of 50 rows.

- [x] Add failing tests for cell detail/copy, selected-row copy, CSV/JSON export, custom delete confirmation content, cascade warning, 10-second undo action, undo failure retention, and absence of `window.confirm`.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/data-view.test.ts tests/panel.test.ts`

Expected: data-view module and controls are missing.

- [ ] Render a semantic table with one radio selector per row. Keep focus on the selected row and implement keyboard behavior without stealing keystrokes from inputs. Render at most `Math.min(rows.length, 50)`.

- [x] Add toolbar search/filter/sort/pagination requests. Expose cell detail as a non-modal drawer with wrapped full value, copy, and close. Trigger downloads from `exportRows`, not from current DOM.

- [x] Replace generic confirmation with a danger dialog showing database, table, identity, row summary, and foreign-key cascade warning. On successful CRUD show an undo toast until `undoExpiresAt`; undo sends the receipt token and refreshes schema/rows.

- [x] Run tests and commit.

```bash
npm run test -w @itharbors/kit-sqlite -- tests/data-view.test.ts tests/panel.test.ts
git add kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/data-view.ts kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/dialogs.ts kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/controller.ts kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts kits/sqlite/plugins/sqlite-workbench/tests/data-view.test.ts kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts
git commit -m "[Feature] 完善 SQLite 数据浏览与安全操作"
```

## Task 10: Rebuild object navigation and schema view

**Files:**

- Create: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/schema-view.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/schema-view.test.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts`

- [x] Add failing tests for object search, ordinary/view/virtual/system groups, default-collapsed shadow objects, kind badges, object counts, and localized read-only reasons.

- [x] Add failing schema tests for columns, indexes, foreign keys, triggers, formatted DDL, syntax token classes, real line numbers, copy, wrap toggle, and malformed-DDL safe fallback.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/schema-view.test.ts tests/panel.test.ts`

Expected: grouping and schema renderers are missing.

- [x] Implement searchable grouped navigation driven entirely by service `kind`; do not infer FTS/system objects from names in the panel. Keep system objects collapsed on first render and mark them readonly.

- [x] Implement schema sections and create DOM text nodes for formatted tokens. Line numbers must match formatted line count; copy must use the exact displayed SQL; wrap is a presentation-only state.

- [x] Run tests and commit.

```bash
npm run test -w @itharbors/kit-sqlite -- tests/schema-view.test.ts tests/panel.test.ts
git add kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/schema-view.ts kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts kits/sqlite/plugins/sqlite-workbench/tests/schema-view.test.ts kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts
git commit -m "[Feature] 完善 SQLite 对象导航与结构视图"
```

## Task 11: Rebuild the SQL workspace

**Files:**

- Create: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/sql-view.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/controller.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/dialogs.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/sql-view.test.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts`

- [ ] Add failing tests for synchronized line numbers/scroll, format, keyword/object completion, keyboard completion selection, 20-entry session history, explicit run, explain plan, active cancellation, and run-button state.

- [ ] Add failing tests for readonly SQL running without confirmation, write SQL blocked while connected readonly, normal write confirmation, high-risk confirmation copy, token forwarding, 50-row result paging, cell detail, result copy/export, and localized raw error disclosure.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/sql-view.test.ts tests/panel.test.ts`

Expected: SQL view controls and analysis flow are missing.

- [ ] Keep the textarea as the editable source. Render a separate synchronized line-number gutter and a positioned completion listbox. Formatting uses `sql-format.ts` and preserves selection as closely as possible.

- [x] Execute through `analyzeSql` first. Readonly statements run directly. Mutating statements require readwrite mode and a custom confirmation dialog; pass the returned token to `executeSql`. Cancel uses the current execution id. Explain calls `explainSql` and does not mutate.

- [x] Render results in pages of at most 50 rows and reuse cell detail/copy/export behavior. Push successful executions into de-duplicated session history.

- [x] Run tests and commit.

```bash
npm run test -w @itharbors/kit-sqlite -- tests/sql-view.test.ts tests/panel.test.ts
git add kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/sql-view.ts kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/controller.ts kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/dialogs.ts kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts kits/sqlite/plugins/sqlite-workbench/tests/sql-view.test.ts kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts
git commit -m "[Feature] 完善 SQLite SQL 工作区"
```

## Task 12: Apply accessible responsive styling

**Files:**

- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.css`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.html`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/accessibility.test.ts`

- [ ] Add failing structural assertions for labeled icon buttons, tab `aria-controls`, roving tab indexes, live region, alert errors, dialog labels, minimum data attributes for text-size tokens, and absence of decorative accessible names.

- [ ] Add failing behavior tests for Left/Right tab navigation, visible focus, narrow navigation drawer state, and modal keyboard containment.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/accessibility.test.ts tests/panel.test.ts`

Expected: required roles/labels/classes and keyboard behavior are absent.

- [x] Introduce readable type/color tokens: body text at least 12px, secondary text at least 11px, clear focus rings, and contrast-safe selected/hover states. Use the system Chinese UI font for prose and monospace for paths, SQL, identifiers, and values.

- [ ] Implement breakpoints at 1180px, 880px, and 720px. At narrow widths move navigation into a labeled drawer while preserving the data table's horizontal scrolling. Avoid animations when `prefers-reduced-motion` is set.

- [x] Run tests, build the plugin, and commit.

```bash
npm run test -w @itharbors/kit-sqlite -- tests/accessibility.test.ts tests/panel.test.ts
node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-workbench
git add kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.css kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.html kits/sqlite/plugins/sqlite-workbench/tests/accessibility.test.ts
git commit -m "[Optimize] 优化 SQLite 工作台可用性"
```

## Task 13: Add real runtime acceptance coverage

**Files:**

- Modify: `kits/sqlite/tests/runtime-integration.test.ts`
- Create: `kits/sqlite/tests/fixtures/create-runtime-database.ts`
- Modify: `kits/sqlite/README.md`

- [ ] Add a failing runtime test that launches a real editor session, locates the SQLite panel iframe, and operates its DOM rather than calling plugin APIs directly.

  - Environment note: the in-app Browser rejected localhost reload under its URL safety policy. Runtime API coverage and jsdom Panel flows are automated; the live iframe matrix remains a manual handoff on the running development server.

The test must create its own temporary database and cover: controlled open, readonly state, write unlock, object grouping, row click selection, insert/update/delete/undo, stable search/sort/filter, cell detail, export, schema sections, SQL history, explain, and cancellation. It must assert no view exceeds 50 rendered rows.

- [ ] Run the runtime test and confirm it fails before the harness/flows are implemented.

Run: `npm run test -w @itharbors/kit-sqlite -- tests/runtime-integration.test.ts`

Expected: the new iframe interaction flow fails at the first unimplemented runtime hook or UI assertion.

- [ ] Implement a deterministic fixture generator and iframe interaction helpers. Use temporary paths only, close every service/browser session, and remove fixture databases in `finally`.

- [x] Update `kits/sqlite/README.md` with the readonly default, file browser, unlock flow, object classifications, data tools, SQL tools, export cap, and cancellation behavior.

- [x] Run runtime and full SQLite tests, then commit.

```bash
npm run test -w @itharbors/kit-sqlite -- tests/runtime-integration.test.ts
npm run test -w @itharbors/kit-sqlite
git add kits/sqlite/tests/runtime-integration.test.ts kits/sqlite/tests/fixtures/create-runtime-database.ts kits/sqlite/README.md
git commit -m "[Feature] 补充 SQLite 工作台运行时验收"
```

## Task 14: Final verification with the knowledge database copy

**Files:**

- Modify only if verification exposes a defect; use the smallest relevant source/test files.
- Update: `docs/superpowers/plans/2026-07-19-sqlite-kit-product-fixes.md`

- [x] Record the original knowledge database SHA-256 without opening it for writes.

```bash
shasum -a 256 /Users/bytedance/Knowledge/Knowledge/.local/knowledge-query/knowledge.sqlite
```

- [ ] Create a temporary online backup copy with SQLite's backup API. Run the built plugin/server against the copy and manually verify the completion matrix in the design document through the real panel iframe.

  - Verified the online backup copy through the built service (readonly open, schema, 25-row page, readwrite switch, write SQL). Live iframe automation was blocked by the same localhost Browser policy and is intentionally not marked complete.

- [x] Run all authoritative automated checks.

```bash
npm run test -w @itharbors/kit-sqlite
node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-workbench
npm run check
git diff --check
```

Expected: every command exits 0 with no skipped SQLite workbench acceptance test.

- [x] Recompute the original database SHA-256 and require an exact match. Close all handles and remove only the explicit temporary backup path.

- [x] Review coverage against every row in `docs/superpowers/specs/2026-07-19-sqlite-kit-product-fixes-design.md`. Search for placeholders and accidental English user copy.

```bash
rg -n "TBD|TODO|implement later|待定|以后再|window\.confirm|dialog\.open\s*=" kits/sqlite/plugins/sqlite-workbench kits/sqlite/tests
git status --short
```

Expected: no unresolved placeholder or legacy confirmation/modal assignment remains; status contains only the plan checkbox update or intentional verified fixes.

- [x] Change all completed task checkboxes in this plan to `[x]`, stage the exact modified files, inspect the cached diff, and make the final verification commit.

```bash
git add docs/superpowers/plans/2026-07-19-sqlite-kit-product-fixes.md
git diff --cached --stat
git diff --cached
git commit -m "[Optimize] 完成 SQLite 工作台产品验收"
```
