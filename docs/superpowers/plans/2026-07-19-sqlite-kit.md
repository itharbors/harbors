# SQLite Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone SQLite Kit that opens or creates a local database, previews schema and paginated rows, performs record CRUD, and executes explicit SQL.

**Architecture:** Add one kit-scoped `@itharbors/sqlite-workbench` plugin. Its server-side main owns a focused `SqliteService` backed by the repository's existing `better-sqlite3` dependency; its browser panel owns all workbench state and calls typed plugin requests. Keep SQLite values JSON-safe through a shared protocol module and keep generated writes parameterized and transactional.

**Tech Stack:** TypeScript, `better-sqlite3`, CE Editor kit/plugin runtime, DOM APIs, CSS, Vitest, jsdom.

## Global Constraints

- Support one local database connection per editor session.
- Existing files must be regular SQLite database files; creation must be explicit and must not overwrite an existing path.
- Default page size is 100; supported sizes are 25, 50, 100, and 250; 250 is the hard maximum.
- Views are read-only. Tables use all primary-key columns as identity, falling back to `rowid` only when the table supports it.
- BLOB values are preview-only summaries in the first version.
- Generated INSERT, UPDATE, and DELETE statements use bound values and transactions; DELETE requires browser confirmation.
- SQL runs only after an explicit user action and returns either a bounded result set or a mutation summary.
- Do not add generic SQLite HTTP routes or modify shared editor runtime contracts.

---

## File Structure

- `kits/sqlite/package.json`: kit manifest plus isolated test script.
- `kits/sqlite/layout.json`: one full-window workbench panel.
- `kits/sqlite/main.html`: standard main editor entry.
- `kits/sqlite/secondary.html`: standard secondary-window entry.
- `kits/sqlite/vitest.config.ts`: Node and jsdom test projects for the kit.
- `kits/sqlite/tests/kit-manifest.test.ts`: manifest/layout acceptance tests.
- `kits/sqlite/plugins/sqlite-workbench/package.json`: plugin contributions and request allowlist.
- `kits/sqlite/plugins/sqlite-workbench/main/src/protocol.ts`: request/response types, input parsing, SQLite value serialization.
- `kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts`: connection, schema, rows, CRUD, and SQL execution.
- `kits/sqlite/plugins/sqlite-workbench/main/src/index.ts`: thin plugin lifecycle and method bridge.
- `kits/sqlite/plugins/sqlite-workbench/tests/protocol.test.ts`: protocol and value conversion tests.
- `kits/sqlite/plugins/sqlite-workbench/tests/sqlite-service.test.ts`: real temporary-database service tests.
- `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.html`: panel document shell.
- `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/view-model.ts`: browser-only input conversion and display helpers.
- `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts`: panel state, rendering, and event handling.
- `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.css`: responsive workbench styling.
- `kits/sqlite/plugins/sqlite-workbench/tests/view-model.test.ts`: browser helper tests.
- `kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts`: mounted panel interaction tests.
- `package.json`: include SQLite Kit tests in the repository test gate.
- `docs/guides/developing-plugins-and-kits.md`: document how to run the SQLite Kit.

### Task 1: Kit and plugin contract

**Files:**
- Create: `kits/sqlite/package.json`
- Create: `kits/sqlite/layout.json`
- Create: `kits/sqlite/main.html`
- Create: `kits/sqlite/secondary.html`
- Create: `kits/sqlite/vitest.config.ts`
- Create: `kits/sqlite/tests/kit-manifest.test.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/package.json`

**Interfaces:**
- Consumes: existing kit manifest and layout conventions documented in `docs/guides/developing-plugins-and-kits.md`.
- Produces: kit name `@itharbors/kit-sqlite`, plugin name `@itharbors/sqlite-workbench`, panel name `@itharbors/sqlite-workbench.workbench`, and request names used by all later tasks.

- [ ] **Step 1: Write the failing manifest test**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));

describe('SQLite kit manifest', () => {
  it('declares the workbench plugin and one active panel', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(kitRoot, 'package.json'), 'utf8'));
    const layout = JSON.parse(fs.readFileSync(path.join(kitRoot, 'layout.json'), 'utf8'));
    expect(pkg.name).toBe('@itharbors/kit-sqlite');
    expect(pkg['ce-editor'].kit.plugin).toEqual(['@itharbors/sqlite-workbench']);
    expect(layout.windows[0].layout.panel).toBe('@itharbors/sqlite-workbench.workbench');
    expect(layout.activePanel).toBe('@itharbors/sqlite-workbench.workbench');
  });
});
```

- [ ] **Step 2: Run the test and verify the missing kit fails**

Run: `npx vitest run kits/sqlite/tests/kit-manifest.test.ts`

Expected: FAIL because `kits/sqlite/package.json` does not exist.

- [ ] **Step 3: Add the kit and plugin manifests**

Create a kit manifest with this exact contribution contract:

```json
{
  "name": "@itharbors/kit-sqlite",
  "version": "0.0.1",
  "private": true,
  "scripts": { "test": "vitest run --config vitest.config.ts" },
  "ce-editor": {
    "kit": {
      "layouts": { "default": "layout.json" },
      "windowEntries": { "main": "main.html", "secondary": "secondary.html" },
      "plugin": ["@itharbors/sqlite-workbench"],
      "theme": { "--ce-accent": "#56b6a9" }
    }
  }
}
```

The plugin manifest must declare `main: "./main/dist/index.js"`, `better-sqlite3: "^11.0.0"` in `dependencies`, the `workbench` panel at `./panel.workbench/dist/index.html`, and these request-to-method mappings with identical names: `getConnectionState`, `openDatabase`, `closeDatabase`, `getSchema`, `getObjectSchema`, `getRows`, `insertRow`, `updateRow`, `deleteRow`, and `executeSql`.

Use a leaf layout:

```json
{
  "windows": [{
    "id": "sqlite-main",
    "kind": "main",
    "type": "panel-area",
    "layout": { "type": "leaf", "panel": "@itharbors/sqlite-workbench.workbench" }
  }],
  "activePanel": "@itharbors/sqlite-workbench.workbench"
}
```

Copy the semantic structure of `kits/default/main.html` and `secondary.html`, changing only titles to `SQLite Workbench` and `SQLite Workbench Window`. Configure Vitest with `include: ['tests/**/*.test.ts', 'plugins/**/tests/**/*.test.ts']` and default Node environment; individual panel test files use `// @vitest-environment jsdom`.

- [ ] **Step 4: Run the manifest test and plugin manifest validator**

Run: `npx vitest run kits/sqlite/tests/kit-manifest.test.ts && node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-workbench`

Expected: manifest test PASS; plugin check FAIL only because build outputs do not exist yet.

- [ ] **Step 5: Commit the contract**

```bash
git add kits/sqlite
git commit -m "功能：搭建 SQLite Kit 结构"
```

### Task 2: JSON-safe SQLite protocol

**Files:**
- Create: `kits/sqlite/plugins/sqlite-workbench/main/src/protocol.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/protocol.test.ts`

**Interfaces:**
- Consumes: no runtime state.
- Produces: `SerializedValue`, `EditableValue`, `serializeValue(value)`, `deserializeEditableValue(value)`, `parsePageInput(input)`, and `quoteIdentifier(name)` for `SqliteService` and the panel.

- [ ] **Step 1: Write failing protocol tests**

```ts
import { describe, expect, it } from 'vitest';
import { deserializeEditableValue, parsePageInput, quoteIdentifier, serializeValue } from '../main/src/protocol';

describe('SQLite protocol', () => {
  it('serializes big integers and blobs without JSON data loss', () => {
    expect(serializeValue(9007199254740993n)).toEqual({ type: 'integer', value: '9007199254740993' });
    expect(serializeValue(Buffer.from([0, 1, 254, 255]))).toEqual({ type: 'blob', size: 4, previewHex: '0001feff' });
  });

  it('decodes explicit editable types', () => {
    expect(deserializeEditableValue({ type: 'null' })).toBeNull();
    expect(deserializeEditableValue({ type: 'integer', value: '42' })).toBe(42n);
    expect(deserializeEditableValue({ type: 'real', value: '4.25' })).toBe(4.25);
    expect(deserializeEditableValue({ type: 'text', value: '0042' })).toBe('0042');
  });

  it('validates pagination and quotes identifiers', () => {
    expect(parsePageInput({ page: 2, pageSize: 50 })).toEqual({ page: 2, pageSize: 50, offset: 50 });
    expect(() => parsePageInput({ page: 0, pageSize: 50 })).toThrow(/page/);
    expect(() => parsePageInput({ page: 1, pageSize: 500 })).toThrow(/pageSize/);
    expect(quoteIdentifier('odd"name')).toBe('"odd""name"');
  });
});
```

- [ ] **Step 2: Verify protocol tests fail**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/protocol.test.ts`

Expected: FAIL because `protocol.ts` is missing.

- [ ] **Step 3: Implement the protocol module**

Define discriminated unions exactly as follows:

```ts
export type SerializedValue = null | string | number |
  { type: 'integer'; value: string } |
  { type: 'blob'; size: number; previewHex: string };

export type EditableValue =
  { type: 'null' } |
  { type: 'integer'; value: string } |
  { type: 'real'; value: string } |
  { type: 'text'; value: string };

export function quoteIdentifier(name: string): string {
  if (typeof name !== 'string' || name.length === 0) throw new Error('identifier must be a non-empty string');
  return `"${name.replaceAll('"', '""')}"`;
}

export function serializeValue(value: unknown): SerializedValue {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SQLite returned a non-finite number');
    return value;
  }
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  if (Buffer.isBuffer(value)) {
    return { type: 'blob', size: value.length, previewHex: value.subarray(0, 16).toString('hex') };
  }
  throw new Error(`Unsupported SQLite value: ${typeof value}`);
}
```

`deserializeEditableValue` must validate integer strings with `/^[+-]?\d+$/`, validate real values with `Number.isFinite`, and return `bigint`, `number`, `string`, or `null`. `parsePageInput` accepts only integer pages `>= 1` and page sizes from `[25, 50, 100, 250]`, returning zero-based `offset`.

- [ ] **Step 4: Run protocol tests**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/protocol.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit protocol behavior**

```bash
git add kits/sqlite/plugins/sqlite-workbench/main/src/protocol.ts kits/sqlite/plugins/sqlite-workbench/tests/protocol.test.ts
git commit -m "功能：定义 SQLite 数据协议"
```

### Task 3: Connection and schema service

**Files:**
- Create: `kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/sqlite-service.test.ts`

**Interfaces:**
- Consumes: `quoteIdentifier` and serialized protocol types from Task 2.
- Produces: class `SqliteService` with `getConnectionState()`, `openDatabase(input)`, `closeDatabase()`, `getSchema()`, `getObjectSchema(input)`, and `dispose()`.

- [ ] **Step 1: Write failing connection and schema tests**

Use `fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-kit-'))` and a real `Database` fixture. Cover:

```ts
it('opens a database and returns tables, views, columns, primary keys, and indexes', () => {
  fixture.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, score REAL DEFAULT 0);
    CREATE VIEW active_users AS SELECT id, email FROM users WHERE score > 0;
    CREATE INDEX users_score_idx ON users(score);
  `);
  service.openDatabase({ path: dbPath, create: false });
  expect(service.getSchema().objects.map((item) => [item.name, item.type])).toEqual([
    ['active_users', 'view'], ['users', 'table'],
  ]);
  const schema = service.getObjectSchema({ name: 'users' });
  expect(schema.primaryKey).toEqual(['id']);
  expect(schema.columns).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'email', type: 'TEXT', notNull: true }),
  ]));
  expect(schema.indexes.map((index) => index.name)).toContain('users_score_idx');
});

it('creates only when requested and preserves the old connection on failed switch', () => {
  service.openDatabase({ path: dbPath, create: false });
  const newPath = path.join(tempDir, 'new.sqlite');
  expect(() => service.openDatabase({ path: newPath, create: false })).toThrow(/does not exist/);
  expect(service.getConnectionState().path).toBe(path.resolve(dbPath));
  service.openDatabase({ path: newPath, create: true });
  expect(fs.existsSync(newPath)).toBe(true);
});
```

Also assert directory paths and a text file are rejected, `closeDatabase()` is idempotent, views report `writable: false`, and `WITHOUT ROWID` is detected from definition SQL.

- [ ] **Step 2: Verify service tests fail**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/sqlite-service.test.ts`

Expected: FAIL because `SqliteService` is missing.

- [ ] **Step 3: Implement connection lifecycle and schema queries**

`openDatabase` must:

```ts
const absolutePath = path.resolve(requireNonEmptyString(input.path, 'path'));
const exists = fs.existsSync(absolutePath);
if (input.create) {
  if (exists) throw workbenchError('PATH_EXISTS', `Database already exists: ${absolutePath}`);
  const parent = path.dirname(absolutePath);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw workbenchError('INVALID_PATH', `Parent directory does not exist: ${parent}`);
  }
} else if (!exists || !fs.statSync(absolutePath).isFile()) {
  throw workbenchError('INVALID_PATH', `Database file does not exist or is not a file: ${absolutePath}`);
}

const candidate = new Database(absolutePath);
try {
  candidate.pragma('schema_version', { simple: true });
  candidate.pragma('foreign_keys = ON');
  candidate.pragma('busy_timeout = 5000');
  candidate.defaultSafeIntegers(true);
} catch (error) {
  candidate.close();
  if (input.create) fs.rmSync(absolutePath, { force: true });
  throw normalizeSqliteError(error);
}
const previous = this.database;
this.database = candidate;
this.databasePath = absolutePath;
previous?.close();
```

Query `sqlite_schema` for non-internal tables/views ordered by name. Use `PRAGMA table_xinfo`, `index_list`, and `index_info`; normalize numeric SQLite flags to booleans and sort primary-key fields by their `pk` ordinal. Determine rowid support only for tables without `WITHOUT ROWID`. All public methods must call a private `requireDatabase()` and use `workbenchError(code, message)` so messages include `[CODE]`.

- [ ] **Step 4: Run connection and schema tests**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/sqlite-service.test.ts`

Expected: PASS for lifecycle and schema tests.

- [ ] **Step 5: Commit schema service**

```bash
git add kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts kits/sqlite/plugins/sqlite-workbench/tests/sqlite-service.test.ts
git commit -m "功能：支持 SQLite 连接与结构读取"
```

### Task 4: Paginated rows and transactional record CRUD

**Files:**
- Modify: `kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/sqlite-service.test.ts`

**Interfaces:**
- Consumes: `SqliteService` connection/schema methods, `EditableValue`, `serializeValue`, `deserializeEditableValue`, `parsePageInput`, and `quoteIdentifier`.
- Produces: `getRows`, `insertRow`, `updateRow`, and `deleteRow` with stable `RowIdentity` values.

- [ ] **Step 1: Add failing pagination and identity tests**

Add fixtures for a normal primary key, composite primary key, rowid table, `WITHOUT ROWID` table, empty table, view, large integer, NULL, text, real, and BLOB. Assert the response shape:

```ts
expect(service.getRows({ name: 'users', page: 1, pageSize: 25 })).toMatchObject({
  page: 1,
  pageSize: 25,
  total: 2,
  writable: true,
  columns: ['id', 'email', 'payload'],
  rows: [
    {
      values: [expect.anything(), 'a@example.com', { type: 'blob', size: 2, previewHex: '00ff' }],
      identity: { kind: 'primary-key', values: { id: expect.anything() } },
    },
  ],
});
```

Assert composite identities contain both key columns, a table without a primary key returns `{ kind: 'rowid', value: ... }`, and a view has `writable: false` with `identity: null`.

- [ ] **Step 2: Verify row tests fail**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/sqlite-service.test.ts`

Expected: FAIL because row methods are not implemented.

- [ ] **Step 3: Implement bounded row reads**

Use schema metadata to choose identity. For rowid tables without a primary key, choose an alias not present in the schema by repeatedly prefixing `_ce_rowid`; select it as `rowid AS <quoted alias>, *`, remove it from display values, and store it in the identity. For other objects select `*`. Use:

```ts
const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).pluck().get());
const records = database.prepare(
  `SELECT ${projection} FROM ${quoteIdentifier(name)} LIMIT ? OFFSET ?`,
).all(BigInt(pageSize), BigInt(offset));
```

Serialize every returned cell. Return schema column order, even for an empty table.

- [ ] **Step 4: Add failing CRUD tests**

```ts
const inserted = service.insertRow({
  name: 'users',
  values: { email: { type: 'text', value: 'new@example.com' }, score: { type: 'real', value: '3.5' } },
});
expect(inserted.changes).toBe(1);

const row = service.getRows({ name: 'users', page: 1, pageSize: 25 }).rows.at(-1)!;
expect(service.updateRow({
  name: 'users',
  identity: row.identity,
  values: { email: { type: 'text', value: 'changed@example.com' } },
}).changes).toBe(1);
expect(service.deleteRow({ name: 'users', identity: row.identity }).changes).toBe(1);
```

Also assert default-only inserts work, unknown/generated columns are rejected, views reject writes, BLOB fields cannot be submitted, constraint failures leave data unchanged, composite identities work, rowid identities work, and deleting the same identity twice throws `[STALE_ROW]`.

- [ ] **Step 5: Implement parameterized transactional writes**

Validate submitted columns against `table_xinfo`; allow non-hidden columns and omit absent columns so SQLite defaults apply. Generate `INSERT INTO <table> DEFAULT VALUES` for an empty values object, otherwise create quoted columns and positional `?` placeholders. For updates require at least one submitted field.

Build identity WHERE clauses only from service-issued shapes:

```ts
if (identity.kind === 'primary-key') {
  const names = schema.primaryKey;
  return {
    sql: names.map((name) => `${quoteIdentifier(name)} IS ?`).join(' AND '),
    params: names.map((name) => deserializeIdentityValue(identity.values[name])),
  };
}
if (identity.kind === 'rowid' && schema.hasRowid) {
  return { sql: 'rowid IS ?', params: [deserializeIdentityValue(identity.value)] };
}
throw workbenchError('INVALID_IDENTITY', 'The row does not have a writable identity');
```

Wrap each generated write in `database.transaction(() => ...)()`. Require exactly one changed row for update/delete; otherwise throw `[STALE_ROW]` inside the transaction. Normalize SQLite constraint and lock errors without exposing stack traces to the panel.

- [ ] **Step 6: Run the complete service test**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/sqlite-service.test.ts`

Expected: PASS for schema, pagination, identity, CRUD, constraint, and stale-row cases.

- [ ] **Step 7: Commit row operations**

```bash
git add kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts kits/sqlite/plugins/sqlite-workbench/tests/sqlite-service.test.ts
git commit -m "功能：实现 SQLite 记录增删改查"
```

### Task 5: SQL execution and plugin lifecycle bridge

**Files:**
- Modify: `kits/sqlite/plugins/sqlite-workbench/main/src/sqlite-service.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/sqlite-service.test.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/main/src/index.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/plugin-main.test.ts`

**Interfaces:**
- Consumes: all `SqliteService` public methods.
- Produces: `executeSql({ sql })` and an editor plugin definition whose request methods have the exact names declared in Task 1.

- [ ] **Step 1: Add failing SQL execution tests**

```ts
expect(service.executeSql({ sql: 'SELECT id, email FROM users ORDER BY id' })).toMatchObject({
  kind: 'rows',
  columns: ['id', 'email'],
  truncated: false,
});
expect(service.executeSql({ sql: "UPDATE users SET score = 9 WHERE email = 'a@example.com'" }))
  .toMatchObject({ kind: 'mutation', changes: 1 });
expect(service.executeSql({ sql: 'CREATE TABLE audit (id INTEGER)' }))
  .toMatchObject({ kind: 'mutation', changes: 0 });
expect(() => service.executeSql({ sql: '' })).toThrow(/SQL/);
expect(() => service.executeSql({ sql: 'SELECT FROM' })).toThrow(/SQLITE_ERROR/);
```

Insert 501 rows and assert a query returns 500 rows with `truncated: true`. Assert a multi-statement string is rejected with `[MULTIPLE_STATEMENTS]` so execution remains explicit and result semantics stay unambiguous.

- [ ] **Step 2: Verify SQL tests fail**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/sqlite-service.test.ts`

Expected: FAIL because `executeSql` is missing.

- [ ] **Step 3: Implement bounded single-statement SQL execution**

Trim and validate the SQL string, prepare exactly one statement, and reject SQLite's trailing-statement error as `[MULTIPLE_STATEMENTS]`. For `statement.reader`, iterate up to 501 rows, return the first 500 serialized records, `statement.columns().map(column => column.name)`, and `truncated`. For a mutation, call `run()` and return serialized `lastInsertRowid`, `changes`, and elapsed milliseconds. Include elapsed milliseconds for both response kinds.

- [ ] **Step 4: Write the failing plugin bridge test**

Stub `globalThis.editor.plugin.define`, import `main/src/index.ts` with a cache-busting query, capture the definition, call `lifecycle.load`, and verify every method delegates to one service instance. Then call `lifecycle.unload` twice and verify subsequent service calls report not connected rather than throwing from a double close.

- [ ] **Step 5: Implement the thin plugin bridge**

```ts
declare const editor: any;
import { SqliteService } from './sqlite-service.js';

const service = new SqliteService();

editor.plugin.define({
  lifecycle: {
    unload() { service.dispose(); },
  },
  methods: {
    getConnectionState: () => service.getConnectionState(),
    openDatabase: (input: unknown) => service.openDatabase(input),
    closeDatabase: () => service.closeDatabase(),
    getSchema: () => service.getSchema(),
    getObjectSchema: (input: unknown) => service.getObjectSchema(input),
    getRows: (input: unknown) => service.getRows(input),
    insertRow: (input: unknown) => service.insertRow(input),
    updateRow: (input: unknown) => service.updateRow(input),
    deleteRow: (input: unknown) => service.deleteRow(input),
    executeSql: (input: unknown) => service.executeSql(input),
  },
});
```

- [ ] **Step 6: Run service and plugin bridge tests**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/sqlite-service.test.ts plugins/sqlite-workbench/tests/plugin-main.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit SQL and plugin runtime**

```bash
git add kits/sqlite/plugins/sqlite-workbench/main kits/sqlite/plugins/sqlite-workbench/tests
git commit -m "功能：接入 SQLite SQL 控制台服务"
```

### Task 6: Browser value model and complete workbench panel

**Files:**
- Create: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.html`
- Create: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/view-model.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.css`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/view-model.test.ts`
- Create: `kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts`

**Interfaces:**
- Consumes: plugin requests from Task 1 and response/value shapes from Tasks 2–5.
- Produces: default `PanelDefinition` mounted into `#panel-root`, plus pure `formatValue`, `editableValueFromInput`, and `createRecordDraft` browser helpers.

- [ ] **Step 1: Write failing view-model tests**

```ts
import { describe, expect, it } from 'vitest';
import { editableValueFromInput, formatValue } from '../panel.workbench/src/view-model';

it('formats protocol values without losing type cues', () => {
  expect(formatValue(null)).toBe('NULL');
  expect(formatValue({ type: 'integer', value: '9007199254740993' })).toBe('9007199254740993');
  expect(formatValue({ type: 'blob', size: 12, previewHex: '00ff' })).toBe('BLOB · 12 B · 00ff…');
});

it('keeps NULL, text, integer, and real form values explicit', () => {
  expect(editableValueFromInput('null', '')).toEqual({ type: 'null' });
  expect(editableValueFromInput('text', '0042')).toEqual({ type: 'text', value: '0042' });
  expect(() => editableValueFromInput('integer', '4.2')).toThrow(/integer/);
});
```

- [ ] **Step 2: Verify view-model tests fail**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/view-model.test.ts`

Expected: FAIL because `view-model.ts` is missing.

- [ ] **Step 3: Implement browser value helpers**

Use structural protocol types that do not import Node-only code. `formatValue` must distinguish NULL, BLOB, large integer, string, and number. `editableValueFromInput` performs the same lexical integer and finite-real validation as the server, returning explicit editable unions. `createRecordDraft(columns, row?)` must omit hidden/generated/BLOB columns and preserve NULL separately from an empty string.

- [ ] **Step 4: Write failing mounted panel tests**

Use `// @vitest-environment jsdom`, install `<div id="panel-root"></div>`, and mock `ctx.message.request`. Cover these observable flows:

```ts
await definition.mount(ctx);
expect(root.querySelector('[data-state="disconnected"]')).not.toBeNull();

pathInput.value = dbPath;
openButton.click();
await flushPromises();
expect(request).toHaveBeenCalledWith('@itharbors/sqlite-workbench', 'openDatabase', { path: dbPath, create: false });
expect(root.querySelectorAll('[data-object-name]')).toHaveLength(2);

tableButton.click();
await flushPromises();
expect(request).toHaveBeenCalledWith('@itharbors/sqlite-workbench', 'getRows', { name: 'users', page: 1, pageSize: 100 });
expect(root.querySelector('table')?.textContent).toContain('a@example.com');
```

Additional tests must switch data/schema/SQL tabs, paginate, refresh, open add/edit forms, submit explicit typed values, keep form input after a rejected request, disable writes for views, call `window.confirm` before delete, execute SQL only on button click or Ctrl/Cmd+Enter, and render both row results and mutation summaries.

- [ ] **Step 5: Verify mounted panel tests fail**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/panel.test.ts`

Expected: FAIL because the panel is missing.

- [ ] **Step 6: Implement semantic panel markup and state machine**

The HTML shell contains only metadata, the stylesheet link, and `<div id="panel-root"></div>`. In `index.ts`, keep a single state object with connection, schema objects, selected object, active tab, page, page size, row result, object schema, SQL text/result, dialog draft, busy flag, and status. Request helpers must set/clear busy and show errors without clearing path, form, or SQL text.

Render with DOM creation and `textContent`, never interpolate database values into `innerHTML`. Required accessible controls and test hooks:

- connection `<form>` with `aria-label="Database path"`, `[data-action="open"]`, `[data-action="create"]`, refresh, and close;
- navigation buttons carrying `[data-object-name]` and type badges;
- tabs with `role="tablist"`, `role="tab"`, `aria-selected`, and data/schema/sql action values;
- table with sticky headers, selected-row state, empty state, previous/next buttons, and page-size select;
- `<dialog>` record form with per-field type select, value input, NULL option, submit, and cancel;
- SQL `<textarea aria-label="SQL">`, execute button, bounded-result notice, mutation summary, and elapsed time;
- `role="status"` footer and `role="alert"` error content.

On open/create success call `getSchema`, select the first table or first view, then load the active tab. After CRUD or SQL mutations refresh schema and the selected object's active data/schema content. `unmount()` removes listeners by replacing/clearing the root and drops context references.

- [ ] **Step 7: Implement responsive visual styling**

Use a dark workbench palette driven by `--ce-*` fallbacks, a 250px object rail, compact 32–36px controls, tabular numbers, sticky table header, visible keyboard focus, `prefers-reduced-motion`, and a breakpoint below 720px that stacks the navigation above the workspace. Distinguish destructive buttons, selected rows, NULL, BLOB, errors, and read-only views without relying on color alone.

- [ ] **Step 8: Run all panel tests and build the plugin**

Run: `npm test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/view-model.test.ts plugins/sqlite-workbench/tests/panel.test.ts && node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-workbench && node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-workbench`

Expected: all tests PASS; build and check exit 0 and produce main/panel dist entries.

- [ ] **Step 9: Commit the workbench**

```bash
git add kits/sqlite/plugins/sqlite-workbench
git commit -m "功能：实现 SQLite 可视化工作台"
```

### Task 7: Repository gates, documentation, and runtime smoke test

**Files:**
- Modify: `package.json`
- Modify: `docs/guides/developing-plugins-and-kits.md`
- Modify as required by failures: files created in Tasks 1–6 only.

**Interfaces:**
- Consumes: completed SQLite Kit.
- Produces: root test coverage, operator documentation, and final verification evidence.

- [ ] **Step 1: Add the failing root-gate assertion**

Extend `kits/sqlite/tests/kit-manifest.test.ts` to load the root package manifest and assert:

```ts
expect(rootPackage.scripts.test).toContain('npm run test -w @itharbors/kit-sqlite');
```

- [ ] **Step 2: Verify the root-gate assertion fails**

Run: `npm test -w @itharbors/kit-sqlite -- --run tests/kit-manifest.test.ts`

Expected: FAIL because the root `test` script does not yet invoke the kit workspace.

- [ ] **Step 3: Add SQLite tests to the repository gate and document usage**

Append `&& npm run test -w @itharbors/kit-sqlite` to the root `test` script. Add a “SQLite Kit” section to `docs/guides/developing-plugins-and-kits.md` containing these exact commands:

```bash
node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-workbench
npm run dev -- --kit ./kits/sqlite
```

Document that users enter an absolute/local database path, explicitly choose create for a missing file, views are read-only, BLOB is preview-only, and the SQL console accepts one statement per execution.

- [ ] **Step 4: Run focused and full automated verification**

Run:

```bash
npm test -w @itharbors/kit-sqlite
node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-workbench
node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-workbench
npm run check
```

Expected: every command exits 0; the full gate covers server, client, SQLite Kit, and all plugin build outputs.

- [ ] **Step 5: Perform a real CRUD smoke test through the built service and runtime resolver**

Create a temporary SQLite database through a test-only Node/tsx command, load `@itharbors/kit-sqlite` with the existing editor integration harness, and assert:

```text
kit current: @itharbors/kit-sqlite
plugin loaded: @itharbors/sqlite-workbench
schema contains: smoke_items
insert changes: 1
update changes: 1
delete changes: 1
remaining rows: 0
```

Use a `mktemp -d` path and remove only that explicit temporary directory after the check.

- [ ] **Step 6: Inspect the rendered panel**

Start `npm run dev -- --kit ./kits/sqlite`, open the editor, and verify at desktop and narrow viewport widths that the connection bar, object rail, tab panels, table overflow, record dialog, SQL result, focus indicators, loading state, empty state, and error state are readable and operable. Fix only issues observed in the SQLite Kit files, then rerun the focused panel test and plugin build.

- [ ] **Step 7: Commit integration and docs**

```bash
git add package.json docs/guides/developing-plugins-and-kits.md kits/sqlite
git commit -m "测试：接入 SQLite Kit 完整验证"
```

- [ ] **Step 8: Confirm final repository state**

Run: `git status --short && git log -8 --oneline --decorate`

Expected: no uncommitted files; recent commits correspond to Tasks 1–7 and the earlier design/plan commits.
