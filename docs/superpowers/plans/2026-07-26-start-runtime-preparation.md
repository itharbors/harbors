# Start Runtime Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run start` build every required workspace and plugin artifact before Electron loads repository modules.

**Architecture:** Use npm's `prestart` lifecycle as the single sequencing boundary. It delegates to the existing root `build` script, so build ordering and error propagation remain owned by the current build command while the Electron entry and argument forwarding stay unchanged.

**Tech Stack:** npm workspaces, npm lifecycle scripts, Node.js test runner, Electron

## Global Constraints

- Keep `start` equal to `electron scripts/electron.mjs`.
- Keep `electron` equal to `npm run start --`.
- Do not introduce incremental caching or a second build implementation.
- A failed build must prevent Electron from starting and preserve the failing exit status.

---

### Task 1: Add startup build preparation

**Files:**
- Modify: `scripts/lib/electron-launcher.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: root npm script `build`
- Produces: root npm lifecycle script `prestart`, invoked automatically by `npm run start`

- [ ] **Step 1: Write the failing regression test**

Extend the existing `keeps electron stable and makes dev an isolated Electron entry` test with the lifecycle contract:

```js
assert.equal(packageJson.scripts.prestart, 'npm run build');
```

Keep the existing `start`, `electron`, and `dev` assertions so the fix cannot replace their entry or forwarding behavior.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test scripts/lib/electron-launcher.test.mjs
```

Expected: FAIL because `packageJson.scripts.prestart` is `undefined` instead of `npm run build`.

- [ ] **Step 3: Implement the minimal lifecycle change**

Add the following root script immediately before `start` in `package.json`:

```json
"prestart": "npm run build"
```

Do not modify `start`, `electron`, `dev`, or the existing `build` command.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test scripts/lib/electron-launcher.test.mjs
```

Expected: PASS with zero failures.

- [ ] **Step 5: Verify a clean runtime startup**

Run:

```bash
npm run clean
npm run start
```

Expected: `prestart` completes the root build before Electron starts; then Notification Host, Gateway, Server, and Vite report ready on stable `4838x` ports. Stop the long-running process with `SIGINT` after readiness.

- [ ] **Step 6: Inspect and commit the focused fix**

Run:

```bash
git status --short
git diff --check
git diff -- package.json scripts/lib/electron-launcher.test.mjs
git add package.json scripts/lib/electron-launcher.test.mjs
git diff --cached --check
git commit -m "[Bug] 修复桌面端启动产物准备"
```

Expected: only the lifecycle script and its regression assertion are included in the implementation commit.
