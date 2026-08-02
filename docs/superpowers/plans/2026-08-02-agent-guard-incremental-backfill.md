# Agent Guard Incremental Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist Agent Guard backfill checkpoints across local Web and desktop restarts, resume incrementally without permanent file caps, and expose trustworthy Claude/Codex progress in Settings.

**Architecture:** Keep NDJSON history as the source of derived usage and evolve the cursor file into a versioned, privacy-safe checkpoint. A single backfill coordinator discovers all candidates, processes recent eligible files within per-run budgets, persists offsets after every batch, and exposes runtime progress through `HistoryStatus`; the panel polls that status and renders it without adding a new push channel.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest, JSDOM panel tests, Node test runner for development launcher tests, existing Harbors Kit RPC bridge.

## Global Constraints

- Use Web development and browser acceptance; do not start Electron.
- Preserve prompt, response, credential, Authorization, raw path, and raw filename privacy boundaries.
- Web development cache lives at the current worktree's ignored `.cache/agent-guard/web`; desktop remains in its existing application data directory.
- Explicit absolute `HARBORS_AGENT_GUARD_DATA_DIR` enables file history for either host; no data directory keeps memory behavior.
- A batch budget limits work, never the total discoverable history.
- Only a cursor with matching identity, parser version, size/mtime, and `offset >= size` may be skipped as complete.
- Keep commits in the feature branch and use `[Feature]` Chinese titles.

---

## File Structure

- `packages/agent-guard-contracts/src/contracts.ts`: public backfill progress/status types and strict normalizers.
- `kits/agent-guard/plugins/agent-guard-background/main/src/history-storage.ts`: versioned checkpoint persistence, v1 migration, file/memory history selection.
- `kits/agent-guard/plugins/agent-guard-background/main/src/usage-backfill.ts`: discovery, recent-first eligibility, bounded incremental parsing, progress and coordination.
- `kits/agent-guard/plugins/agent-guard-background/main/src/service.ts`: lifecycle scheduling, status composition and manual continuation.
- `kits/agent-guard/plugins/agent-guard-background/main/src/index.ts`: background RPC entry.
- `kits/agent-guard/plugins/agent-guard-center/main/src/index.ts`: center-to-background RPC bridge.
- `kits/agent-guard/plugins/agent-guard-{background,center}/package.json`: allowed RPC methods.
- `scripts/lib/dev-launcher.mjs` and `scripts/dev.mjs`: isolated default Web cache path.
- `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts`: progress view and manual continuation action.
- `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.css`: compact progress layout.

---

### Task 1: Public Progress Contract and Versioned Checkpoint

**Files:**
- Modify: `packages/agent-guard-contracts/src/contracts.ts`
- Create: `kits/agent-guard/tests/history-contracts.test.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-background/main/src/history-storage.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-background/tests/history-storage.test.ts`

**Interfaces:**
- Produces: `HistoryBackfillState`, `AgentBackfillProgress`, `HistoryBackfillProgress`, and required `HistoryStatus.backfill`.
- Produces: `BackfillCheckpointV2`, `BackfillCursorV2`, `loadBackfillCheckpoint()`, and `saveBackfillCheckpoint()` on `HistoryStore`.
- Produces: internal `HistoryStorageStatus = Omit<HistoryStatus, 'backfill'>`; stores return storage facts and the service adds live progress.
- Migration input: the existing `Record<string, BackfillCursorV1>` top-level JSON.

- [ ] **Step 1: Write failing contract tests**

Add literal fixtures proving `normalizeHistoryStatus` accepts all seven states, Claude/Codex progress, nullable `remainingFiles`, timestamps, counters and a safe message, while rejecting unknown fields, negative counters and missing Agent entries. Use a hand-written fixture shaped like:

```ts
backfill: {
  state: 'scanning',
  runId: 4,
  startedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  completedAt: null,
  filesDiscovered: 24,
  filesEligible: 8,
  filesScanned: 3,
  filesSkipped: 16,
  bytesRead: 4096,
  eventsWritten: 7,
  unsupportedRecords: 2,
  errors: 0,
  remainingFiles: 5,
  lastSuccessfulEventAt: 1_699_999_999_000,
  message: 'scanning',
  agents: [
    { agent: 'claude', filesDiscovered: 20, filesEligible: 6, filesScanned: 2, filesSkipped: 14, eventsWritten: 5, errors: 0 },
    { agent: 'codex', filesDiscovered: 4, filesEligible: 2, filesScanned: 1, filesSkipped: 2, eventsWritten: 2, errors: 0 },
  ],
}
```

- [ ] **Step 2: Run contract tests and verify RED**

Run: `npx vitest run --root kits/agent-guard --config vitest.config.ts tests/history-contracts.test.ts`

Expected: failure because `HistoryStatus.backfill` and its normalizer do not exist.

- [ ] **Step 3: Implement strict progress types and normalization**

Add the three exported types, require fixed Claude/Codex order, bound `message` to 128 characters, reuse existing integer/nullable helpers, and include `backfill` in the exact `HistoryStatus` field list. Keep `schemaVersion: 1`; history status is runtime output, not a persisted schema.

- [ ] **Step 4: Write failing checkpoint migration tests**

Cover memory clone isolation, v2 atomic round-trip, and migration of a v1 cursor:

```ts
{
  abc: { identityDigest: 'abc', size: 20, mtimeMs: 30, offset: 20, sessionCounted: true }
}
```

Expected migration: `schemaVersion: 2`, `parserVersion: 1`, `complete: true`, `agent: null`, `lastEventAt: null`, `lastRun: null`.

- [ ] **Step 5: Run storage tests and verify RED**

Run: `npx vitest run --root kits/agent-guard --config vitest.config.ts plugins/agent-guard-background/tests/history-storage.test.ts`

Expected: failure because the checkpoint methods and v2 schema are absent.

- [ ] **Step 6: Implement checkpoint persistence**

Use these shapes:

```ts
export interface BackfillCursorV2 {
  identityDigest: string;
  agent: 'claude' | 'codex' | null;
  size: number;
  mtimeMs: number;
  offset: number;
  sessionCounted: boolean;
  parserVersion: number;
  complete: boolean;
  lastEventAt: number | null;
}

export interface BackfillCheckpointV2 {
  schemaVersion: 2;
  cursors: Record<string, BackfillCursorV2>;
  lastRun: HistoryBackfillProgress | null;
}
```

Memory storage keeps a structured clone. File storage reads both v1 and v2 and always writes v2 using the existing atomic JSON helper and permissions. `clearHistory()` resets cursors/lastRun but preserves settings.

Change `HistoryStore.status()` and `HistoryStore.updateSettings()` to return `HistoryStorageStatus`, because the storage layer cannot own runtime progress. The service is the only layer that constructs the complete public `HistoryStatus`.

- [ ] **Step 7: Verify Task 1**

Run:

```bash
npx vitest run --root kits/agent-guard --config vitest.config.ts tests/history-contracts.test.ts
npx vitest run --root kits/agent-guard --config vitest.config.ts plugins/agent-guard-background/tests/history-storage.test.ts
```

Expected: both test files pass and `git diff --check` is clean.

- [ ] **Step 8: Controller commit after independent review**

Commit title: `[Feature] 定义 Agent Guard 回填进度与检查点`

---

### Task 2: Recent-First Incremental Backfill Engine

**Files:**
- Modify: `kits/agent-guard/plugins/agent-guard-background/main/src/usage-backfill.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-background/tests/usage-backfill.test.ts`

**Interfaces:**
- Consumes: `BackfillCheckpointV2`, `BackfillCursorV2`, `HistoryBackfillProgress` from Task 1.
- Produces: `createUsageBackfiller(options)` with `requestRun()`, `status()`, and `dispose()`.
- `requestRun()` returns one `BackfillReport` and coalesces concurrent calls into the active run plus at most one queued rerun.

- [ ] **Step 1: Add failing incremental edge-case tests**

Use temporary roots and a real memory `HistoryStore`. Add separate tests proving:

- A 4 MiB plus two-line file is consumed across multiple batches even when size/mtime stop changing.
- An unchanged complete file is skipped after restart from a saved v2 checkpoint.
- A grown file resumes at offset; a truncated file restarts at zero.
- A parser-version mismatch reparses and event digests prevent duplicate totals.
- More candidates than `maxFilesPerBatch` reach `remainingFiles: 0` across repeated runs.
- Candidate ordering is modification-time descending.
- Missing Claude root does not prevent Codex completion.
- Two concurrent `requestRun()` calls never parse the same file concurrently.

Inject small test budgets through options:

```ts
limits: { maxFilesPerBatch: 2, maxBytesPerFileBatch: 128, maxDiscoveredFiles: 100_000 }
```

- [ ] **Step 2: Run the backfill tests and verify RED**

Run: `npx vitest run --root kits/agent-guard --config vitest.config.ts plugins/agent-guard-background/tests/usage-backfill.test.ts`

Expected: failures for incomplete-file skipping, permanent discovery cap, absent progress and concurrent runs.

- [ ] **Step 3: Separate discovery, eligibility and parsing**

Discover all candidates up to the high safety ceiling, collect safe metadata, sort newest first, and select only incomplete/grown/truncated/version-stale files for the current batch. Do not include raw paths or filenames in reports or checkpoints.

- [ ] **Step 4: Implement resumable bounded reads**

Advance offset by complete newline bytes only. Set `complete` only when the persisted offset reaches current size. Preserve a partial trailing line for the next read by leaving its bytes unconsumed. Reset on truncation or parser-version change.

- [ ] **Step 5: Implement progress and coordination**

Update monotonic progress at discovery start, discovery completion, each file completion and terminal state. Return `partial` when eligible work remains after a budget, `complete` when none remains, `error` only when the run cannot continue, and per-Agent counts in fixed Claude/Codex order. Persist terminal/partial progress into `checkpoint.lastRun`.

- [ ] **Step 6: Verify Task 2**

Run:

```bash
npx vitest run --root kits/agent-guard --config vitest.config.ts plugins/agent-guard-background/tests/usage-backfill.test.ts plugins/agent-guard-background/tests/history-storage.test.ts
```

Expected: all focused tests pass; `git diff --check` is clean.

- [ ] **Step 7: Controller commit after independent review**

Commit title: `[Feature] 增量回填 Agent Guard 本地日志`

---

### Task 3: Service Scheduling, Status and Manual Continuation

**Files:**
- Modify: `kits/agent-guard/plugins/agent-guard-background/main/src/service.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/backfill-scheduler.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-background/main/src/index.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-background/package.json`
- Modify: `kits/agent-guard/plugins/agent-guard-background/tests/service.test.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/backfill-scheduler.test.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-background/tests/plugin-main.test.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-center/main/src/index.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-center/package.json`
- Modify: `kits/agent-guard/plugins/agent-guard-center/tests/main.test.ts`

**Interfaces:**
- Consumes: `usageBackfiller.status()` and `usageBackfiller.requestRun()` from Task 2, plus `HistoryStorageStatus` from Task 1.
- Produces RPC: `runHistoryBackfill({ reason: 'manual' })` returning normalized `HistoryStatus`.
- `getHistoryStatus()` returns storage status plus the live `backfill` object.

- [ ] **Step 1: Write failing service lifecycle tests**

In `backfill-scheduler.test.ts`, inject a fake backfiller plus `setTimeout`/`clearTimeout`. Verify start requests a run, a `partial` result schedules a 1-second continuation, `complete` schedules the next 5-minute check, multiple triggers coalesce, and dispose cancels the active timer. In `service.test.ts`, verify `getHistoryStatus` merges live progress with `HistoryStorageStatus` without mutating either object.

- [ ] **Step 2: Run service tests and verify RED**

Run: `npx vitest run --root kits/agent-guard --config vitest.config.ts plugins/agent-guard-background/tests/backfill-scheduler.test.ts plugins/agent-guard-background/tests/service.test.ts`

Expected: failure because status composition, continuation scheduling and manual run are absent.

- [ ] **Step 3: Implement lifecycle scheduling**

Implement `createBackfillScheduler({ backfiller, setScheduledTimeout, clearScheduledTimeout })` as the only timing owner. Use a 1-second delay for `partial`, and 5 minutes after `complete`, `disabled` or recoverable `error`. Do not expose raw errors. `updateHistorySettings({ localSessionBackfill: true })` requests a run after the setting is persisted.

- [ ] **Step 4: Write failing RPC bridge tests**

Extend background and center tests to expect exactly:

```ts
runHistoryBackfill({ reason: 'manual' })
```

Reject unknown fields or any reason other than `manual` at the service boundary.

- [ ] **Step 5: Implement and declare the RPC**

Add the method to both plugin main definitions and both package permission maps. Keep the bridge a direct request with no desktop-only branch.

- [ ] **Step 6: Verify Task 3**

Run:

```bash
npx vitest run --root kits/agent-guard --config vitest.config.ts plugins/agent-guard-background/tests/backfill-scheduler.test.ts plugins/agent-guard-background/tests/service.test.ts plugins/agent-guard-background/tests/plugin-main.test.ts plugins/agent-guard-center/tests/main.test.ts
```

Expected: all focused tests pass and the method lists match implementation.

- [ ] **Step 7: Controller commit after independent review**

Commit title: `[Feature] 调度 Agent Guard 回填任务`

---

### Task 4: Persistent Web Development Cache

**Files:**
- Modify: `.gitignore`
- Modify: `scripts/dev.mjs`
- Modify: `scripts/lib/dev-launcher.mjs`
- Create: `scripts/lib/dev-launcher.test.mjs`
- Modify: `kits/agent-guard/plugins/agent-guard-background/main/src/history-storage.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-background/tests/history-storage.test.ts`

**Interfaces:**
- Produces: Web server environment with absolute `HARBORS_AGENT_GUARD_DATA_DIR=<worktree>/.cache/agent-guard/web` unless explicitly overridden.
- File history selection becomes `dataDir ? file : memory`, independent of desktop/Web host label.

- [ ] **Step 1: Write failing development environment tests**

Test `createDevStackEnvironments` with an explicit fixture root. Assert the default server environment contains the resolved cache path, an explicit environment override wins, and gateway/client environments do not receive the private path.

- [ ] **Step 2: Run launcher tests and verify RED**

Run: `node --test scripts/lib/dev-launcher.test.mjs`

Expected: failure because no root-aware Agent Guard cache path is produced.

- [ ] **Step 3: Implement isolated Web cache wiring**

Add an optional final `rootDir` argument to `createDevStackEnvironments`, pass `process.cwd()` from `scripts/dev.mjs`, set the server-only absolute path, and ignore `/.cache/agent-guard/`. Preserve explicit environment overrides.

- [ ] **Step 4: Write failing Web file-store test**

Create a store with `{ hostMode: 'web', dataDir }`, append one usage event and checkpoint, recreate the store, and assert history plus cursor survives. Keep the existing no-dataDir Web memory test.

- [ ] **Step 5: Implement host-independent explicit persistence**

Change `createHistoryStore` so an explicit data directory selects file storage for Web or desktop; missing data directory selects memory. Reject non-absolute paths before filesystem writes.

- [ ] **Step 6: Verify Task 4**

Run:

```bash
node --test scripts/lib/dev-launcher.test.mjs
npx vitest run --root kits/agent-guard --config vitest.config.ts plugins/agent-guard-background/tests/history-storage.test.ts
```

Expected: both pass; the worktree contains no tracked cache data.

- [ ] **Step 7: Controller commit after independent review**

Commit title: `[Feature] 持久化 Agent Guard Web 回填缓存`

---

### Task 5: Settings Progress Experience

**Files:**
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.css`
- Modify: `kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts`
- Modify: `kits/agent-guard/tests/panel-accessibility.test.ts`

**Interfaces:**
- Consumes: normalized `historyStatus.backfill` and `runHistoryBackfill({ reason: 'manual' })`.
- Produces: `[data-backfill-state]`, per-Agent `[data-backfill-agent]`, progress semantics and `[data-action="run-backfill"]`.

- [ ] **Step 1: Write failing panel behavior tests**

Add literal status fixtures for discovering, scanning, partial, complete, disabled and error. Verify:

- Overview renders only a compact status next to the history heading.
- Settings renders indeterminate discovery or a determinate progress bar only when a denominator exists.
- Claude then Codex rows display file/event/error counts.
- Partial and error copy never claims completion.
- Manual continuation calls the exact RPC, disables while running, preserves Settings/focus across polling, shows a local error on rejection, and clears that error on success.
- Clearing history resets displayed progress and confirmation without moving to Overview.

- [ ] **Step 2: Run panel tests and verify RED**

Run: `npx vitest run --root kits/agent-guard --config vitest.config.ts plugins/agent-guard-center/tests/panel.test.ts`

Expected: failures because progress and manual continuation UI are absent.

- [ ] **Step 3: Implement compact Overview status**

Map states to Chinese labels: disabled `回填已关闭`, idle `等待回填`, discovering/scanning `正在回填`, partial `历史待继续`, complete `历史已更新`, error `回填失败`. Do not add controls to Overview.

- [ ] **Step 4: Implement Settings progress and action**

Use native `<progress>` without `value` during discovery and with `value/max` during scanning. Render safe aggregate/per-Agent counts, last completion and last successful event time. Add `立即继续回填`; call the RPC and reuse the settings-local management error pattern.

- [ ] **Step 5: Add CSS/accessibility contracts**

Keep the fixed document viewport. Progress content belongs inside the internally scrollable Settings panel, respects reduced motion, has an accessible label/status, and does not introduce a page-level scrollbar.

- [ ] **Step 6: Verify Task 5**

Run:

```bash
npx vitest run --root kits/agent-guard --config vitest.config.ts plugins/agent-guard-center/tests/panel.test.ts tests/panel-accessibility.test.ts
```

Expected: focused tests pass with no console warnings.

- [ ] **Step 7: Controller commit after independent review**

Commit title: `[Feature] 展示 Agent Guard 回填进度`

---

### Task 6: Full Verification and Web Acceptance

**Files:**
- Modify only files required by evidence-backed failures found in this task.

**Interfaces:**
- Consumes all prior tasks.
- Produces a clean feature branch and verified Web preview.

- [ ] **Step 1: Run full automated verification**

Run:

```bash
npm run test:agent-guard
npm run kit:check -- agent-guard --output-directory "$(mktemp -d /tmp/agent-guard-incremental-backfill.XXXXXX)"
git diff --check
```

Expected: all tests pass, Kit artifact builds, and diff check is clean.

- [ ] **Step 2: Run Web-only browser acceptance**

Start `npm run dev:web` from this worktree. Verify without Electron:

- First run shows discovering/scanning progress instead of misleading zero-only completion.
- Progress advances monotonically and eventually reaches partial or complete.
- Claude/Codex per-Agent counts appear.
- Restarting Web reads `.cache/agent-guard/web`, skips complete unchanged files and resumes incomplete offsets.
- Overview has only compact status; Settings owns controls and details.
- Normal desktop has no page-level scroll; narrow width scrolls only inside dashboard content.
- Console has no error or warning.

- [ ] **Step 3: Review privacy artifacts**

Inspect checkpoint and packaged artifact by key names only. Assert neither contains raw paths, filenames, prompt/response text, credentials or Authorization values.

- [ ] **Step 4: Controller commit for evidence-backed fixes only**

If this task changes code, use `[Feature] 完善 Agent Guard 增量回填验收`; otherwise make no empty commit.
