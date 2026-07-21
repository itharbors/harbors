# Electron Multi-Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 默认以 Electron 启动 ITHARBORS，通过系统托盘提供彼此隔离的全部 Kit 窗口，并支持单/多 Kit 菜单和 `@itharbors/*` 统一命名。

**Architecture:** Electron main process持有 KitCatalog、WorkspaceStore、Tray 和 KitWindowRegistry；每个 KitWindow 使用稳定 sessionId 连接现有 Server，从而复用每 Session 一个 Editor 的隔离边界。Server 将菜单拆分为 application/kit/combined 三份树，Renderer 经 IPC 同步给 Electron，Electron 按运行模式平铺或聚合。

**Tech Stack:** Node.js 20、TypeScript、Electron 31、Vitest、Node test runner、SQLite session store。

## Global Constraints

- 每个行为修改严格执行 RED → GREEN → REFACTOR。
- 所有代码编辑只发生在 `feature/electron-multi-kit` worktree。
- 插件 package 标识统一为 `@itharbors/*`；不改 `ce-editor`、`--ce-*` 或 `ce-*`。
- 多 Kit 的 Panel、Message、Menu、Config、Window 和 SSE 状态按 sessionId 隔离。
- 保留 `npm run electron`、`npm run dev:web` 和 `--kit <name-or-path>`。

---

### Task 1: Plugin Namespace Migration

**Files:**
- Create: `scripts/lib/plugin-namespace.test.mjs`
- Modify: every tracked source/manifest/test/doc containing the legacy CE plugin package scope
- Modify: `package-lock.json`, `package.json`

**Interfaces:**
- Produces: zero tracked plugin references using the legacy CE scope; protocol package uses the ITHARBORS scope.

- [ ] Add a Node test that scans tracked text files (excluding generated output) and rejects the legacy plugin scope.
- [ ] Run `node --test scripts/lib/plugin-namespace.test.mjs`; expect failure listing current references.
- [ ] Mechanically migrate package identifiers to the ITHARBORS scope, refresh lockfile, and update root scripts.
- [ ] Run build, namespace test, Server/Client/Kit tests; expect green.
- [ ] Commit `[Feature] 统一插件命名空间`.

### Task 2: Kit Menu Metadata and Isolated Runtime State

**Files:**
- Modify: `kits/default/package.json`, `kits/sqlite/package.json`, `kits/mysql/package.json`
- Modify: `packages/server/src/framework/kit/types.ts`
- Modify: `packages/server/src/editor/index.ts`
- Modify: `packages/server/src/framework/menu/index.ts`
- Modify: `packages/server/src/editor/types.ts`
- Modify: `packages/plugin-types/src/protocol/bootstrap.ts`
- Modify: `packages/plugin-types/src/protocol/http.ts`
- Test: `packages/server/tests/framework/editor.test.ts`
- Test: `packages/server/tests/menu/menu.test.ts`
- Test: `packages/server/tests/integration/integration.test.ts`

**Interfaces:**
- Produces: `KitMenuRoot { id: string; label: string }`, `KitDescriptor.menuRoot`, `Editor.menu.getApplicationState()`, `Editor.menu.getKitState()`, and bootstrap menu projections.

- [ ] Add failing tests requiring menuRoot validation and distinct combined/application/kit menu trees.
- [ ] Add a failing test proving editor Config values do not cross session boundaries.
- [ ] Implement menuRoot parsing, split menu projections, bootstrap/SSE fields, and per-Editor Config stores.
- [ ] Run focused Server tests, build shared protocol, and rerun Server tests.
- [ ] Commit `[Feature] 增加 Kit 菜单元数据与运行时隔离`.

### Task 3: Kit Catalog and Workspace Persistence

**Files:**
- Create: `scripts/lib/kit-catalog.mjs`
- Create: `scripts/lib/kit-catalog.test.mjs`
- Create: `scripts/lib/workspace-store.mjs`
- Create: `scripts/lib/workspace-store.test.mjs`

**Interfaces:**
- Produces: `discoverKits({ rootDir, requestedKit? }) -> KitCatalogEntry[]` and `WorkspaceStore.getOrCreate(kit)`, `updateBounds`, `list`.

- [ ] Add failing catalog tests for discovery, package/path `--kit`, invalid manifests, duplicate roots and single-mode filtering.
- [ ] Implement read-only catalog discovery from Kit manifests.
- [ ] Add failing persistence tests for stable sessionId, atomic bounds update, corrupt state and unavailable Kit records.
- [ ] Implement JSON WorkspaceStore using temp-file + rename and `crypto.randomUUID()`.
- [ ] Run both Node test files and commit `[Feature] 增加 Kit 目录与工作区持久化`.

### Task 4: Electron Tray and Independent Kit Windows

**Files:**
- Create: `scripts/assets/tray-icon.svg`
- Create: `scripts/lib/electron-launcher.test.mjs`
- Modify: `scripts/electron.mjs`

**Interfaces:**
- Produces: testable `parseElectronOptions`, `createKitWindowUrl`, `buildTrayTemplate`; runtime KitWindowRegistry keyed by Kit name.

- [ ] Add failing tests for multi/single CLI parsing, per-Kit session URLs, tray entries, unavailable entries and open/focus behavior.
- [ ] Implement option parsing, catalog loading, persistent workspaces, prewarmed hidden Kit windows and Tray lifecycle.
- [ ] Ensure one Kit failure is contained and all windows share only the Electron application services.
- [ ] Run launcher and existing Electron template tests.
- [ ] Commit `[Feature] 增加 Electron 多 Kit 托盘窗口`.

### Task 5: Single and Multi-Kit Menu Composition

**Files:**
- Modify: `packages/client/src/electron/types.ts`
- Modify: `packages/client/src/menu/runtime.ts`
- Modify: `packages/client/src/components/editor-app.ts`
- Modify: `scripts/electron-preload.cjs`
- Modify: `scripts/electron.mjs`
- Test: `packages/client/tests/menu/runtime.test.ts`
- Test: `packages/client/tests/components/editor-app.test.ts`
- Test: `packages/server/tests/menu/electron-template.test.ts`

**Interfaces:**
- Consumes: bootstrap `applicationMenuTree`, `kitMenuTree`, `kitMenuRoot`.
- Produces: IPC payload with menu mode and three trees; `buildMultiKitMenuTemplate` with APP and per-Kit roots.

- [ ] Add failing Client tests for complete menu IPC payload and mode from URL.
- [ ] Add failing Electron tests for flat single mode, APP/Kit aggregation and correct session routing.
- [ ] Implement Client/Preload payload and Electron aggregation; showing a hidden Kit before dispatching its action.
- [ ] Run focused Client/Server menu tests and Electron helper tests.
- [ ] Commit `[Feature] 支持单多 Kit 菜单组合`.

### Task 6: Default Electron Entry and Compatibility

**Files:**
- Modify: `package.json`, `scripts/electron.mjs`, `scripts/dev.mjs`, `readme.md`, `docs/guides/development-workflow.md`
- Test: `scripts/lib/electron-launcher.test.mjs`

**Interfaces:**
- Produces: `npm run dev` → Electron, `npm run dev:web` → existing stack, Electron child process → `dev:web` without recursion.

- [ ] Add failing script-contract assertions for the three commands and forwarded `--kit`.
- [ ] Update scripts and Electron framework spawn command.
- [ ] Run launcher tests, `npm run build`, and `npm test`.
- [ ] Commit `[Feature] 默认启用 Electron 多 Kit 启动`.

### Task 7: Acceptance, Documentation, and Full Verification

**Files:**
- Modify: architecture and guide documents affected by the final contracts.
- Test: all focused and repository checks.

**Interfaces:**
- Produces: requirement-to-evidence checklist in the design document and reviewable final branch.

- [ ] Verify namespace scan, Kit catalog, Workspace persistence, session isolation, tray template and menu aggregation tests.
- [ ] Run `npm run check`; require exit 0 and record exact pass/skip counts.
- [ ] Inspect `git status --short`, `git diff`, `git diff --cached`, and search for forbidden plugin namespace references.
- [ ] Commit final documentation with `[Feature] 完善多 Kit 工作台文档` when documentation changed after prior commits.
- [ ] Use `finish-change.sh` only after the complete requirement audit succeeds.
