# Agent Guard Traffic History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add trustworthy, locally managed Agent Guard history for measured network bytes and locally derived model usage, with explicit provenance and coverage gaps.

**Architecture:** Keep existing short-lived NDJSON metrics compatible, add pure history aggregation and focused persistent history storage behind the background service, and expose strictly normalized query/status/settings/clear contracts to the Center panel. Raw samples remain append-only; immutable generation-qualified hour/day segments and an atomic manifest make compaction idempotent, while coverage heartbeats distinguish valid zeroes from missing observation.

**Tech Stack:** TypeScript ESM, Node.js `fs/promises`, Vitest, JSDOM, Harbors plugin message contracts, HTML/CSS/SVG.

## Global Constraints

- Develop shared behavior with `npm run dev:web` and browser tests; use Electron only for the final desktop persistence/lifecycle check.
- Do not add a native database or any new runtime dependency.
- Do not call Provider usage APIs in the first release.
- Never convert token/request/session counts into network bytes or combine different units in one series.
- Never persist prompts, responses, credentials, full transcript text, raw session IDs, full local paths, complete argv, or complete environment data.
- Raw records retain 7 days, hourly aggregates 90 days, and daily aggregates 365 days.
- A query spans at most 366 days and returns at most 2,000 points; actual bucket size must be returned when promoted.
- Web mode uses bounded in-memory history with `persistent: false` and never writes to cwd or Home.
- Existing incidents, policy, baseline, watchdog ledger, and real-time protection semantics remain unchanged.
- Every implementation commit uses the `[Feature] 中文摘要` title format.

---

### Task 1: Versioned History Contracts

**Files:**
- Modify: `packages/agent-guard-contracts/src/contracts.ts`
- Test: `kits/agent-guard/tests/privacy-contract.test.ts`

**Interfaces:**
- Produces: `TrafficHistoryQuery`, `TrafficHistoryResult`, `HistoryStatus`, `HistorySettings`, `normalizeTrafficHistoryQuery(value)`, `normalizeTrafficHistoryResult(value)`, `normalizeHistorySettings(value)`, and `normalizeClearHistory(value)`.
- Consumes: existing `AgentId`, strict `record/exact/text/integer/enumValue` normalizer helpers.

- [ ] **Step 1: Write failing contract tests**

Add tests that normalize one network result and one model-usage result, then reject an unknown `prompt`, mixed-unit series, reversed ranges, ranges over 366 days, more than 2,000 points, duplicate agents, arbitrary hostnames outside the query string limits, and a clear request without the literal confirmation token.

```ts
expect(normalizeTrafficHistoryQuery({
  from: NOW - 86_400_000,
  to: NOW,
  domain: 'network',
  agents: ['claude'],
  hostnames: ['relay.example.test'],
  preferredBucket: 'minute',
})).toEqual(expect.objectContaining({ domain: 'network' }));
expect(() => normalizeClearHistory({ confirmation: 'yes' })).toThrow(/clear-history/iu);
expect(() => normalizeTrafficHistoryResult({ ...networkHistory(), prompt: 'secret' }))
  .toThrow(/unknown field/iu);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -w @itharbors/kit-agent-guard -- --run tests/privacy-contract.test.ts`

Expected: FAIL because the history exports do not exist.

- [ ] **Step 3: Implement exact public types and normalizers**

Define discriminated series by metric and unit so byte series cannot contain token values:

```ts
type HistoryDomain = 'network' | 'model-usage';
type HistoryBucket = 'minute' | 'hour' | 'day';
type HistoryCoverage = 'complete' | 'partial' | 'missing';
type HistoryCoverageReason =
  | 'collector-stopped' | 'collector-degraded' | 'agent-disabled'
  | 'raw-cap-reached' | 'retention-boundary' | 'unsupported';

interface HistoryPoint {
  start: number;
  end: number;
  value: number | null;
  coverage: HistoryCoverage;
  coverageReason: HistoryCoverageReason | null;
  provenance: 'network-sample' | 'local-session' | null;
  quality: 'measured' | 'derived' | null;
}
```

Use separate series metrics `bytes-in`, `bytes-out`, `input-tokens`, `output-tokens`, `cache-tokens`, `requests`, and `sessions`, with the only allowed units `bytes`, `tokens`, `requests`, and `sessions`. Require `value: null` for missing points and a finite non-negative integer otherwise. Strictly cap arrays and text lengths in the normalizers.

- [ ] **Step 4: Run contract and privacy tests**

Run: `npm test -w @itharbors/kit-agent-guard -- --run tests/privacy-contract.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/agent-guard-contracts/src/contracts.ts kits/agent-guard/tests/privacy-contract.test.ts
git commit -m "[Feature] 定义 Agent Guard 历史查询合约"
```

### Task 2: Pure Coverage and Aggregation Engine

**Files:**
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/history-aggregation.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/history-aggregation.test.ts`

**Interfaces:**
- Consumes: history contract types from Task 1.
- Produces: `bucketSizeMs(bucket)`, `chooseBucket(query)`, `aggregateNetworkHistory(samples, coverage, query)`, `aggregateUsageHistory(events, query)`, and serializable `HistoryAggregateRecordV1`.

- [ ] **Step 1: Write failing deterministic aggregation tests**

Cover exact UTC boundaries, adjacent collector epochs, overlapping samples, a complete heartbeat with no metric (valid zero), missing heartbeat (`value: null`), partial heartbeat, agent-disabled reason, event-digest deduplication, and automatic bucket promotion under the 2,000 point limit.

```ts
expect(aggregateNetworkHistory([], [completeCoverage(MINUTE)], networkQuery(MINUTE)))
  .toContainEqual(expect.objectContaining({ metric: 'bytes-out', points: [
    expect.objectContaining({ value: 0, coverage: 'complete' }),
  ] }));
expect(aggregateNetworkHistory([], [], networkQuery(MINUTE)))
  .toContainEqual(expect.objectContaining({ points: [
    expect.objectContaining({ value: null, coverage: 'missing' }),
  ] }));
```

- [ ] **Step 2: Verify the new tests fail**

Run: `npm test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/history-aggregation.test.ts`

Expected: FAIL because `history-aggregation.ts` does not exist.

- [ ] **Step 3: Implement the pure engine**

Normalize all bucket boundaries with integer UTC epoch arithmetic. Clip samples and coverage intervals to the query range, merge interval unions before calculating coverage milliseconds, reject negative/overlapping byte deltas from different epochs, and deduplicate usage events by `eventDigest`. Keep network and usage entry points separate so units cannot cross.

- [ ] **Step 4: Add DST and clock-jump regression cases**

Use absolute instants around `America/Los_Angeles` spring-forward/fall-back labels and prove the engine still creates UTC buckets with no duplicate start time. Add a backwards timestamp that starts a new epoch and creates partial coverage rather than a negative interval.

- [ ] **Step 5: Run the focused tests**

Run: `npm test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/history-aggregation.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the engine**

```bash
git add kits/agent-guard/plugins/agent-guard-background/main/src/history-aggregation.ts kits/agent-guard/plugins/agent-guard-background/tests/history-aggregation.test.ts
git commit -m "[Feature] 增加历史覆盖与聚合引擎"
```

### Task 3: Persistent History Store and Idempotent Compaction

**Files:**
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/history-storage.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/history-storage.test.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-background/main/src/storage.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-background/tests/storage.test.ts`

**Interfaces:**
- Consumes: raw/aggregate record types and pure aggregation functions from Task 2.
- Produces: `HistoryStore` with `appendNetworkSamples`, `appendCoverage`, `appendUsageEvents`, `query`, `status`, `compact`, `loadBackfillCursors`, `saveBackfillCursors`, `updateSettings`, and `clearHistory`.
- Extends: `AgentGuardStore.history: HistoryStore` for both desktop and web modes.

- [ ] **Step 1: Write failing desktop store tests**

Create a temporary desktop data directory, append raw network/coverage/usage records, query them, compact them, recreate the store, and assert identical totals and coverage. Verify modes `0700/0600`, generation-qualified filenames, manifest generation, and no cwd writes.

- [ ] **Step 2: Add crash-injection and retention tests**

Inject failures after segment write, after segment rename, and after manifest switch. Reopen the store after each failure and assert exactly one generation contributes to the query. Advance time beyond 7/90/365-day boundaries and verify only expired raw/hour/day layers are removed. Append a torn final NDJSON line and an invalid middle line and assert valid records remain queryable with warnings.

- [ ] **Step 3: Verify focused tests fail**

Run: `npm test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/history-storage.test.ts plugins/agent-guard-background/tests/storage.test.ts`

Expected: FAIL because history storage is absent.

- [ ] **Step 4: Implement immutable segments and atomic manifest publication**

Use fixed safe filenames parsed inside the store, exclusive temporary files at mode `0600`, `FileHandle.sync()`, atomic rename, and an atomic JSON manifest. Compaction snapshots input high-watermarks, writes deterministic sorted output, validates it by reading it back, switches the manifest, and only then removes unreferenced/expired files. A single-flight promise prevents overlapping compactions.

- [ ] **Step 5: Implement bounded web memory history**

For `hostMode: 'web'`, return a memory-backed `HistoryStore` with `persistent: false`, capped to seven days and 10,000 raw records. Preserve the existing degraded behavior for policy/state/incident persistence; only history becomes ephemeral.

- [ ] **Step 6: Implement scoped clear and status**

`clearHistory()` atomically publishes an empty generation and removes only fixed history filename categories plus backfill cursors. Assert `state.json`, `incidents-*`, and `control-ledger.json` survive. `status()` returns storage bytes, bounds, generation, last compaction/backfill, settings, warnings, and `persistent`.

- [ ] **Step 7: Run focused and performance tests**

Run: `npm test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/history-storage.test.ts plugins/agent-guard-background/tests/storage.test.ts tests/performance.test.ts`

Expected: PASS, including one-year day-segment query under 200 ms and result serialization under 2 MiB.

- [ ] **Step 8: Commit storage**

```bash
git add kits/agent-guard/plugins/agent-guard-background/main/src/history-storage.ts kits/agent-guard/plugins/agent-guard-background/main/src/storage.ts kits/agent-guard/plugins/agent-guard-background/tests/history-storage.test.ts kits/agent-guard/plugins/agent-guard-background/tests/storage.test.ts kits/agent-guard/tests/performance.test.ts
git commit -m "[Feature] 持久化并压缩 Agent Guard 历史数据"
```

### Task 4: Privacy-Preserving Claude and Codex Usage Backfill

**Files:**
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/usage-backfill.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/usage-backfill.test.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/fixtures/claude-usage.jsonl`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/fixtures/codex-usage.jsonl`

**Interfaces:**
- Consumes: `HistoryStore.appendUsageEvents`, cursor load/save, Agent session roots, and a local salt.
- Produces: `createUsageBackfiller(options)` with `runOnce(): Promise<BackfillReport>` and `dispose()`; emits allowlisted `UsageEventV1` only.

- [ ] **Step 1: Write failing parser and privacy tests**

Fixtures include input/output/cache usage plus deliberately sensitive prompt, response, tool input, API key, and local path fields. Assert exact supported counts, stable salted `eventDigest`, unsupported-field diagnostics, incremental cursor behavior, and absence of sensitive strings in serialized events/store files.

- [ ] **Step 2: Verify the focused test fails**

Run: `npm test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/usage-backfill.test.ts`

Expected: FAIL because the backfiller is absent.

- [ ] **Step 3: Implement streaming allowlist parsers**

Read JSONL incrementally from the saved byte offset with a per-file byte cap and per-run time budget. Recognize only documented usage locations for each Agent. Build event digests from `agent + session digest + event identifier + timestamp + metric counters + parserVersion`; never include raw content in errors or logs. Treat missing counters as unsupported rather than zero.

- [ ] **Step 4: Implement safe discovery and cursor recovery**

Traverse only the configured Claude/Codex session roots with bounded file counts, reject symlink escapes after `realpath`, and store hashed relative identity rather than paths. On truncation/replacement, rescan the file and rely on event digests for deduplication. Do not scan when backfill is disabled.

- [ ] **Step 5: Run usage and privacy tests**

Run: `npm test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/usage-backfill.test.ts tests/privacy-contract.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit backfill**

```bash
git add kits/agent-guard/plugins/agent-guard-background/main/src/usage-backfill.ts kits/agent-guard/plugins/agent-guard-background/tests/usage-backfill.test.ts kits/agent-guard/plugins/agent-guard-background/tests/fixtures
git commit -m "[Feature] 回填本地 Agent 模型用量"
```

### Task 5: Background Service and Plugin Bridges

**Files:**
- Modify: `kits/agent-guard/plugins/agent-guard-background/main/src/service.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-background/main/src/index.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-background/package.json`
- Modify: `kits/agent-guard/plugins/agent-guard-background/tests/service.test.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-background/tests/plugin-main.test.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-center/main/src/index.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-center/package.json`
- Modify: `kits/agent-guard/plugins/agent-guard-center/tests/main.test.ts`

**Interfaces:**
- Consumes: public normalizers from Task 1, `HistoryStore` from Task 3, and `UsageBackfiller` from Task 4.
- Produces: background/center methods `getTrafficHistory`, `getHistoryStatus`, `updateHistorySettings`, and `clearHistory`.

- [ ] **Step 1: Write failing service and bridge tests**

Assert strict input normalization, query forwarding, status/settings behavior, literal clear confirmation, and all four manifest request declarations. Assert history calls do not alter collector start/stop or incident command behavior.

- [ ] **Step 2: Add persisted sample and coverage integration tests**

Drive one evaluation window with a complete collector and one with an incomplete/degraded collector. Assert v2 network records include interval, epoch and coverage; coverage heartbeats are written even when no endpoint bytes exist. Stop/start a service around a gap and assert the query returns `missing`, not zero.

- [ ] **Step 3: Verify focused tests fail**

Run: `npm test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/service.test.ts plugins/agent-guard-background/tests/plugin-main.test.ts plugins/agent-guard-center/tests/main.test.ts`

Expected: FAIL because the methods are absent.

- [ ] **Step 4: Integrate history lifecycle without delaying real-time protection**

Construct the history store with the existing data directory, append one coverage interval per evaluation window, append v2 network samples, schedule bounded backfill/compaction outside the collector critical path, and await only safe flushes during disposal. A history failure records a warning/degraded status but does not fail `start()`, `getSnapshot()`, policy evaluation, notifications, or incident control.

- [ ] **Step 5: Add all background and center methods/manifests**

Normalize every request at the background trust boundary; Center remains a transparent application bridge. Keep plugin method names identical across TypeScript and both `package.json` request manifests.

- [ ] **Step 6: Run service, bridge, runtime and incident regression tests**

Run: `npm test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/service.test.ts plugins/agent-guard-background/tests/plugin-main.test.ts plugins/agent-guard-center/tests/main.test.ts tests/runtime-integration.test.ts tests/incident-replay.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit integration**

```bash
git add kits/agent-guard/plugins/agent-guard-background kits/agent-guard/plugins/agent-guard-center/main kits/agent-guard/plugins/agent-guard-center/package.json
git commit -m "[Feature] 接入 Agent Guard 历史查询服务"
```

### Task 6: History Dashboard and Storage Management

**Files:**
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.css`
- Modify: `kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts`
- Modify: `kits/agent-guard/tests/panel-accessibility.test.ts`

**Interfaces:**
- Consumes: the four Center history methods and normalized `TrafficHistoryResult`/`HistoryStatus`.
- Produces: history range/domain/Agent controls, SVG trend chart, coverage/source legend, endpoint details, status panel, backfill toggle, and confirmed clear-history action.

- [ ] **Step 1: Write failing panel interaction tests**

Mount with deterministic snapshot/history/status fixtures. Assert default 24-hour network request, range switching, domain switching, Agent filtering, no history request on the 2-second snapshot poll, stale history response suppression, and reload only when controls or generation change.

- [ ] **Step 2: Write failing semantic and management tests**

Assert complete zero renders `0 B`, missing points render a gap and “未采集”, derived usage renders “本地日志回填”, different units never share one chart, storage usage is visible, backfill toggle calls settings, and clear requires an in-panel confirmation before sending `{ confirmation: 'clear-history' }`.

- [ ] **Step 3: Verify focused tests fail**

Run: `npm test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-center/tests/panel.test.ts tests/panel-accessibility.test.ts`

Expected: FAIL because the history UI is absent.

- [ ] **Step 4: Implement isolated history state and requests**

Keep the existing snapshot polling path unchanged. Add a separate history request generation, abort-by-version semantics, range/domain/filter state, status loading, and mutation serialization. Only request history on mount, user changes, explicit refresh, or a newer generation reported by status.

- [ ] **Step 5: Implement accessible trend visualization**

Render a responsive inline SVG with one path per compatible metric, split paths at null/missing points, and add non-color dash patterns. Provide a parallel textual summary/table for screen readers, buttons with pressed state, labelled controls, keyboard focus, and `aria-live` status for loading/errors. Never interpolate across a missing interval.

- [ ] **Step 6: Implement storage management and responsive CSS**

Add storage bytes, oldest/latest timestamp, persistence state, last compaction/backfill, toggle, and two-stage clear controls. Fit the existing warm dark visual language at the current 720×520 minimum without hiding coverage warnings.

- [ ] **Step 7: Run panel and accessibility tests**

Run: `npm test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-center/tests/panel.test.ts tests/panel-accessibility.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the dashboard**

```bash
git add kits/agent-guard/plugins/agent-guard-center/panel.guard kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts kits/agent-guard/tests/panel-accessibility.test.ts
git commit -m "[Feature] 展示并管理 Agent Guard 历史用量"
```

### Task 7: Documentation, Full Verification, and Web Acceptance

**Files:**
- Modify: `kits/agent-guard/README.md`
- Modify: `kits/agent-guard/tests/performance.test.ts`
- Modify: `kits/agent-guard/tests/privacy-contract.test.ts`

**Interfaces:**
- Consumes: all completed history behavior.
- Produces: user-facing history/privacy/retention documentation and final performance/privacy gates.

- [ ] **Step 1: Document exact history semantics**

Describe the two metric domains, local-session-derived labeling, gap versus zero, 7/90/365 retention, local-only storage, panel/background lifecycle, clear scope, Web ephemeral mode, and the fact that stopped-background network bytes cannot be recovered.

- [ ] **Step 2: Complete performance and privacy gates**

Generate synthetic raw/hour/day records and assert seven-day and one-year query budgets, 2,000-point/2-MiB limits, bounded RSS, and no sensitive serialized keys or fixture content across every new file category.

- [ ] **Step 3: Run build and the complete Kit test suite**

Run: `npm run build -w @itharbors/kit-agent-guard`

Expected: exit 0.

Run: `npm test -w @itharbors/kit-agent-guard`

Expected: all test files pass.

Run: `npm run kit:check -- agent-guard`

Expected: official Kit validation passes.

- [ ] **Step 4: Start Web preview and perform browser acceptance**

Run from repository root: `npm run dev:web`

Open the emitted localhost URL with the feature worktree Kit path. Verify live routes still update, history defaults to 24 hours, range/domain/Agent controls work, complete zero and missing gaps are visually distinct, local-derived usage has a source label, storage reports `persistent: false`, clear only affects history, and no console error appears. Stop the preview after acceptance.

- [ ] **Step 5: Inspect final diff and commit**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors and only intended Agent Guard/contract/docs files.

```bash
git add kits/agent-guard/README.md kits/agent-guard/tests/performance.test.ts kits/agent-guard/tests/privacy-contract.test.ts
git commit -m "[Feature] 完善 Agent Guard 历史能力说明与验收"
```

- [ ] **Step 6: Defer the justified Desktop check until a real ITHARBORS host is selected**

Do not launch a generic Electron application. Use an already-running ITHARBORS process, or explicitly start the repository's ITHARBORS desktop host only when desktop persistence/lifecycle acceptance begins. Verify restart persistence, private file modes, compaction recovery and panel-close/background-continue behavior, then record the exact host and evidence in the final handoff.
