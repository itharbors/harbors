# Electron Gatekeeper Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore macOS development startup by replacing the revoked Electron 31 runtime with a supported Electron release.

**Architecture:** Keep one exact Electron version aligned across the npm development dependency, electron-builder configuration, and native-addon rebuild step. Reuse the existing desktop packaging test to protect the ABI version passed to `@electron/rebuild`, then verify both the focused desktop tests and a real Electron launch.

**Tech Stack:** npm workspaces, Electron, electron-builder, Node.js test runner

## Global Constraints

- Use Electron `43.2.0`, the latest stable release selected for this fix.
- Use `better-sqlite3@12.10.1` or compatible declarations so native rebuilds support Electron ABI 148.
- Require Node.js `22.12.0` or newer, matching Electron's package tooling requirement.
- Keep the desktop packaging target on macOS arm64.
- Do not change application behavior beyond the Electron runtime upgrade.

---

### Task 1: Align and verify the Electron runtime

**Files:**
- Modify: `scripts/lib/desktop-package.test.mjs`
- Modify: `scripts/lib/desktop-package-build.mjs`
- Modify: `electron-builder.config.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/desktop/package.json`
- Modify: `packages/server/package.json`
- Modify: `kits/csv/package.json`
- Modify: `kits/sqlite/package.json`
- Modify: `kits/csv/plugins/csv-core/package.json`
- Modify: `kits/sqlite/plugins/sqlite-core/package.json`
- Modify: `readme.md`
- Modify: `docs/guides/development-workflow.md`

**Interfaces:**
- Consumes: root `devDependencies.electron`, `electron-builder.config.mjs`, and `createDesktopPackageSteps()`
- Produces: one Electron `43.2.0` runtime and matching native-addon ABI rebuild argument

- [x] **Step 1: Update the packaging regression expectation**

Change the expected `@electron/rebuild` version in `scripts/lib/desktop-package.test.mjs`:

```js
assert.deepEqual(runner.calls[1].args, [
  '/workspace/harbors/node_modules/@electron/rebuild/bin/cli.js',
  '-f',
  '-w',
  'better-sqlite3',
  '--version',
  '43.2.0',
  '--arch',
  'arm64',
]);
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test scripts/lib/desktop-package.test.mjs`

Expected: FAIL because the production packaging step still passes `31.7.7`.

- [x] **Step 3: Update all Electron version consumers**

Set `DESKTOP_ELECTRON_VERSION` and `electronVersion` to `43.2.0`, then install the exact root development dependency:

```bash
npm install --save-dev --save-exact electron@43.2.0
```

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `node --test scripts/lib/desktop-package.test.mjs scripts/lib/electron-launcher.test.mjs`

Expected: PASS with zero failures.

- [x] **Step 5: Verify the repaired startup path**

Run: `node_modules/.bin/electron --version`

Expected: `v43.2.0` and exit code 0.

Run: `npm run start`

Expected: Electron stays running without `ENOENT`, `SIGKILL`, or Gatekeeper moving the app bundle to Trash.

Run: `npm run desktop:dir`

Expected: `better-sqlite3` rebuilds for Electron 43/arm64 and electron-builder produces the unpacked application directory.

Run the packaged Electron executable with `ELECTRON_RUN_AS_NODE=1` and load the bundled `better-sqlite3` from `app.asar`.

Expected: Electron reports module ABI `148` and an in-memory SQLite query succeeds.

- [x] **Step 6: Commit the focused fix**

```bash
git add package.json package-lock.json electron-builder.config.mjs scripts/lib/desktop-package-build.mjs scripts/lib/desktop-package.test.mjs docs/superpowers/plans/2026-07-26-electron-gatekeeper.md
git commit -m "[Bug] 升级 Electron 修复 macOS 启动"
```
