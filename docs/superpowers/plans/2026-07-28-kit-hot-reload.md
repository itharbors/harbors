# Kit Hot Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kit install, update, activation, rollback, and uninstall take effect in the running desktop app without restarting Electron.

**Architecture:** Keep Electron, the tray, Notification Host, and Kit Manager alive while a serialized runtime coordinator replaces the Framework child process. Activation and uninstall use durable staged Store state; each new Framework generation is built from a freshly discovered Catalog, validated, committed, and then used to reload surviving Kit windows. Uninstall paths are derived only from validated Store records and removed after the replacement Framework no longer loads the Kit.

**Tech Stack:** Electron 43, Node.js ESM/CommonJS preload, TypeScript Kit Core schemas, `node:test`, JSDOM.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-28-kit-hot-reload-design.md` as the behavioral source of truth.
- Write a failing test before each production change and observe the expected failure.
- Never call `app.relaunch()` for a Kit operation.
- Never let renderer input choose a filesystem path, process command, environment value, or deletion scope.
- Preserve stable workspace session IDs and BrowserWindow shells for surviving Kits.
- Keep Notification Host and Kit Manager alive across Framework generations.
- Commit each task with a focused `[Bug] 中文摘要` title.

---

## Task 1: Extend the installed-state schema with staged uninstall

**Files:**

- Modify: `packages/kit-core/src/model.ts`
- Modify: `packages/kit-core/src/schema.ts`
- Test: `packages/kit-core/tests/schema.test.ts`
- Modify: `scripts/lib/kit-store/state.mjs`
- Test: `scripts/lib/kit-store/state.test.mjs`

- [ ] Add schema tests that accept optional `pendingUninstall: true`, reject `false` and non-booleans, and reject unknown fields as before.
- [ ] Run `npm test -w @itharbors/kit-core -- --runInBand` and confirm the new assertions fail because the field is unknown.
- [ ] Add `pendingUninstall?: true` to `InstalledKitRecord` and parse it with exact-key validation.
- [ ] Add Store tests for `stageUninstall(id)`, `cancelUninstall(id)`, `pendingUninstallDirectories(id)`, and `commitUninstall(id)`.
- [ ] Assert `listActiveSources()` omits staged records; cancel restores the active source; commit removes the whole record; repeated staging is idempotent; missing records fail closed.
- [ ] Implement the four Store methods. `pendingUninstallDirectories` returns cloned `{ id, version, directory }` entries sorted by version and only while staged. `commitUninstall` requires the staged flag and atomically removes the record.
- [ ] Make `recordInstalled`, `setPending`, activation, and rollback reject a staged uninstall so state cannot fork during removal.
- [ ] Run `node --test scripts/lib/kit-store/state.test.mjs` and `npm test -w @itharbors/kit-core`.
- [ ] Commit: `[Bug] 增加 Kit 暂存删除状态`

## Task 2: Add a fail-closed installed Kit uninstaller

**Files:**

- Create: `scripts/lib/kit-store/uninstaller.mjs`
- Create: `scripts/lib/kit-store/uninstaller.test.mjs`
- Modify: `package.json`

- [ ] Write tests using a temporary Store for deleting every version directory of one staged Kit without touching another Kit.
- [ ] Cover idempotent missing directories, a directory outside `<storeRoot>/kits/<encoded-id>/<version>`, a symlink at any target, a non-directory target, and an identity mismatch between Store version and expected path.
- [ ] Run `node --test scripts/lib/kit-store/uninstaller.test.mjs` and confirm the missing module failure.
- [ ] Implement `KitArtifactUninstaller({ storeRoot, store })` with `removeStaged(id)`.
- [ ] Resolve targets from `store.pendingUninstallDirectories(id)` only. Compare each absolute path with `path.join(storeRoot, 'kits', encodeKitId(id), version)`, use `lstat` to reject symbolic links/non-directories, and use `rm(target, { recursive: true })` only after all targets pass validation.
- [ ] Treat `ENOENT` as success, remove now-empty encoded Kit directory only after validating the exact parent, and do not mutate Store state.
- [ ] Add the new test file to the repository test command and run its focused tests.
- [ ] Commit: `[Bug] 安全删除已安装 Kit 制品`

## Task 3: Generalize startup preparation for activation and uninstall recovery

**Files:**

- Modify: `scripts/lib/kit-store/startup.mjs`
- Modify: `scripts/lib/kit-store/startup.test.mjs`

- [ ] Add tests showing startup leaves staged uninstall excluded from active sources and returns a `pendingUninstalls` list for later cleanup.
- [ ] Add tests showing activation validation failure stages at most one previous-version recovery and reports the target as failed without requiring Electron relaunch.
- [ ] Run `node --test scripts/lib/kit-store/startup.test.mjs` and observe the new failures.
- [ ] Extend `prepareInstalledKitsForStartup` to return `{ activeSources, outcomes, pendingActivations, pendingUninstalls }` without committing deletion.
- [ ] Replace `restartRequired` in finalization with explicit outcome data: activated selections, recovery-pending selections, and disabled selections. Keep audit behavior intact.
- [ ] Ensure all returned collections are deterministic and contain IDs/versions/channels rather than filesystem authority.
- [ ] Run focused startup and state tests.
- [ ] Commit: `[Bug] 支持 Kit 删除与激活启动恢复`

## Task 4: Build the serialized Framework runtime coordinator

**Files:**

- Create: `scripts/lib/kit-runtime-coordinator.mjs`
- Create: `scripts/lib/kit-runtime-coordinator.test.mjs`
- Modify: `package.json`

- [ ] Write contract tests for a coordinator with injected adapters: `snapshotWindows`, `closeTargetWindows`, `stopFramework`, `prepareGeneration`, `startFramework`, `validateGeneration`, `commitGeneration`, `publishGeneration`, `reloadWindows`, and `recoverGeneration`.
- [ ] Prove concurrent operations execute FIFO, each successful transaction has one stop/start/publish/reload sequence, and failed preparation does not stop the current Framework.
- [ ] Prove activation load failure performs one recovery generation, returns the original operation error only after recovery, and never reports success when recovery fails.
- [ ] Prove uninstall start failure cancels staged uninstall and restores the previous generation; successful uninstall closes only target windows before stop and reloads only surviving windows.
- [ ] Run the focused test and confirm the module is absent.
- [ ] Implement `createKitRuntimeCoordinator(adapters)` with one promise-tail queue and public `applyActivation(selection)` / `applyUninstall(id)` methods.
- [ ] Keep generation values immutable. Clear stopped-process handles through adapters before starting the next generation. Do not import Electron in this module.
- [ ] Add `drain()` for before-quit and reject new transactions once `dispose()` begins.
- [ ] Add the test file to `npm test`, run focused tests, and commit: `[Bug] 增加 Framework 热重载协调器`

## Task 5: Add the live Kit Manager facade

**Files:**

- Create: `scripts/lib/live-kit-manager.mjs`
- Create: `scripts/lib/live-kit-manager.test.mjs`
- Modify: `scripts/lib/kit-manager-service.mjs`
- Modify: `scripts/lib/kit-manager-service.test.mjs`
- Modify: `scripts/lib/kit-registry/manager.mjs`
- Modify: `scripts/lib/kit-registry/manager.test.mjs`
- Modify: `package.json`

- [ ] Write tests that `install` downloads once, stages the installed version, invokes the coordinator, and returns `pending: false`, `requiresRestart: false`, `runtimeReloaded: true`.
- [ ] Cover already-active installs, updates, explicit activate, rollback, builtin uninstall rejection, staged uninstall cleanup/commit, cleanup failure retention, and runtime failure rollback.
- [ ] Run the focused tests and confirm facade tests fail before implementation.
- [ ] Keep `KitRegistryManager` responsible for validated download/install and selection only. Expose a narrow way for the facade to stage activation while retaining its per-Kit queue.
- [ ] Implement `createLiveKitManager({ manager, store, coordinator, uninstaller, builtinKitIds })`. Give all mutating methods one global serialized path via the coordinator; delegate `list` and `refresh` directly.
- [ ] For install/update, auto-stage and apply the requested version. For uninstall, stage first, ask the coordinator to exclude the Kit, remove only validated directories, then commit Store deletion; cancel staging on runtime failure but retain staging on cleanup failure.
- [ ] Wire `KitArtifactUninstaller` and the live facade from `createKitManagerService`, while still returning underlying dependencies needed by startup and tests.
- [ ] Run Registry Manager, live facade, and service tests.
- [ ] Commit: `[Bug] 让 Kit 管理操作即时应用`

## Task 6: Expose uninstall through the narrow IPC bridge

**Files:**

- Modify: `scripts/lib/kit-manager-ipc.mjs`
- Modify: `scripts/lib/kit-manager-ipc.test.mjs`
- Modify: `scripts/kit-manager-preload.cjs`
- Modify: `scripts/lib/kit-manager-preload.test.mjs`

- [ ] Add IPC tests for an `uninstall` channel accepting exactly one scoped lowercase Kit ID and rejecting objects, paths, extra arguments, malformed IDs, and a non-owner sender.
- [ ] Add preload tests proving only `uninstall(id)` forwards one scalar ID and no path-capable method is exposed.
- [ ] Run both focused test files and observe failures.
- [ ] Add `KIT_MANAGER_CHANNELS.uninstall`, parser, operation dispatch, and frozen preload bridge method.
- [ ] Keep serialized public errors bounded and preserve sender ownership checks.
- [ ] Run focused IPC/preload tests and commit: `[Bug] 增加 Kit 删除安全接口`

## Task 7: Integrate Framework generations into Electron

**Files:**

- Modify: `scripts/electron.mjs`
- Modify: `scripts/lib/electron-launcher.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`
- Modify: `scripts/lib/application-runtime-client.mjs` if an explicit stop/reset hook is missing
- Modify: `scripts/lib/application-runtime-client.test.mjs` if changed

- [ ] Add pure launcher tests for rebuilding a generation from `store.listActiveSources()` plus `discoverKits`, publishing Catalog/source snapshots atomically, reloading surviving windows with stable session IDs, and closing a deleted Kit window.
- [ ] Add source-guard assertions that Kit mutation paths do not call `app.relaunch()` and Notification Host startup is not part of Framework restart.
- [ ] Run focused launcher tests and observe failures.
- [ ] Extract reusable generation helpers into `electron-launcher.mjs` where practical; keep Electron globals adapted in `electron.mjs`.
- [ ] Start Notification Host once during initial host setup. Refactor Framework start/stop so each generation gets fresh `frameworkProcess`, `frameworkStop`, `frameworkStopPromise`, `frameworkReadyPromise`, and Application Runtime client state.
- [ ] Before restart, close the old events client, pause menu dispatch, clear stale session/menu maps, and await graceful Framework stop. Recompute installed sources and full Catalog, derive a new immutable source snapshot, start and validate the new Framework, then swap global Catalog data.
- [ ] Recreate Application Runtime events, bootstrap/menu state, and tray after the swap. Reload each surviving window through `createKitWindowUrl(startUrl, newKit, sameWorkspace)`; close the removed Kit window.
- [ ] Connect `createLiveKitManager` to Kit Manager IPC. Include coordinator `drain()` in desktop shutdown.
- [ ] Resume pending uninstall cleanup on app startup after the replacement Framework validates. Handle pending activation recovery inside the coordinator instead of `app.relaunch()`.
- [ ] Run `node --test scripts/lib/electron-launcher.test.mjs scripts/lib/application-runtime-client.test.mjs scripts/lib/kit-manager-service.test.mjs`.
- [ ] Commit: `[Bug] 接入桌面 Kit 热更新运行时`

## Task 8: Update the Chinese Manager interaction

**Files:**

- Modify: `scripts/lib/kit-manager-view.mjs`
- Modify: `scripts/lib/kit-manager-view.test.mjs`
- Modify: `scripts/kit-manager.html`
- Modify: `scripts/lib/kit-manager-acceptance.test.mjs`

- [ ] Add view tests that install/update complete as active without a second activation, activation says `立即启用`, rollback is immediate, and no successful state contains `重启` or `等待重启`.
- [ ] Add tests for exactly one `删除 Kit` button per installed non-builtin Kit, stable-card preference, preview fallback, builtin exclusion, confirmation cancellation, busy state, and success/error messages.
- [ ] Run focused view tests and observe failures.
- [ ] Require `api.uninstall`. Update status/action labels and install/update messages to the approved Chinese copy.
- [ ] Confirm before runtime-changing operations that open Kit windows will reload and unsaved page state may be lost; preserve the stronger native-code warning.
- [ ] Implement uninstall confirmation: `将关闭该 Kit 窗口并删除全部已安装版本。` Reload the projection after success.
- [ ] Remove the obsolete footer statement that uninstall is unsupported.
- [ ] Run view and Manager acceptance tests.
- [ ] Commit: `[Bug] 完成 Kit 管理器热更新交互`

## Task 9: Add end-to-end regression coverage and documentation

**Files:**

- Modify: `scripts/lib/kit-manager-acceptance.test.mjs`
- Modify: `scripts/lib/kit-registry/acceptance.test.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`
- Modify: `docs/guides/development-workflow.md` if runtime acceptance guidance needs clarification

- [ ] Add an acceptance harness with a temporary Store and publishable fixture that installs, activates, updates, and uninstalls across distinct simulated Framework generations.
- [ ] Assert Catalog/source/tray/window projections share one generation; update reloads the same BrowserWindow shell; uninstall closes only its target; all version directories are removed; and no relaunch is requested.
- [ ] Inject a target Runtime validation failure and prove the previous version is restored in one recovery generation while Electron-level services remain alive.
- [ ] Run all focused Kit tests:

  `node --test scripts/lib/kit-store/*.test.mjs scripts/lib/kit-registry/*.test.mjs scripts/lib/kit-runtime-coordinator.test.mjs scripts/lib/live-kit-manager.test.mjs scripts/lib/kit-manager-*.test.mjs scripts/lib/electron-launcher.test.mjs`

- [ ] Run `npm test -w @itharbors/kit-core` and `CI=1 npm run check`.
- [ ] Start development Electron and manually verify from the Chinese Kit Manager: install CSV, update it, open its window, uninstall it, and confirm the Electron PID/Manager/Notification Host remain alive while Framework PID changes.
- [ ] Record any environment limitation explicitly; do not claim live acceptance without observed evidence.
- [ ] Commit: `[Bug] 验证 Kit 热更新完整流程`

## Completion Audit

- [ ] Compare every test and implementation outcome with the approved design document section by section.
- [ ] Confirm `git status --short` contains no accidental files and review the complete branch diff.
- [ ] Run the verification-before-completion checklist with fresh command output.
- [ ] Only then report install/update/activate/rollback/uninstall as restart-free.
