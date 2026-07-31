# TraceWeave Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the verified standalone TraceWeave Codex workflow debugger into a publishable Harbors Kit with no separate service or port.

**Architecture:** A Session-scoped core plugin reads and normalizes local Codex JSONL into a canonical trace model, then exposes immutable snapshots through Harbors message requests. A single React Panel consumes that protocol and renders the bounded four-stage Flow view, full Events diagnostics, replay, filters, and redacted evidence inspector.

**Tech Stack:** TypeScript 5.7, Node.js 22, React 19 bundled by esbuild, Harbors plugin/message/Panel runtime, Vitest, jsdom, Node test runner, Kit Core/CLI

## Global Constraints

- Kit id is `@itharbors/kit-traceweave`, slug is `traceweave`, and initial version is `0.1.0-preview.1`.
- The Kit declares only the `filesystem` permission and starts no HTTP listener.
- The canonical trace never exposes Codex Home or rollout absolute paths to the Panel.
- Skill evidence is always inferred, names a rule and source, and has confidence below 1.
- Raw evidence is recursively redacted and bounded to 65,536 serialized characters before crossing the browser boundary.
- Flow is the default and always renders exactly four stage positions per turn.
- Events never infers concurrency from timestamps or semantic columns.
- Codex source files are read-only and must remain unchanged during real-session verification.
- Every behavioral production change follows red → green → refactor.
- Commits use `[Feature]` with a concise Chinese summary and no trailing period.

---

### Task 1: Register the official Kit and shared protocol workspace

**Files:**
- Modify: `registry/policy.json`
- Modify: `scripts/lib/kit-monorepo.mjs`
- Modify: `scripts/lib/kit-monorepo.test.mjs`
- Modify: `scripts/check-kit.mjs`
- Modify: `scripts/lib/kit-check.test.mjs`
- Modify: `package.json`
- Modify: `scripts/lib/build-tasks.mjs`
- Modify: `scripts/lib/build-tasks.test.mjs`
- Create: `packages/traceweave-contracts/package.json`
- Create: `packages/traceweave-contracts/tsconfig.json`
- Create: `packages/traceweave-contracts/src/index.ts`
- Create: `packages/traceweave-contracts/tests/contracts.test.ts`
- Create: `kits/traceweave/package.json`
- Create: `kits/traceweave/kit.json`
- Create: `kits/traceweave/layout.json`
- Create: `kits/traceweave/main.html`
- Create: `kits/traceweave/secondary.html`
- Create: `kits/traceweave/vitest.config.ts`
- Create: `kits/traceweave/tests/kit-manifest.test.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `TRACEWEAVE_PLUGIN = "@itharbors/traceweave-core"`, request/response types, trace types, `TraceweaveErrorEnvelope`, `isTraceweaveError()`.
- Produces: an official empty Kit shell declaring core and view plugins that later tasks fill.

- [ ] **Step 1: Write failing policy, manifest, and contract tests**

Assert the official set equals `['csv', 'mysql', 'notifications', 'sqlite', 'traceweave']`, policy metadata uses `ubuntu-latest`, and the Kit layout contains one simple `@itharbors/traceweave-view.trace` Panel. Assert `isTraceweaveError({ $traceweaveError: { code: 'RUN_NOT_FOUND', message: 'Run not found' } })` is true and rejects malformed envelopes.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test scripts/lib/kit-monorepo.test.mjs scripts/lib/kit-check.test.mjs scripts/lib/build-tasks.test.mjs
npx vitest run packages/traceweave-contracts/tests/contracts.test.ts kits/traceweave/tests/kit-manifest.test.ts
```

Expected: official Kit assertions fail because `traceweave` and the contracts package do not exist.

- [ ] **Step 3: Add the minimal official Kit and contracts implementation**

Define strict serializable interfaces for `TraceRun`, `TraceTurn`, `TraceNode`, `TraceEdge`, `RunSummary`, `RawEvidenceResponse`, `LoadRunInput`, `LoadRawEvidenceInput`, and public error codes. Register the new workspace in root build/test scripts and build task dependency map. Add Preview manifests, filesystem permission, one Panel layout, and policy metadata.

- [ ] **Step 4: Refresh the lockfile and verify GREEN**

Run:

```bash
npm install --package-lock-only
npm run build -w @itharbors/traceweave-contracts
node --test scripts/lib/kit-monorepo.test.mjs scripts/lib/kit-check.test.mjs scripts/lib/build-tasks.test.mjs
npx vitest run packages/traceweave-contracts/tests/contracts.test.ts kits/traceweave/tests/kit-manifest.test.ts
```

Expected: all focused tests pass and the lock contains `kits/traceweave` plus `packages/traceweave-contracts`.

- [ ] **Step 5: Commit**

```bash
git add registry/policy.json scripts/check-kit.mjs scripts/lib/kit-monorepo.mjs scripts/lib/kit-monorepo.test.mjs scripts/lib/kit-check.test.mjs scripts/lib/build-tasks.mjs scripts/lib/build-tasks.test.mjs package.json package-lock.json packages/traceweave-contracts kits/traceweave
git commit -m "[Feature] 注册 TraceWeave 官方 Kit"
```

### Task 2: Parse, normalize, and protect Codex evidence

**Files:**
- Create: `kits/traceweave/plugins/traceweave-core/package.json`
- Create: `kits/traceweave/plugins/traceweave-core/main/src/index.ts`
- Create: `kits/traceweave/plugins/traceweave-core/main/src/codex-discovery.ts`
- Create: `kits/traceweave/plugins/traceweave-core/main/src/parse-rollout.ts`
- Create: `kits/traceweave/plugins/traceweave-core/main/src/normalize.ts`
- Create: `kits/traceweave/plugins/traceweave-core/main/src/skill-inference.ts`
- Create: `kits/traceweave/plugins/traceweave-core/main/src/redact.ts`
- Create: `kits/traceweave/plugins/traceweave-core/main/src/registry.ts`
- Create: `kits/traceweave/plugins/traceweave-core/main/src/service.ts`
- Create: `kits/traceweave/plugins/traceweave-core/tests/fixtures/two-turn.jsonl`
- Create: `kits/traceweave/plugins/traceweave-core/tests/fixtures/malformed.jsonl`
- Create: `kits/traceweave/plugins/traceweave-core/tests/discovery.test.ts`
- Create: `kits/traceweave/plugins/traceweave-core/tests/parse-rollout.test.ts`
- Create: `kits/traceweave/plugins/traceweave-core/tests/normalize.test.ts`
- Create: `kits/traceweave/plugins/traceweave-core/tests/skill-inference.test.ts`
- Create: `kits/traceweave/plugins/traceweave-core/tests/redact.test.ts`
- Create: `kits/traceweave/plugins/traceweave-core/tests/service.test.ts`

**Interfaces:**
- Consumes: trace contracts from Task 1.
- Produces: `discoverCodexRuns(codexHome)`, `parseRollout(stream)`, `normalizeCodexRun(parsed)`, `redactSecrets(value)`, and `TraceweaveService` methods `listRuns`, `loadRun`, `loadRawEvidence`, `refresh`, `dispose`.

- [ ] **Step 1: Add sanitized fixtures and failing parser tests**

The two-turn fixture must include a user message, reasoning summary, explicit `SKILL.md` read, tool call/output pair, spawned sub-agent, and assistant response. Assert malformed lines produce `malformed_json`, unknown records produce `unknown_event`, and valid lines survive.

- [ ] **Step 2: Run parser tests and verify RED**

```bash
npx vitest run --config kits/traceweave/vitest.config.ts plugins/traceweave-core/tests/parse-rollout.test.ts plugins/traceweave-core/tests/discovery.test.ts
```

Expected: imports fail because discovery and parser modules are absent.

- [ ] **Step 3: Implement streaming parser and root-bounded discovery**

Read JSONL with `readline`, assign monotonically increasing raw offsets, retain bounded raw objects, and continue after malformed lines. Discover only regular `rollout-*.jsonl` files under `sessions` and `archived_sessions`; ignore symbolic links and generate opaque ids through `RunRegistry`.

- [ ] **Step 4: Verify parser GREEN**

Run the Step 2 command. Expected: both suites pass without warnings on stderr.

- [ ] **Step 5: Add failing normalization, skill, redaction, and service tests**

Assert four evidence classes and invariants, tool pairing, missing-pair warnings, explicit-only Skill inference, recursive secret masking, opaque ids, mtime/size cache invalidation, 65,536-character truncation, and unchanged source stat before/after load.

- [ ] **Step 6: Run the new tests and verify RED**

```bash
npx vitest run --config kits/traceweave/vitest.config.ts plugins/traceweave-core/tests/normalize.test.ts plugins/traceweave-core/tests/skill-inference.test.ts plugins/traceweave-core/tests/redact.test.ts plugins/traceweave-core/tests/service.test.ts
```

Expected: missing production exports cause failures.

- [ ] **Step 7: Implement normalization and service**

Map intents, goals/plans/reasoning, skills, tools/results, sub-agents, responses and errors into turns. Enforce source evidence on every node. Resolve `CODEX_HOME` or `<homedir>/.codex`, cache by size/mtime, redact before returning raw evidence, and project workspace to basename only.

- [ ] **Step 8: Run all core tests and verify GREEN**

```bash
npx vitest run --config kits/traceweave/vitest.config.ts plugins/traceweave-core/tests
```

Expected: every core suite passes.

- [ ] **Step 9: Commit**

```bash
git add kits/traceweave/plugins/traceweave-core kits/traceweave/package.json package-lock.json
git commit -m "[Feature] 迁移 Codex Trace 解析核心"
```

### Task 3: Expose the core through the Harbors Session message runtime

**Files:**
- Modify: `kits/traceweave/plugins/traceweave-core/main/src/index.ts`
- Modify: `kits/traceweave/plugins/traceweave-core/package.json`
- Create: `kits/traceweave/plugins/traceweave-core/tests/plugin-main.test.ts`
- Create: `kits/traceweave/tests/runtime-integration.test.ts`

**Interfaces:**
- Consumes: `TraceweaveService` from Task 2.
- Produces: Harbors request methods `listRuns`, `loadRun`, `loadRawEvidence`, `refresh`, and `openTracePanel`.

- [ ] **Step 1: Write failing plugin and real runtime integration tests**

Capture `editor.plugin.define()`, load a temporary Codex Home, and assert methods return immutable snapshots and public envelopes. Then create a real Editor with the TraceWeave Kit and request list → load → raw evidence through `@itharbors/message`.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config kits/traceweave/vitest.config.ts plugins/traceweave-core/tests/plugin-main.test.ts tests/runtime-integration.test.ts
```

Expected: message contributions or method implementations are missing.

- [ ] **Step 3: Implement the plugin bridge**

Create one service per plugin instance during `load`, route validated inputs, wrap expected failures in `$traceweaveError`, broadcast no file data, and call `service.dispose()` idempotently during unload. `openTracePanel` delegates to `runtime.window.openPanel('@itharbors/traceweave-view.trace')`.

- [ ] **Step 4: Run and verify GREEN**

Run the Step 2 command. Expected: both direct and real runtime paths pass.

- [ ] **Step 5: Commit**

```bash
git add kits/traceweave/plugins/traceweave-core kits/traceweave/tests/runtime-integration.test.ts
git commit -m "[Feature] 接入 TraceWeave 会话消息协议"
```

### Task 4: Add TSX-capable Panel builds and the Flow experience

**Files:**
- Modify: `scripts/lib/plugin-build/scripts.mjs`
- Modify: `scripts/lib/plugin-build/scripts.test.mjs`
- Create: `kits/traceweave/plugins/traceweave-view/package.json`
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/index.html`
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/index.css`
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/index.ts`
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/app.tsx`
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/api.ts`
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/flow-projection.ts`
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/components/run-rail.tsx`
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/components/toolbar.tsx`
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/components/flow-overview.tsx`
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/components/flow-stage.tsx`
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/components/status-view.tsx`
- Create: `kits/traceweave/plugins/traceweave-view/tests/flow-projection.test.ts`
- Create: `kits/traceweave/plugins/traceweave-view/tests/panel.test.tsx`

**Interfaces:**
- Consumes: `ctx.message.request(plugin, method, input?)` and trace contracts.
- Produces: default Panel definition with `mount`/`unmount`; `projectFlowTurns(run, options)` returning exactly four stages per turn.

- [ ] **Step 1: Add a failing build-tool test for imported TSX**

Create a temporary Panel whose `index.ts` imports `app.tsx` using `react/jsx-runtime`; assert `compilePanelScripts` typechecks and bundles it.

- [ ] **Step 2: Run and verify RED**

```bash
node --test scripts/lib/plugin-build/scripts.test.mjs
```

Expected: TypeScript reports JSX is not enabled.

- [ ] **Step 3: Enable `react-jsx` for Panel typechecking**

Add `--jsx react-jsx` only to browser Panel typechecking; keep main scripts unchanged. Verify Step 2 passes.

- [ ] **Step 4: Write failing Flow and lifecycle tests**

Assert every turn projects `[input, understand, execute, output]`, empty stages use honest placeholders, replay hides unrevealed nodes, Execute summarizes grouped actions, mount renders the run rail and default Flow, and unmount calls `root.unmount()`.

- [ ] **Step 5: Run and verify RED**

```bash
npx vitest run --config kits/traceweave/vitest.config.ts plugins/traceweave-view/tests/flow-projection.test.ts plugins/traceweave-view/tests/panel.test.tsx
```

Expected: view modules are missing.

- [ ] **Step 6: Implement Panel bridge, application state, and Flow**

Bundle React/ReactDOM from Kit dev dependencies. Use `TraceweaveApi` backed only by message requests. Render loading, empty, error/retry, run selection, four-stage Flow, collapsed turns, expanded chronological detail and replay. Apply the signal-spine CSS token system from the design.

- [ ] **Step 7: Run focused tests and build; verify GREEN**

```bash
npx vitest run --config kits/traceweave/vitest.config.ts plugins/traceweave-view/tests/flow-projection.test.ts plugins/traceweave-view/tests/panel.test.tsx
node scripts/ce-plugin.mjs build kits/traceweave/plugins/traceweave-view
```

Expected: tests pass and Panel dist contains `index.html`, `index.css`, and bundled `index.js`.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/plugin-build/scripts.mjs scripts/lib/plugin-build/scripts.test.mjs kits/traceweave/plugins/traceweave-view kits/traceweave/package.json package-lock.json
git commit -m "[Feature] 实现 TraceWeave 四阶段主视图"
```

### Task 5: Restore Events diagnostics, replay filters, and evidence inspection

**Files:**
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/event-projection.ts`
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/replay.ts`
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/components/events-board.tsx`
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/components/event-node.tsx`
- Create: `kits/traceweave/plugins/traceweave-view/panel.trace/src/components/inspector.tsx`
- Modify: `kits/traceweave/plugins/traceweave-view/panel.trace/src/app.tsx`
- Modify: `kits/traceweave/plugins/traceweave-view/panel.trace/src/components/toolbar.tsx`
- Modify: `kits/traceweave/plugins/traceweave-view/panel.trace/src/index.css`
- Create: `kits/traceweave/plugins/traceweave-view/tests/event-projection.test.ts`
- Create: `kits/traceweave/plugins/traceweave-view/tests/events-board.test.tsx`
- Create: `kits/traceweave/plugins/traceweave-view/tests/inspector.test.tsx`
- Create: `kits/traceweave/plugins/traceweave-view/tests/replay.test.ts`

**Interfaces:**
- Consumes: canonical `TraceRun` and `TraceweaveApi.loadRawEvidence`.
- Produces: `projectEvents(run, options)`, `createReplayController(maxOffset, reducedMotion)`, Events view and focus-restoring inspector.

- [ ] **Step 1: Write failing pure projection and replay tests**

Assert evidence filters, successful-tool filter, collapsed turns, replay offsets, stable left-to-right kind columns, bounded node positions and edges whose endpoints remain visible. Assert reduced motion advances directly without timers.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config kits/traceweave/vitest.config.ts plugins/traceweave-view/tests/event-projection.test.ts plugins/traceweave-view/tests/replay.test.ts
```

Expected: projection and replay modules are missing.

- [ ] **Step 3: Implement pure projection and replay, then verify GREEN**

Use deterministic positions, SVG paths behind absolutely positioned semantic buttons, a scale range of 0.5–1.25, and a scrollable canvas. Do not infer branches or concurrency. Re-run Step 2.

- [ ] **Step 4: Write failing Events and inspector component tests**

Assert Flow/Events switching, evidence checkbox labels, hide-successful-tools behavior, zoom controls, node selection, redacted raw JSON, truncation notice, close action, Escape action and focus restoration.

- [ ] **Step 5: Run and verify RED**

```bash
npx vitest run --config kits/traceweave/vitest.config.ts plugins/traceweave-view/tests/events-board.test.tsx plugins/traceweave-view/tests/inspector.test.tsx
```

Expected: components are missing from the application.

- [ ] **Step 6: Implement Events and inspector; verify GREEN**

Keep Flow default. Show diagnostic-only filters only in Events. Request raw evidence lazily when the inspector opens, render normalized metadata immediately, restore focus to the originating activity, and close on Escape.

- [ ] **Step 7: Commit**

```bash
git add kits/traceweave/plugins/traceweave-view
git commit -m "[Feature] 恢复 TraceWeave 事件诊断能力"
```

### Task 6: Complete accessibility, dense-run, packaging, and documentation gates

**Files:**
- Create: `kits/traceweave/plugins/traceweave-view/tests/accessibility.test.tsx`
- Create: `kits/traceweave/plugins/traceweave-view/tests/dense-run.test.tsx`
- Create: `kits/traceweave/tests/panel-accessibility.test.ts`
- Create: `kits/traceweave/scripts/verify-real-session.ts`
- Create: `kits/traceweave/tests/verify-real-session.test.ts`
- Create: `kits/traceweave/README.md`
- Modify: `readme.md`
- Modify: `docs/README.md`
- Modify: `docs/architecture/kit-and-session-model.md`
- Modify: `docs/guides/developing-plugins-and-kits.md`
- Modify: `package.json`
- Modify: `scripts/check-kit.mjs`
- Modify: `scripts/lib/kit-check.test.mjs`

**Interfaces:**
- Consumes: completed core and view.
- Produces: `npm run verify:real -w @itharbors/kit-traceweave` and an official Kit accepted by targeted check/pack/inspect.

- [ ] **Step 1: Add failing accessibility and dense-run acceptance tests**

Assert native buttons, programmatic expansion, visible focus rules, 44px stage targets, reduced-motion CSS, narrow layout media query, no page-level horizontal overflow contract, and at most four primary stage cards per turn for a 4,000-node run.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config kits/traceweave/vitest.config.ts plugins/traceweave-view/tests/accessibility.test.tsx plugins/traceweave-view/tests/dense-run.test.tsx tests/panel-accessibility.test.ts
```

Expected: at least one acceptance requirement is absent.

- [ ] **Step 3: Fix only the failing acceptance requirements and verify GREEN**

Re-run Step 2 and ensure no console errors or act warnings remain.

- [ ] **Step 4: Add the failing real-session verifier test**

Use a temporary Codex Home fixture to assert output contains `TraceWeave real-session verification: PASS`, aggregate counts and `source_unchanged=true`, while excluding prompts, paths and tool arguments.

- [ ] **Step 5: Implement and run the verifier**

```bash
npx vitest run --config kits/traceweave/vitest.config.ts tests/verify-real-session.test.ts
npm run verify:real -w @itharbors/kit-traceweave
```

Expected: fixture test passes; the real command either finds an eligible local run and passes or emits one explicit no-eligible-run failure without source data.

- [ ] **Step 6: Document the Kit and update official docs**

Document install/development start, Flow and Events usage, evidence truth labels, privacy, Codex file support, tests and troubleshooting. Add TraceWeave to repository navigation and official Kit lists.

- [ ] **Step 7: Run targeted Kit and repository integration gates**

```bash
npm run build -w @itharbors/kit-traceweave
npm test -w @itharbors/kit-traceweave
npm run plugins:check
node --test scripts/lib/kit-monorepo.test.mjs scripts/lib/kit-ci-selection.test.mjs scripts/lib/kit-check.test.mjs scripts/lib/plugin-build/scripts.test.mjs
```

Expected: all pass.

- [ ] **Step 8: Pack and inspect the official Kit**

```bash
output_dir=$(mktemp -d)
npm run kit:check -- traceweave --output-directory "$output_dir"
```

Expected: output contains `KIT=traceweave` and one inspected `.hkit` artifact outside the repository.

- [ ] **Step 9: Commit**

```bash
git add kits/traceweave readme.md docs package.json scripts/check-kit.mjs scripts/lib/kit-check.test.mjs
git commit -m "[Feature] 完成 TraceWeave Kit 验收与文档"
```

### Task 7: Final verification and PR-ready audit

**Files:**
- Review: every file changed since `origin/main`

**Interfaces:**
- Produces: a clean branch whose commits are all `[Feature]` and whose checks are fresh.

- [ ] **Step 1: Run the complete relevant verification**

```bash
npm run build
npm test
npm run plugins:check
```

Expected: exit 0 with no failed tests.

- [ ] **Step 2: Audit changes and repository state**

```bash
git status --short
git diff --check origin/main...HEAD
git log --format='%s' origin/main..HEAD
git diff --stat origin/main...HEAD
```

Expected: clean status, no whitespace errors, only `[Feature]` commit titles, and no generated caches or source Codex data.

- [ ] **Step 3: Review the spec against the implementation**

Check each item in `docs/superpowers/specs/2026-07-31-traceweave-kit-design.md` section 8 against a named fresh test or command result. Fix any gap through a new failing test before changing production code.

- [ ] **Step 4: Prepare PR metadata without publishing a Kit release**

Use summary `迁移 Codex 多轮编排可视化为 TraceWeave Kit`. The PR body contains `## Summary` and `## Testing`, lists only commands actually run, and explicitly states that no `kit/traceweave/v*` release Tag was created.
