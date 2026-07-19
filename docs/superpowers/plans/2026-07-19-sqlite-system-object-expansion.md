# SQLite System Object Expansion State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the SQLite “系统对象” group open after a child object is selected while preserving its default-collapsed behavior for each new database connection.

**Architecture:** Store expanded object-group kinds in `WorkbenchState`, update that state from each collapsible group’s native `toggle` event, and restore `details.open` whenever the panel performs a full render. Clear the state at database connection boundaries; no service or protocol changes are required.

**Tech Stack:** TypeScript, DOM `details`/`toggle`, Vitest, jsdom

## Global Constraints

- 系统对象在首次打开数据库时默认折叠。
- 用户选择系统对象或触发其他完整重绘时保持其手动展开或折叠状态。
- 关闭数据库或打开另一数据库时重置展开状态。
- 普通表、视图和虚拟表仍不可折叠。
- 不修改 SQLite 服务端协议。

---

### Task 1: Persist and reset the system-object group expansion state

**Files:**
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts:194`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts:143-175,220-254,287-305,359-376,850-884`

**Interfaces:**
- Consumes: `WorkbenchState`, `createInitialState()`, `openDatabaseAt()`, `closeDatabase()`, and `renderObjects()` from the existing panel module.
- Produces: `WorkbenchState.expandedObjectGroups: Set<NonNullable<SchemaObject['kind']>>`; no exported API changes.

- [ ] **Step 1: Write the failing selection regression test**

Add this test after the existing object-group heading test:

```ts
it('keeps the system object group expanded after selecting a child object', async () => {
  await connect();
  const systemGroup = root.querySelector<HTMLDetailsElement>('details[data-object-kind="shadow"]')!;
  systemGroup.open = true;
  systemGroup.dispatchEvent(new Event('toggle'));

  systemGroup.querySelector<HTMLButtonElement>('[data-object-name="search_fts_data"]')!.click();
  await flush();

  expect(root.querySelector<HTMLDetailsElement>('details[data-object-kind="shadow"]')!.open).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/panel.test.ts -t "keeps the system object group expanded"
```

Expected: FAIL because the replacement `details` element has `open === false` after `selectObject()` completes.

- [ ] **Step 3: Add expansion state and restore it during rendering**

Add the property to `WorkbenchState`:

```ts
expandedObjectGroups: Set<NonNullable<SchemaObject['kind']>>;
```

Initialize it in `createInitialState()`:

```ts
expandedObjectGroups: new Set(),
```

Replace the unconditional `section.open = false` branch in `renderObjects()` with:

```ts
if (section instanceof HTMLDetailsElement) {
  section.open = state.expandedObjectGroups.has(type);
  section.addEventListener('toggle', () => {
    if (!section.isConnected) return;
    if (section.open) state.expandedObjectGroups.add(type);
    else state.expandedObjectGroups.delete(type);
  });
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2 again.

Expected: PASS; selecting `search_fts_data` replaces the DOM but restores the system group as open.

- [ ] **Step 5: Write the failing connection-reset regression test**

Add this second test beside the selection regression:

```ts
it('resets the system object group when reconnecting to a database', async () => {
  await connect();
  const systemGroup = root.querySelector<HTMLDetailsElement>('details[data-object-kind="shadow"]')!;
  systemGroup.open = true;
  systemGroup.dispatchEvent(new Event('toggle'));

  root.querySelector<HTMLButtonElement>('[data-action="close"]')!.click();
  await flush();
  root.querySelector<HTMLButtonElement>('[data-action="open"]')!.click();
  await flush();

  expect(root.querySelector<HTMLDetailsElement>('details[data-object-kind="shadow"]')!.open).toBe(false);
});
```

- [ ] **Step 6: Run the reset test and verify RED**

Run:

```bash
npm run test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/panel.test.ts -t "resets the system object group"
```

Expected: FAIL because the expansion set still contains `shadow` after reconnecting.

- [ ] **Step 7: Reset expansion state at connection boundaries**

In the `openDatabaseAt()` action, immediately after accepting the new connection, add:

```ts
state.expandedObjectGroups.clear();
```

In the `closeDatabase()` action, immediately after accepting the disconnected state, add the same line:

```ts
state.expandedObjectGroups.clear();
```

- [ ] **Step 8: Run focused and full verification**

Run:

```bash
npm run test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/panel.test.ts
npm run check
```

Expected: the panel test file passes with both new regressions, and the repository check exits with code 0.

- [ ] **Step 9: Commit the implementation**

```bash
git add kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts
git commit -m "[Bug] 保留 SQLite 系统对象展开状态"
```
