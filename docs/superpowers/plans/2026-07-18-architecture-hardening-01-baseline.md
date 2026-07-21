# Architecture Hardening 01: Migration Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a finite, green repository baseline that matches the authoritative `kits/default` migration state.

**Architecture:** Remove tests that exclusively describe the deleted scene-editor product, migrate reusable Kit assertions to the default Kit or temporary fixtures, and separate CI checks from long-running development processes. No deleted business Kit is restored.

**Tech Stack:** npm workspaces, TypeScript 5.7, Vitest 2.1, Node.js ESM

## Global Constraints

- `kits/default` is the only repository Kit in the current migration.
- Do not restore `kits/scene-editor` or any deleted legacy directory.
- Keep `npm run dev` as an explicit long-running developer command.
- `npm run check` must terminate after building shared protocol types, type checks, tests, and plugin validation.
- Preserve reusable architecture coverage by moving it to the default Kit or test fixtures.

---

## File Structure

- `package.json`: finite root check composition.
- `packages/server/tests/framework/plugin.test.ts`: repository plugin discovery expectations.
- `packages/server/tests/framework/editor.test.ts`: public Editor/Kit behavior against the current default Kit.
- `packages/server/tests/integration/integration.test.ts`: configured default-Kit HTTP behavior.
- `packages/server/tests/integration/scene-editor-kit.test.ts`: delete; it tests removed product behavior only.
- `packages/server/src/__tests__/framework/scene-editor-kit.test.ts`: delete; replace reusable metadata assertion in the default-Kit test.
- `packages/server/tests/routes/panel-assets.test.ts`: rename stale test wording without changing fixture behavior.

### Task 1: Make the root check finite

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: existing workspace `test` and `plugins:check` scripts.
- Produces: `npm run check` that exits with the combined check result.

- [ ] **Step 1: Add a failing script assertion**

Run:

```bash
node -e "const p=require('./package.json'); if (/npm run dev/.test(p.scripts.check) || !/build -w @ce\/plugin-types/.test(p.scripts.check)) process.exit(1)"
```

Expected: exit code 1 because `check` contains `npm run dev`.

- [ ] **Step 2: Replace the check script**

Set the root script to:

```json
"check": "npm run build -w @itharbors/plugin-types && npm test && npm run plugins:check"
```

- [ ] **Step 3: Verify the script shape**

Run:

```bash
node -e "const p=require('./package.json'); if (p.scripts.check !== 'npm run build -w @itharbors/plugin-types && npm test && npm run plugins:check') process.exit(1)"
```

Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build: make repository check finite"
```

### Task 2: Remove deleted scene-editor product tests

**Files:**
- Delete: `packages/server/tests/integration/scene-editor-kit.test.ts`
- Delete: `packages/server/src/__tests__/framework/scene-editor-kit.test.ts`
- Modify: `packages/server/tests/routes/panel-assets.test.ts`

**Interfaces:**
- Consumes: current repository Kit inventory.
- Produces: test discovery with no dependency on removed scene-editor files.

- [ ] **Step 1: Confirm the stale tests fail for the expected reason**

Run:

```bash
npm run test -w packages/server -- --run tests/integration/scene-editor-kit.test.ts src/__tests__/framework/scene-editor-kit.test.ts
```

Expected: FAIL with `Kit "@itharbors/kit-scene-editor" not found` or missing scene-editor files.

- [ ] **Step 2: Delete the two product-specific suites**

Remove both files. They assert scene asset generation, workflow behavior and product panels that no longer exist in the authoritative migration.

- [ ] **Step 3: Rename the fixture-only route test**

Change the title in `panel-assets.test.ts` from:

```ts
it('serves scene-editor panel-local dist assets from the panel directory URL', () => {
```

to:

```ts
it('serves panel-local dist assets from the panel directory URL', () => {
```

- [ ] **Step 4: Verify there are no product references outside fixture names**

Run:

```bash
rg -n "scene-editor|kit-scene-editor" packages/server --glob '!**/dist/**'
```

Expected: remaining matches are limited to tests intentionally changed in Tasks 3 and 4 before those tasks run; after Task 4 there are no matches.

- [ ] **Step 5: Commit**

```bash
git add packages/server/tests/integration/scene-editor-kit.test.ts packages/server/src/__tests__/framework/scene-editor-kit.test.ts packages/server/tests/routes/panel-assets.test.ts
git commit -m "test: remove deleted scene editor product suites"
```

### Task 3: Align repository and Editor tests with the default Kit

**Files:**
- Modify: `packages/server/tests/framework/plugin.test.ts`
- Modify: `packages/server/tests/framework/editor.test.ts`

**Interfaces:**
- Consumes: `discoverAllPlugins(repoRoot)` and `Editor.kit.switchKit(name)`.
- Produces: assertions against directories and Kits that exist in the current repository.

- [ ] **Step 1: Replace the deleted discovery expectation**

Use an exact inventory assertion:

```ts
expect(pluginDirs).toContain(path.join(repoRoot, 'plugins', 'menu'));
expect(pluginDirs).toContain(path.join(repoRoot, 'kits', 'default', 'plugins', 'log'));
expect(pluginDirs).toContain(path.join(repoRoot, 'kits', 'default', 'plugins', 'message-debug'));
```

- [ ] **Step 2: Keep switchKit behavior without a removed Kit**

Replace the scene-editor switch test with:

```ts
it('kit.switchKit reloads the requested kit and updates getCurrent', async () => {
  await editor.kit.load('default');

  await editor.kit.switchKit('@itharbors/kit-default');

  expect(editor.kit.getCurrent()?.name).toBe('@itharbors/kit-default');
});
```

- [ ] **Step 3: Run the focused tests**

```bash
npm run test -w packages/server -- --run tests/framework/plugin.test.ts tests/framework/editor.test.ts
```

Expected: both files PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/tests/framework/plugin.test.ts packages/server/tests/framework/editor.test.ts
git commit -m "test: align kit coverage with current repository"
```

### Task 4: Test configured default Kit using the existing Kit

**Files:**
- Modify: `packages/server/tests/integration/integration.test.ts`

**Interfaces:**
- Consumes: `createServer({ defaultKit })`, `POST /api/session`, and `GET /api/bootstrap/:sessionId`.
- Produces: integration coverage proving server-level default Kit configuration is honored.

- [ ] **Step 1: Replace the removed Kit setup and assertions**

Use:

```ts
it('POST /api/session uses the server default kit when one is configured', async () => {
  const server = createServer({ defaultKit: '@itharbors/kit-default' });
  const customPort = await server.start(0);
  const customBaseURL = `http://localhost:${customPort}`;

  try {
    const sessionResp = await fetch(`${customBaseURL}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'configured-default-kit-test' }),
    });
    expect(sessionResp.status).toBe(201);

    const resp = await fetch(`${customBaseURL}/api/bootstrap/configured-default-kit-test`);
    const data = await resp.json();

    expect(resp.status).toBe(200);
    expect(data.kitName).toBe('@itharbors/kit-default');
    expect(data.panels.map((panel: { name: string }) => panel.name)).toEqual(
      expect.arrayContaining(['@itharbors/status-bar.status', '@itharbors/log.log']),
    );
  } finally {
    await server.stop();
  }
});
```

- [ ] **Step 2: Run the focused integration test**

```bash
npm run test -w packages/server -- --run tests/integration/integration.test.ts
```

Expected: PASS.

- [ ] **Step 3: Verify scene-editor references are gone**

```bash
rg -n "scene-editor|kit-scene-editor" packages/server --glob '!**/dist/**'
```

Expected: no matches.

- [ ] **Step 4: Run the baseline server suite**

```bash
npm run test -w packages/server
```

Expected: all server test files and type checking PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/tests/integration/integration.test.ts
git commit -m "test: cover configured default kit"
```
