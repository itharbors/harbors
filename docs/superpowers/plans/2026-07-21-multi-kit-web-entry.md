# Multi-Kit Web Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the multi-Kit Web root a discoverable Kit chooser with stable `/kits/<id>` links while preserving direct single-Kit startup.

**Architecture:** The Server owns a sanitized Kit Catalog derived from assembly directories and exposes it through `GET /api/kits`; stable Kit paths resolve against the same catalog and redirect into the existing query/session loading path. The client performs a lightweight host bootstrap before mounting `editor-app`, rendering a dedicated chooser only for a multi-Kit bare root. The launch scripts pass an explicit host mode so the Web behavior is independent from the assembly fallback Kit.

**Tech Stack:** TypeScript, Node HTTP, Vite, Web Components, Vitest, Node test runner, Electron development launcher.

## Global Constraints

- Multi-Kit `/` must not create a default session.
- Single-Kit `/` must continue to open the explicitly requested Kit.
- Public catalog responses must not expose absolute directories, manifest paths, or plugin lists.
- Stable links use manifest `menuRoot.id`: `/kits/default`, `/kits/sqlite`, `/kits/mysql`.
- Existing Electron URLs with `session`, `kit`, and `menuMode` remain direct editor URLs.
- Existing sessions remain authoritative if a URL also carries a different `kit` value.
- The chooser uses the existing dark workbench language with blue-gray accents, keyboard focus, responsive layout, and reduced-motion support.
- All implementation follows test-first red-green cycles.

---

### Task 1: Shared catalog contract and Server catalog discovery

**Files:**
- Create: `packages/plugin-types/src/protocol/kit-catalog.ts`
- Modify: `packages/plugin-types/src/index.ts`
- Create: `packages/server/src/assembly/kit-catalog.ts`
- Create: `packages/server/tests/assembly/kit-catalog.test.ts`

**Interfaces:**
- Produces: `KitHostMode`, `PublicKitCatalogEntry`, and `KitCatalogResponse` from `@itharbors/plugin-types`.
- Produces: `discoverKitCatalog(assembly: AssemblyConfig, mode: KitHostMode): Promise<KitCatalogEntry[]>` where internal entries extend the public fields with `directory`.
- Consumes: `AssemblyConfig` and existing Kit manifest fields `name` plus `ce-editor.kit.menuRoot`.

- [ ] **Step 1: Write failing catalog discovery tests**

Create fixtures for three valid Kits, one invalid manifest, duplicated assembly directories, an external single-Kit path, duplicate package names, and duplicate menu ids. Assert that multi mode returns sorted valid entries, single mode returns only the resolved default Kit, internal directories are available only to Server code, and conflicts reject with deterministic messages.

```ts
const catalog = await discoverKitCatalog(assembly, 'multi');
expect(catalog.map(({ id, name, label }) => ({ id, name, label }))).toEqual([
  { id: 'default', name: '@itharbors/kit-default', label: 'Default Kit' },
  { id: 'mysql', name: '@itharbors/kit-mysql', label: 'MySQL' },
]);
await expect(discoverKitCatalog(duplicateAssembly, 'multi'))
  .rejects.toThrow('Duplicate Kit package name');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test -w packages/server -- --run tests/assembly/kit-catalog.test.ts`

Expected: FAIL because `src/assembly/kit-catalog.ts` and shared protocol exports do not exist.

- [ ] **Step 3: Implement shared types and discovery**

Add the shared protocol:

```ts
export type KitHostMode = 'single' | 'multi';
export interface PublicKitCatalogEntry { id: string; name: string; label: string; }
export interface KitCatalogResponse { mode: KitHostMode; kits: PublicKitCatalogEntry[]; }
```

Implement discovery by scanning unique assembly directories in multi mode and by resolving the explicit `defaultKit` in single mode. Read and validate each manifest, ignore invalid non-selected catalog entries, sort by label/name, and reject duplicate public identifiers.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm run test -w packages/server -- --run tests/assembly/kit-catalog.test.ts`

Expected: all catalog discovery tests PASS.

---

### Task 2: Host mode propagation, Catalog HTTP routes, and Gateway routing

**Files:**
- Modify: `scripts/dev.mjs`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/app.ts`
- Create: `packages/server/src/routes/kit-catalog.ts`
- Create: `packages/server/tests/routes/kit-catalog.test.ts`
- Modify: `packages/server/tests/integration/integration.test.ts`
- Create: `packages/gateway/src/routing.ts`
- Modify: `packages/gateway/src/index.ts`
- Create: `packages/gateway/tests/routing.test.ts`
- Modify: `packages/gateway/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `discoverKitCatalog()` and `KitCatalogResponse` from Task 1.
- Produces: `ServerOptions.kitMode?: KitHostMode` and `AppOptions.kitMode: KitHostMode`.
- Produces: `createKitCatalogRouter(mode, catalogPromise)` handling `GET /api/kits` and `GET /kits/:id`.
- Produces: `selectGatewayTarget(url, isProd): 'server' | 'client'`.

- [ ] **Step 1: Write failing Server route and mode tests**

Assert that `GET /api/kits` returns `{ mode, kits }` without `directory`, `GET /kits/mysql` returns `302` with `Location: /?kit=%40itharbors%2Fkit-mysql`, unknown ids return `404 KIT_NOT_FOUND`, and non-GET catalog requests return `405 METHOD_NOT_ALLOWED`. Extend integration tests to prove multi mode can expose all Kits while single mode exposes only the requested Kit.

```ts
expect(await response.json()).toEqual({
  mode: 'multi',
  kits: [{ id: 'mysql', name: '@itharbors/kit-mysql', label: 'MySQL' }],
});
expect(redirect.status).toBe(302);
expect(redirect.headers.get('location')).toBe('/?kit=%40itharbors%2Fkit-mysql');
```

- [ ] **Step 2: Write failing Gateway routing tests**

Assert that `/api/*`, `/sse/*`, and `/kits/*` target Server in development, while `/` and client assets target Vite; production continues to send all traffic to Server.

```ts
expect(selectGatewayTarget('/kits/mysql', false)).toBe('server');
expect(selectGatewayTarget('/', false)).toBe('client');
expect(selectGatewayTarget('/', true)).toBe('server');
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm run test -w packages/server -- --run tests/routes/kit-catalog.test.ts tests/integration/integration.test.ts`

Run: `npm run test -w packages/gateway`

Expected: FAIL because the routes, mode option, Gateway selector, and test script do not exist.

- [ ] **Step 4: Implement mode and HTTP routing**

Set `serverEnv.CE_KIT_MODE` to `single` when `--kit` is present and `multi` otherwise. Parse the value in Server startup, normalize omitted embedded options as `single` when `defaultKit` is explicit and `multi` otherwise, create one cached catalog promise, and dispatch `/api/kits` plus `/kits/` before the legacy session router.

The stable redirect must use an exact catalog id match and encode only the package name:

```ts
const location = `/?kit=${encodeURIComponent(entry.name)}`;
res.statusCode = 302;
res.setHeader('Location', location);
res.end();
```

- [ ] **Step 5: Implement and use Gateway route selection**

Move the development/prod target decision into `routing.ts`, route `/kits/*` to Server, add `typecheck` and `test` scripts to the Gateway workspace, and add that workspace test to the root `npm test` chain.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npm run test -w packages/server -- --run tests/routes/kit-catalog.test.ts tests/integration/integration.test.ts`

Run: `npm run test -w packages/gateway`

Expected: all focused Server and Gateway tests PASS.

---

### Task 3: Client entry decision and Kit chooser

**Files:**
- Create: `packages/client/src/core/host-entry.ts`
- Create: `packages/client/src/components/kit-picker.ts`
- Create: `packages/client/src/styles/kit-picker.css`
- Modify: `packages/client/src/index.ts`
- Modify: `packages/client/index.html`
- Create: `packages/client/tests/core/host-entry.test.ts`
- Create: `packages/client/tests/components/kit-picker.test.ts`
- Modify: `packages/client/tests/index.test.ts`

**Interfaces:**
- Consumes: `KitCatalogResponse` and `PublicKitCatalogEntry` from `@itharbors/plugin-types`.
- Produces: `selectHostEntry(mode, url): 'picker' | 'editor'`.
- Produces: `renderKitPicker(host, catalog)` and `renderKitPickerError(host, retry)`.
- Produces: asynchronous `startClientApp()` in `index.ts`.

- [ ] **Step 1: Write failing entry-decision tests**

Cover multi bare root, multi explicit `kit`, multi `session`, multi `sessionId`, Electron complete URLs, single bare root, and a developer `page` query. The only picker case is multi mode at `/` without an explicit session, Kit, or page.

```ts
expect(selectHostEntry('multi', new URL('http://localhost:8080/'))).toBe('picker');
expect(selectHostEntry('multi', new URL('http://localhost:8080/?kit=mysql'))).toBe('editor');
expect(selectHostEntry('single', new URL('http://localhost:8080/'))).toBe('editor');
```

- [ ] **Step 2: Write failing chooser rendering tests**

Render two Kits and assert semantic heading/list/link output, exact stable hrefs, package labels, empty-state guidance, retry behavior, visible focus CSS, responsive single-column rule, and `prefers-reduced-motion` handling.

```ts
expect(host.querySelector<HTMLAnchorElement>('[data-kit-id="mysql"]')?.getAttribute('href'))
  .toBe('/kits/mysql');
expect(host.textContent).toContain('@itharbors/kit-mysql');
```

- [ ] **Step 3: Update the entry source contract test and verify RED**

Require `index.ts` to fetch `/api/kits`, mount the picker only from `selectHostEntry`, retain imports for editor/window components, and expose a retryable error instead of silently mounting a default editor.

Run: `npm run test -w packages/client -- --run tests/core/host-entry.test.ts tests/components/kit-picker.test.ts tests/index.test.ts`

Expected: FAIL because host entry and picker modules do not exist and `index.ts` always mounts `editor-app`.

- [ ] **Step 4: Implement the host bootstrap and chooser**

`startClientApp()` renders a compact loading shell, fetches `/api/kits`, validates the minimal response shape, then mounts either `<editor-app>` or the picker. On failure it renders the error state with a button that calls `startClientApp()` again. The picker uses stable `/kits/<encoded-id>` links and never calls a session endpoint.

- [ ] **Step 5: Implement the visual system**

Use CSS variables for the six approved palette values, a compact centered shell, a quiet oversized `HARBORS` background wordmark, card edge signals derived from a deterministic index, and restrained hover/focus translation. Include `:focus-visible`, a mobile breakpoint, and reduced-motion override.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npm run test -w packages/client -- --run tests/core/host-entry.test.ts tests/components/kit-picker.test.ts tests/index.test.ts`

Expected: all host entry and picker tests PASS.

---

### Task 4: Documentation, full verification, and live mode acceptance

**Files:**
- Modify: `docs/guides/development-workflow.md`
- Modify: `docs/architecture/kit-and-session-model.md`
- Modify: `docs/architecture/runtime-flows.md`
- Modify: `scripts/lib/electron-launcher.test.mjs`

**Interfaces:**
- Documents: multi-Kit root chooser, stable Web paths, direct query compatibility, and single-Kit root behavior.
- Verifies: Electron window URLs and Tray behavior remain unchanged.

- [ ] **Step 1: Add documentation assertions and update docs**

Extend script contract coverage only where needed to retain the existing Electron `session + kit + menuMode` URL. Document:

```text
Multi-Kit Web root: http://localhost:8080/
Default Kit:        http://localhost:8080/kits/default
SQLite:             http://localhost:8080/kits/sqlite
MySQL:              http://localhost:8080/kits/mysql
```

State that `?kit=<package-name>` remains compatible and that adding a different Kit to an already initialized session does not switch it.

- [ ] **Step 2: Run focused workspace suites**

Run: `npm run test -w packages/gateway`

Run: `npm run test -w packages/server`

Run: `npm run test -w packages/client`

Run: `node --test scripts/lib/electron-launcher.test.mjs`

Expected: all tests PASS with zero failures.

- [ ] **Step 3: Run repository verification**

Run: `npm run check`

Expected: build, all repository tests, change-workflow tests, and plugin checks exit 0.

- [ ] **Step 4: Live-verify multi-Kit mode**

Start the Web stack without `--kit` on free test ports. Verify with browser DOM and HTTP evidence that `/` displays the chooser without creating a session, each `/kits/<id>` redirects and loads the correct Kit, and simultaneous sessions return different `bootstrap.kitName` values.

- [ ] **Step 5: Live-verify single-Kit mode**

Start the Web stack with `--kit @itharbors/kit-mysql` on free test ports. Verify `/api/kits` reports `single` with only MySQL and `/` mounts the MySQL editor without a chooser.

- [ ] **Step 6: Review and commit implementation**

Run `git diff --check`, inspect `git status --short`, stage only the files listed by this plan, review `git diff --cached`, and commit with:

```text
[Bug] 补全多 Kit Web 入口
```

- [ ] **Step 7: Push the existing review branch**

Push `bug/kit-lifecycle` to `origin` so existing PR #8 receives the fix. Keep the worktree and running test page available for user review.
