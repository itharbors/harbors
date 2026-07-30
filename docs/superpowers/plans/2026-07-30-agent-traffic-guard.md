# Agent Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-configuration macOS arm64 Harbors Kit that monitors Claude Code and Codex connection bytes, attributes model endpoints without decrypting TLS, detects abnormal process/session growth, and safely controls only confirmed runaway task processes.

**Architecture:** An application-scope background plugin owns adapters, one long-lived `nettop` collector, process/session observation, attribution, policy, persistence, notification, and process control. A lazy session-scope center plugin calls it through a new server-only application-message bridge. Daily NDJSON and atomic JSON retain only allowlisted metadata.

**Tech Stack:** TypeScript 5.7, Node.js 22, Electron 43, Harbors ApplicationRuntime/Kit APIs, Vitest 2, macOS `nettop`/`ps`/POSIX signals, HTML/CSS/DOM.

## Global Constraints

- Target exactly `darwin/arm64`; Linux, Windows, and Intel Mac are unsupported in v1.
- Add no proxy, certificate, TLS decryption, or Agent/system-network configuration change.
- Never read or retain prompts, responses, secrets, complete argv, or complete environments.
- Expose connection count and bytes only; never claim exact requests, Tokens, costs, or Relay Traces.
- Only complete `confirmed` attribution can participate in automatic process control.
- Revalidate PID, start time, executable identity, process group, and tree immediately before every signal.
- Dynamic anomalies warn only. Fixed multi-signal rules may pause safe tasks. Only confirmed recursive subtrees may be auto-terminated.
- Keep the UI lazy and the application background independent of any Agent Guard window.
- Retain metrics 7 days, incidents/control 30 days, and cap ordinary metrics at 20 MiB/day.
- Meet idle CPU ≤0.5%, sustained stress CPU ≤2%, and background/watchdog RSS ≤50 MiB on the real target Mac.
- Use the existing `feature/agent-traffic-guard` worktree and `[Feature] 摘要` commits.

## File Map

- `packages/kit-core/*`, `scripts/lib/kit-registry/*`, `scripts/lib/kit-manager-view*`: govern new `process-control` permission.
- `packages/server/src/editor/*`, `packages/server/src/framework/plugin/index.ts`, `packages/server/src/app.ts`: server-only session-to-application request bridge.
- `scripts/lib/desktop-paths*`, `scripts/lib/desktop-framework*`, `scripts/electron.mjs`: safe Agent Guard data directory.
- `packages/agent-guard-contracts/*`: public snapshots, policy, incidents, commands, and normalizers.
- `kits/agent-guard/*`: Kit manifest, layout, policy resource, tests, background plugin, and lazy center plugin.
- `scripts/agent-guard-smoke.mjs`: fixture-only real macOS smoke/performance harness.
- `docs/superpowers/reports/2026-07-30-agent-traffic-guard-performance.md`: measured acceptance evidence.

---

### Task 1: Govern the process-control Kit permission

**Files:**
- Modify: `packages/kit-core/src/model.ts`
- Modify: `packages/kit-core/tests/schema.test.ts`
- Modify: `scripts/lib/kit-registry/resolver.mjs`
- Modify: `scripts/lib/kit-registry/resolver.test.mjs`
- Modify: `scripts/lib/kit-manager-view.mjs`
- Modify: `scripts/lib/kit-manager-view.test.mjs`

**Interfaces:**
- Consumes: `KIT_PERMISSIONS`, Registry release validation, Kit Manager permission rendering.
- Produces: permission `'process-control'`, official-publisher restriction, label `Process control — elevated risk`.

- [ ] **Step 1: Add failing permission tests**

```ts
expect(parseKitPackageManifest({
  ...validManifest,
  permissions: ['filesystem', 'process-control'],
}).permissions).toContain('process-control');
```

```js
await assert.rejects(
  resolver.resolve(nonOfficialProcessControlKit),
  (error) => error.code === 'PERMISSION_NOT_ALLOWED' && /process-control/u.test(error.message),
);
assert.match(renderedHtml, /Process control — elevated risk/u);
```

- [ ] **Step 2: Prove the tests fail**

Run: `npm run test -w @itharbors/kit-core -- --run packages/kit-core/tests/schema.test.ts && node --test scripts/lib/kit-registry/resolver.test.mjs scripts/lib/kit-manager-view.test.mjs`

Expected: FAIL because the permission, policy, and copy do not exist.

- [ ] **Step 3: Implement the permission and official restriction**

```ts
export const KIT_PERMISSIONS = [
  'network', 'filesystem', 'native-code', 'application-startup', 'process-control',
] as const;
```

```js
const OFFICIAL_ONLY_PERMISSIONS = new Set(['application-startup', 'process-control']);
const forbidden = releasedPermissions.find((permission) => (
  OFFICIAL_ONLY_PERMISSIONS.has(permission) && release.publisher !== 'itharbors'
));
if (forbidden) {
  throw new KitRegistryResolutionError(
    'PERMISSION_NOT_ALLOWED',
    `Only the official itharbors publisher may request ${forbidden}`,
  );
}
```

Render `process-control` with the existing elevated-risk class.

- [ ] **Step 4: Run focused tests**

Run: `npm run test -w @itharbors/kit-core -- --run packages/kit-core/tests/schema.test.ts && node --test scripts/lib/kit-registry/resolver.test.mjs scripts/lib/kit-manager-view.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kit-core/src/model.ts packages/kit-core/tests/schema.test.ts scripts/lib/kit-registry/resolver.mjs scripts/lib/kit-registry/resolver.test.mjs scripts/lib/kit-manager-view.mjs scripts/lib/kit-manager-view.test.mjs
git commit -m '[Feature] 增加进程控制权限治理'
```

### Task 2: Add the server-only application bridge and data directory

**Files:**
- Modify: `packages/server/src/editor/types.ts`
- Modify: `packages/server/src/editor/index.ts`
- Modify: `packages/server/src/framework/plugin/index.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/tests/framework/plugin-runtime.test.ts`
- Modify: `packages/server/tests/application/runtime.test.ts`
- Modify: `scripts/lib/desktop-paths.mjs`
- Modify: `scripts/lib/desktop-paths.test.mjs`
- Modify: `scripts/electron.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`
- Modify: `scripts/lib/desktop-framework.mjs`
- Modify: `scripts/lib/desktop-framework.test.mjs`

**Interfaces:**
- Consumes: `ApplicationRuntime.request(plugin, method, ...args)`.
- Produces: `PluginRuntime.application.request(...)` for server plugin main entries only; absolute `HARBORS_AGENT_GUARD_DATA_DIR`.

- [ ] **Step 1: Add failing runtime/path tests**

```ts
expect(await sessionRuntime.application.request('background', 'snapshot')).toEqual({ status: 'ready' });
expect('application' in panelRuntime).toBe(false);
```

```js
assert.equal(
  paths.agentGuardDataDir,
  '/Users/me/Library/Application Support/ITHARBORS/agent-guard',
);
```

- [ ] **Step 2: Prove the tests fail**

Run: `npm run test -w packages/server -- --run packages/server/tests/framework/plugin-runtime.test.ts packages/server/tests/application/runtime.test.ts && node --test scripts/lib/desktop-paths.test.mjs scripts/lib/desktop-framework.test.mjs scripts/lib/electron-launcher.test.mjs`

Expected: FAIL on missing bridge and path.

- [ ] **Step 3: Implement the bridge and path forwarding**

```ts
application: {
  request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
};
```

Add `applicationRequest` to `CreateEditorOptions`, project it through `createPluginRuntime`, and do not add it to `PanelRuntime`. In `createApp` inject:

```ts
applicationRequest: (plugin, name, ...args) => (
  appOptions.applicationRuntime.request(plugin, name, ...args)
),
```

Derive `path.join(dataRoot, 'agent-guard')`, validate it as absolute in packaged Framework parsing, and pass it to packaged and development Framework children.

- [ ] **Step 4: Run focused tests**

Run: `npm run test -w packages/server -- --run packages/server/tests/framework/plugin-runtime.test.ts packages/server/tests/application/runtime.test.ts && node --test scripts/lib/desktop-paths.test.mjs scripts/lib/desktop-framework.test.mjs scripts/lib/electron-launcher.test.mjs`

Expected: PASS and browser panel runtime has no direct application control.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/editor/types.ts packages/server/src/editor/index.ts packages/server/src/framework/plugin/index.ts packages/server/src/app.ts packages/server/src/server.ts packages/server/tests/framework/plugin-runtime.test.ts packages/server/tests/application/runtime.test.ts scripts/lib/desktop-paths.mjs scripts/lib/desktop-paths.test.mjs scripts/electron.mjs scripts/lib/electron-launcher.test.mjs scripts/lib/desktop-framework.mjs scripts/lib/desktop-framework.test.mjs
git commit -m '[Feature] 打通应用后台服务访问能力'
```

### Task 3: Scaffold contracts, Kit shell, and policy v1

**Files:**
- Create: `packages/agent-guard-contracts/package.json`
- Create: `packages/agent-guard-contracts/tsconfig.json`
- Create: `packages/agent-guard-contracts/src/contracts.ts`
- Create: `packages/agent-guard-contracts/src/index.ts`
- Create: `kits/agent-guard/kit.json`
- Create: `kits/agent-guard/package.json`
- Create: `kits/agent-guard/vitest.config.ts`
- Create: `kits/agent-guard/layout.json`
- Create: `kits/agent-guard/main.html`
- Create: `kits/agent-guard/secondary.html`
- Create: `kits/agent-guard/resources/policy-v1.json`
- Create: `kits/agent-guard/tests/kit-manifest.test.ts`
- Create: `kits/agent-guard/tests/privacy-contract.test.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `AgentGuardSnapshot`, `AgentEndpointSnapshot`, `IncidentSummary`, `PolicyV1`, `AgentGuardCommand`, and strict normalizers.

- [ ] **Step 1: Add failing manifest/privacy tests**

```ts
expect(manifest).toMatchObject({
  id: '@itharbors/kit-agent-guard',
  target: { platform: 'darwin', arch: 'arm64' },
  permissions: ['network', 'filesystem', 'process-control', 'application-startup'],
});
expect(kit['ce-editor'].kit.startup.plugins).toEqual(['@itharbors/agent-guard-background']);
expect(kit['ce-editor'].kit.plugin).toEqual(['@itharbors/agent-guard-center']);
expect(() => normalizeSnapshot({ prompt: 'secret' })).toThrow(/unknown field/iu);
```

- [ ] **Step 2: Prove the new workspace is missing**

Run: `npm run test -w @itharbors/kit-agent-guard`

Expected: FAIL because the workspace does not exist.

- [ ] **Step 3: Implement contracts and exact policy values**

```ts
export type AttributionConfidence = 'confirmed' | 'probable' | 'unknown';
export type GuardState = 'learning' | 'normal' | 'warning' | 'tripped' | 'cooldown' | 'degraded';
export type AgentGuardCommand =
  | { type: 'resume'; incidentId: string }
  | { type: 'terminate'; incidentId: string }
  | { type: 'ignore'; incidentId: string; durationMinutes: 15 | 30 | 60 };
```

The JSON policy contains 60-second evaluation, three consecutive windows, 10-minute traffic windows, 5x/6-MAD/8-MiB dynamic warning, 128/256-MiB fixed thresholds, and the exact process/session corroborators from the design.

- [ ] **Step 4: Install workspace links, build, and test**

Run: `npm install && npm run build -w @itharbors/agent-guard-contracts && npm run test -w @itharbors/kit-agent-guard`

Expected: PASS with no proxy or native database dependency.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-guard-contracts kits/agent-guard package-lock.json
git commit -m '[Feature] 建立智能体守卫基础契约'
```

### Task 4: Implement privacy-bounded Claude and Codex adapters

**Files:**
- Create: `kits/agent-guard/plugins/agent-guard-background/package.json`
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/types.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/adapters/config-reader.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/adapters/claude.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/adapters/codex.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/config-reader.test.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/adapters.test.ts`

**Interfaces:**
- Produces in `main/src/types.ts`: `AgentAdapter`, `AgentConfiguration`, `ProcessSnapshot`, `ProcessTreeSnapshot`, `SessionActivity`, `AgentProcessRole`, `IncidentEvidence`, and `ControlTargetCandidate`.

- [ ] **Step 1: Add failing allowlist/classification tests**

```ts
expect(readClaudeConfiguration(fixture)).toEqual({
  agent: 'claude',
  provider: 'custom',
  endpoint: 'https://super-relay.byted.org',
  hookExecutables: [{ event: 'SessionEnd', executable: 'claude' }],
});
expect(JSON.stringify(readClaudeConfiguration(fixture))).not.toContain('secret-key');
expect(codexAdapter.classifyProcess(codexRenderer)).toBe('host');
expect(codexAdapter.selectSafeControlTarget(sharedHostTree, incident)).toBeNull();
```

- [ ] **Step 2: Prove the adapter tests fail**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/config-reader.test.ts plugins/agent-guard-background/tests/adapters.test.ts`

Expected: FAIL on missing modules.

- [ ] **Step 3: Implement exact-field configuration and process roles**

```ts
export interface AgentAdapter {
  id: 'claude' | 'codex';
  discoverConfiguration(): Promise<AgentConfiguration>;
  classifyProcess(process: ProcessSnapshot): AgentProcessRole | null;
  discoverSessionActivity(sinceMs: number): Promise<SessionActivity[]>;
  selectSafeControlTarget(tree: ProcessTreeSnapshot, incident: IncidentEvidence): ControlTargetCandidate | null;
}
```

Claude may read only `model`, `env.ANTHROPIC_BASE_URL`, Hook event names, and Hook executable names. Codex may read only top-level `model`, `model_provider`, and matching `[model_providers.<name>] base_url`. Implement a line parser for those exact TOML keys and reject conflicts. Session discovery stats and hashes identifiers without reading transcripts.

- [ ] **Step 4: Run adapter and privacy tests**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/config-reader.test.ts plugins/agent-guard-background/tests/adapters.test.ts tests/privacy-contract.test.ts`

Expected: PASS for missing/malformed files, official/custom endpoints, Claude Hook metadata, Codex Desktop helpers, CLI tasks, and forbidden secrets.

- [ ] **Step 5: Commit**

```bash
git add kits/agent-guard/plugins/agent-guard-background
git commit -m '[Feature] 识别本机智能体与模型端点'
```

### Task 5: Build low-overhead process and nettop observation

**Files:**
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/process-observer.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/nettop-parser.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/nettop-collector.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/process-observer.test.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/nettop-parser.test.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/nettop-collector.test.ts`

**Interfaces:**
- Consumes: `ProcessSnapshot`, `ProcessTreeSnapshot`, and adapter role classification from Task 4.
- Produces: populated `ProcessTreeSnapshot`, `ProcessTreeMetrics`, `ConnectionCounter`, collector epochs, and incomplete-window markers.

- [ ] **Step 1: Add failing tree/counter tests**

```ts
expect(buildProcessTree(snapshots, { maxNodes: 256 })).toMatchObject({
  metrics: { sameExecutableDepth: 4, newTaskProcesses: 8 },
});
expect(parseNettopRow(csvRow)).toEqual({
  pid: 41,
  remoteAddress: '203.0.113.10:443',
  bytesIn: 2048n,
  bytesOut: 4096n,
});
expect(deltaAcrossEpoch.complete).toBe(false);
```

- [ ] **Step 2: Prove tests fail**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/process-observer.test.ts plugins/agent-guard-background/tests/nettop-parser.test.ts plugins/agent-guard-background/tests/nettop-collector.test.ts`

Expected: FAIL on missing modules.

- [ ] **Step 3: Implement one persistent collector and minimal process snapshots**

```ts
const NETTOP_ARGS = Object.freeze([
  '-L', '0', '-x', '-c', '-s', '2', '-J', 'state,bytes_in,bytes_out',
]);
```

Append repeated exact `-p <process-name>` filters. Keep one child alive, bound line length, restart after 1s/2s/4s/8s/30s, and increment epoch every restart. Read one `ps` snapshot every 2 seconds and immediately discard all command text except allowlisted executable markers. Bound trees to 256 nodes per Agent.

- [ ] **Step 4: Run tests and build**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/process-observer.test.ts plugins/agent-guard-background/tests/nettop-parser.test.ts plugins/agent-guard-background/tests/nettop-collector.test.ts && npm run build -w @itharbors/kit-agent-guard`

Expected: PASS for malformed/oversized CSV, rollback, restart, stop idempotency, PID reuse, and bounded trees.

- [ ] **Step 5: Commit**

```bash
git add kits/agent-guard/plugins/agent-guard-background/main/src/process-observer.ts kits/agent-guard/plugins/agent-guard-background/main/src/nettop-parser.ts kits/agent-guard/plugins/agent-guard-background/main/src/nettop-collector.ts kits/agent-guard/plugins/agent-guard-background/tests/process-observer.test.ts kits/agent-guard/plugins/agent-guard-background/tests/nettop-parser.test.ts kits/agent-guard/plugins/agent-guard-background/tests/nettop-collector.test.ts
git commit -m '[Feature] 采集智能体连接与进程数据'
```

### Task 6: Attribute endpoints and aggregate complete windows

**Files:**
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/attribution.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/aggregator.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/attribution.test.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/aggregator.test.ts`

**Interfaces:**
- Consumes: Agent configurations, counters, process roles, DNS resolver, clock, install salt.
- Produces: `AttributedConnection`, `MetricWindow`, confidence/evidence codes, salted remote digest.

- [ ] **Step 1: Add failing attribution/delta tests**

```ts
expect(attribute(connection, configuredEndpoint, dnsHistory)).toMatchObject({
  displayHostname: 'super-relay.byted.org',
  confidence: 'confirmed',
  evidence: ['CONFIG_ENDPOINT', 'PROCESS_TASK', 'DNS_ADDRESS_MATCH'],
});
expect(attribute(sharedIpConnection, endpoint, sharedHistory).confidence).toBe('probable');
expect(aggregate([first, second])).toMatchObject({ complete: true, bytesOut: 60n, bytesIn: 40n });
```

- [ ] **Step 2: Prove tests fail**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/attribution.test.ts plugins/agent-guard-background/tests/aggregator.test.ts`

Expected: FAIL on missing modules.

- [ ] **Step 3: Implement TTL DNS history, shared-IP downgrade, and safe deltas**

```ts
export type AttributionEvidence =
  | 'CONFIG_ENDPOINT'
  | 'PROCESS_TASK'
  | 'DNS_ADDRESS_MATCH'
  | 'REVERSE_DNS_HINT'
  | 'SHARED_ADDRESS'
  | 'DATA_INCOMPLETE';
```

Exact remote addresses remain in live memory. Persist only `createHmac('sha256', salt).update(address).digest('hex').slice(0, 16)`. Mark windows incomplete on epoch change, missing start time, rollback, or Collector gap; incomplete measurements remain visible but cannot control processes.

- [ ] **Step 4: Run tests**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/attribution.test.ts plugins/agent-guard-background/tests/aggregator.test.ts tests/privacy-contract.test.ts`

Expected: PASS for TTL expiry, DNS failure, IPv4/IPv6, shared CDN IPs, reverse hints, salt stability, and incomplete data.

- [ ] **Step 5: Commit**

```bash
git add kits/agent-guard/plugins/agent-guard-background/main/src/attribution.ts kits/agent-guard/plugins/agent-guard-background/main/src/aggregator.ts kits/agent-guard/plugins/agent-guard-background/tests/attribution.test.ts kits/agent-guard/plugins/agent-guard-background/tests/aggregator.test.ts
git commit -m '[Feature] 归因智能体模型连接'
```

### Task 7: Implement baseline, rules, and incident state machine

**Files:**
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/baseline.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/policy.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/baseline.test.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/policy.test.ts`
- Create: `kits/agent-guard/tests/incident-replay.test.ts`

**Interfaces:**
- Consumes: complete `MetricWindow`, `ProcessTreeMetrics`, `SessionActivity`, `PolicyV1`.
- Produces: rolling median/MAD, `IncidentEvidence`, and learning/normal/warning/tripped/cooldown/degraded transitions.

- [ ] **Step 1: Add failing policy tests**

```ts
expect(evaluate(dynamicSpikeDuringLearning)).toMatchObject({ level: 'warning', control: null });
expect(evaluate(singleLargeByteSpike)).toMatchObject({ level: 'warning', control: null });
expect(evaluate(fixedMultiSignalForThreeWindows)).toMatchObject({
  state: 'tripped', control: { action: 'pause' },
});
expect(evaluate(recursiveTreeDuringLearning)).toMatchObject({
  state: 'tripped', control: { action: 'terminate-recursive-subtree' },
});
```

- [ ] **Step 2: Prove tests fail**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/baseline.test.ts plugins/agent-guard-background/tests/policy.test.ts tests/incident-replay.test.ts`

Expected: FAIL on missing algorithms and replay fixture.

- [ ] **Step 3: Implement bounded median/MAD and policy v1**

```ts
const dynamic = bytesOutPerMinute >= Math.max(
  baseline.median * policy.dynamic.multiplier,
  baseline.median + baseline.mad * policy.dynamic.madMultiplier,
  policy.dynamic.minimumBytesOutPerMinute,
);
const corroborated = sessionsPerMinute >= policy.dynamic.sessionsPerMinute
  || taskProcessesPerMinute >= policy.dynamic.taskProcessesPerMinute
  || newConnectionsPerMinute >= policy.dynamic.connectionsPerMinute;
```

Load every number from policy JSON, keep at most 7 days of minute buckets, create evidence with measured value/threshold/window/confidence/completeness/rule version, and derive idempotent incident IDs from Agent/endpoint/rule/first-window time.

- [ ] **Step 4: Run tests and replay**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/baseline.test.ts plugins/agent-guard-background/tests/policy.test.ts tests/incident-replay.test.ts`

Expected: PASS; normal multi-agent concurrency stays normal, recorded recursion trips during learning, and dynamic-only spikes never control.

- [ ] **Step 5: Commit**

```bash
git add kits/agent-guard/plugins/agent-guard-background/main/src/baseline.ts kits/agent-guard/plugins/agent-guard-background/main/src/policy.ts kits/agent-guard/plugins/agent-guard-background/tests/baseline.test.ts kits/agent-guard/plugins/agent-guard-background/tests/policy.test.ts kits/agent-guard/tests/incident-replay.test.ts
git commit -m '[Feature] 检测异常智能体流量'
```

### Task 8: Persist only bounded allowlisted metadata

**Files:**
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/storage.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/storage.test.ts`

**Interfaces:**
- Consumes: metric projections, incidents, policy overrides, baseline, control ledger.
- Produces: atomic state, batched daily NDJSON, retention, cap, crash-safe ledger.

- [ ] **Step 1: Add failing persistence/privacy tests**

```ts
await store.appendMetrics(Array.from({ length: 10_000 }, metricFixture));
expect(await directoryBytes(metricsFile)).toBeLessThanOrEqual(20 * MIB);
expect(await store.listMetricFiles()).not.toContain('metrics-expired.ndjson');
expect(readPersistedText()).not.toMatch(/prompt|response|authorization|secret-key/iu);
```

- [ ] **Step 2: Prove tests fail**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/storage.test.ts`

Expected: FAIL on missing store.

- [ ] **Step 3: Implement safe file schemas and retention**

```ts
export interface AgentGuardStore {
  loadState(): Promise<PersistedStateV1>;
  saveState(state: PersistedStateV1): Promise<void>;
  appendMetrics(metrics: PersistedMetricV1[]): Promise<void>;
  appendIncidents(events: PersistedIncidentV1[]): Promise<void>;
  saveControlLedger(entries: ControlLedgerEntryV1[]): Promise<void>;
  enforceRetention(now: Date): Promise<void>;
}
```

Require an absolute data directory, resolve/verify its real parent, create directory mode `0700`, files mode `0600`, and use same-directory temporary files plus rename. Unknown serialization fields fail. Missing path/web mode returns read-only degraded storage rather than using cwd or Home.

- [ ] **Step 4: Run storage/privacy tests**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/storage.test.ts tests/privacy-contract.test.ts`

Expected: PASS for partial temp files, corrupted final NDJSON line, retention order, cap, permissions, missing path, and secret rejection.

- [ ] **Step 5: Commit**

```bash
git add kits/agent-guard/plugins/agent-guard-background/main/src/storage.ts kits/agent-guard/plugins/agent-guard-background/tests/storage.test.ts
git commit -m '[Feature] 持久化智能体守卫元数据'
```

### Task 9: Add safe control and recovery watchdog

**Files:**
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/process-controller.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/watchdog-protocol.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/watchdog-entry.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/watchdog.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/process-controller.test.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/watchdog.test.ts`

**Interfaces:**
- Consumes: validated target candidate, live process source, control ledger, signal sender.
- Produces: pause/resume/recursive termination and watchdog recovery.

- [ ] **Step 1: Add failing safety/recovery tests**

```ts
await expect(controller.pause(staleTarget)).rejects.toMatchObject({ code: 'CONTROL_TARGET_STALE' });
await expect(controller.pause(hostTarget)).rejects.toMatchObject({ code: 'CONTROL_TARGET_UNSAFE' });
expect(signal).not.toHaveBeenCalled();
await watchdogHarness.closeHeartbeatUnexpectedly();
expect(signal).toHaveBeenCalledWith(testPid, 'SIGCONT');
```

- [ ] **Step 2: Prove tests fail**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/process-controller.test.ts plugins/agent-guard-background/tests/watchdog.test.ts`

Expected: FAIL on missing modules.

- [ ] **Step 3: Implement revalidation, ordered termination, and watchdog**

```ts
export interface VerifiedControlTarget {
  pid: number;
  processStartTime: number;
  executableIdentity: string;
  processGroupId: number;
  role: 'task' | 'hook';
}
```

Re-read every field before signals. Use `SIGSTOP`/`SIGCONT`. Terminate verified leaves before parents with `SIGTERM`, wait 3 seconds, revalidate survivors, then `SIGKILL` only original verified survivors. The watchdog accepts only PID/start/identity plus heartbeat/clean shutdown and can send only `SIGCONT`.

- [ ] **Step 4: Run fixture-only control tests**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/process-controller.test.ts plugins/agent-guard-background/tests/watchdog.test.ts`

Expected: PASS for duplicate operations, reuse, host refusal, leaf ordering, clean exit, heartbeat loss, and ledger recovery. Every test PID must be a child of the test runner.

- [ ] **Step 5: Commit**

```bash
git add kits/agent-guard/plugins/agent-guard-background/main/src/process-controller.ts kits/agent-guard/plugins/agent-guard-background/main/src/watchdog-protocol.ts kits/agent-guard/plugins/agent-guard-background/main/src/watchdog-entry.ts kits/agent-guard/plugins/agent-guard-background/main/src/watchdog.ts kits/agent-guard/plugins/agent-guard-background/tests/process-controller.test.ts kits/agent-guard/plugins/agent-guard-background/tests/watchdog.test.ts
git commit -m '[Feature] 熔断并恢复异常智能体任务'
```

### Task 10: Assemble background orchestration and notifications

**Files:**
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/notifications.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/service.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/main/src/index.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/notifications.test.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/service.test.ts`
- Create: `kits/agent-guard/plugins/agent-guard-background/tests/plugin-main.test.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-background/package.json`

**Interfaces:**
- Consumes: Tasks 4–9 and `HARBORS_NOTIFICATION_PORT`.
- Produces: application methods `getSnapshot`, `updatePolicy`, `executeCommand`, `getIncidents`; lifecycle start/dispose; deduplicated notices.

- [ ] **Step 1: Add failing lifecycle/command tests**

```ts
await service.start();
expect(await service.getSnapshot()).toMatchObject({
  schemaVersion: 1,
  collector: { status: 'ready' },
});
await service.executeCommand({ type: 'resume', incidentId: 'incident-1' });
expect(controller.resume).toHaveBeenCalledTimes(1);
await service.dispose();
expect(collector.stop).toHaveBeenCalledTimes(1);
```

```ts
expect(backgroundManifest['ce-editor'].contribute.message.request).toEqual({
  getSnapshot: ['getSnapshot'],
  updatePolicy: ['updatePolicy'],
  executeCommand: ['executeCommand'],
  getIncidents: ['getIncidents'],
});
```

- [ ] **Step 2: Prove tests fail**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests/notifications.test.ts plugins/agent-guard-background/tests/service.test.ts plugins/agent-guard-background/tests/plugin-main.test.ts`

Expected: FAIL on missing service/entry.

- [ ] **Step 3: Implement lifecycle and projections**

```ts
editor.plugin.define({
  lifecycle: {
    async load(runtime) {
      service = createAgentGuardService({ runtime, env: process.env });
      await service.start();
    },
    async unload() {
      await service?.dispose();
      service = null;
    },
  },
  methods: {
    getSnapshot: () => requireService().getSnapshot(),
    updatePolicy: (input: unknown) => requireService().updatePolicy(input),
    executeCommand: (input: unknown) => requireService().executeCommand(input),
    getIncidents: (input: unknown) => requireService().getIncidents(input),
  },
});
```

Batch metrics every 10 seconds, evaluate every 60 seconds, rescan adapters at startup/watch changes, and deduplicate notices by Agent/endpoint/rule for 10 minutes. Follow the design degradation matrix for Collector/config/DNS/storage/notification failures.

- [ ] **Step 4: Run background tests and build**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-background/tests && npm run build -w @itharbors/kit-agent-guard`

Expected: PASS and background manifest has no Panel contribution.

- [ ] **Step 5: Commit**

```bash
git add kits/agent-guard/plugins/agent-guard-background
git commit -m '[Feature] 启动智能体流量后台守卫'
```

### Task 11: Build the lazy Agent Guard dashboard

**Files:**
- Create: `kits/agent-guard/plugins/agent-guard-center/package.json`
- Create: `kits/agent-guard/plugins/agent-guard-center/main/src/index.ts`
- Create: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.html`
- Create: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts`
- Create: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.css`
- Create: `kits/agent-guard/plugins/agent-guard-center/tests/main.test.ts`
- Create: `kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts`
- Create: `kits/agent-guard/tests/panel-accessibility.test.ts`

**Interfaces:**
- Consumes: Task 2 server bridge and shared normalizers.
- Produces: session forwarding methods and accessible `@itharbors/agent-guard-center.guard` panel.

- [ ] **Step 1: Invoke frontend-design and add failing UI tests**

Read and follow `frontend-design/SKILL.md` before editing visual files. Tests:

```ts
expect(application.request).toHaveBeenCalledWith(
  '@itharbors/agent-guard-background',
  'getSnapshot',
);
expect(document.querySelector('[data-metric="bytes-out"]')?.textContent).toBe('12.0 MiB/min');
expect(document.querySelector('[data-confidence]')?.textContent).toBe('Confirmed');
expect(document.body.textContent).not.toMatch(/request count|token cost/iu);
```

- [ ] **Step 2: Prove UI tests fail**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-center/tests tests/panel-accessibility.test.ts`

Expected: FAIL on missing center/panel.

- [ ] **Step 3: Implement bridge and dashboard**

```ts
editor.plugin.define({
  lifecycle: { load(ctx) { runtime = ctx; } },
  methods: {
    getSnapshot: () => runtime.application.request(BACKGROUND, 'getSnapshot'),
    updatePolicy: (input: unknown) => runtime.application.request(BACKGROUND, 'updatePolicy', input),
    executeCommand: (input: unknown) => runtime.application.request(BACKGROUND, 'executeCommand', input),
    getIncidents: (input: unknown) => runtime.application.request(BACKGROUND, 'getIncidents', input),
    openGuardPanel: () => runtime.window.openPanel('@itharbors/agent-guard-center.guard'),
  },
});
```

Use a restrained dark operations-desk layout: protection header, endpoint cards, CSS/SVG byte sparklines, incident ledger, confidence chips, policy form, and `role="status"`. Poll every 2 seconds only while mounted, coalesce reads, discard stale results, serialize mutations, honor reduced motion, and remove timers on unmount.

- [ ] **Step 4: Run UI/accessibility/build checks**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-center/tests tests/panel-accessibility.test.ts && npm run build -w @itharbors/kit-agent-guard && npm run plugins:check`

Expected: PASS with zero polling after unmount and no request/Token claims.

- [ ] **Step 5: Commit**

```bash
git add kits/agent-guard/plugins/agent-guard-center kits/agent-guard/layout.json kits/agent-guard/main.html kits/agent-guard/secondary.html kits/agent-guard/tests/panel-accessibility.test.ts
git commit -m '[Feature] 展示智能体流量守卫面板'
```

### Task 12: Prove startup, replay, privacy, and performance

**Files:**
- Create: `kits/agent-guard/tests/runtime-integration.test.ts`
- Create: `kits/agent-guard/tests/performance.test.ts`
- Create: `scripts/agent-guard-smoke.mjs`
- Create: `docs/superpowers/reports/2026-07-30-agent-traffic-guard-performance.md`
- Modify: `docs/guides/developing-plugins-and-kits.md`
- Modify: `docs/architecture/system-overview.md`
- Modify: `docs/architecture/plugin-runtime-model.md`
- Modify: `readme.md`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: completed framework/Kit.
- Produces: acceptance evidence, docs, root test integration, fixture-only smoke command.

- [ ] **Step 1: Add failing end-to-end/performance tests**

```ts
expect(applicationBootstrap.plugins).toContainEqual(expect.objectContaining({
  name: '@itharbors/agent-guard-background',
  status: 'running',
}));
expect(sessionCountBeforeOpeningGuard).toBe(0);
expect(replayedIncident.control?.action).toBe('terminate-recursive-subtree');
expect(serializedArtifacts).not.toMatch(/prompt|response|authorization|api.?key/iu);
```

Stream 100,000 synthetic observations through parser, attribution, aggregation, policy, and storage. Assert bounded retained windows and file bytes; record event-loop delay/RSS without claiming synthetic CPU proves the real Mac budget.

- [ ] **Step 2: Prove acceptance tests fail**

Run: `npm run test -w @itharbors/kit-agent-guard -- --run tests/runtime-integration.test.ts tests/incident-replay.test.ts tests/performance.test.ts`

Expected: FAIL until harness/report integration exists.

- [ ] **Step 3: Implement safe smoke and documentation**

```js
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Agent Guard smoke testing requires macOS arm64');
}
if (!fixturePid || fixtureParentPid !== process.pid) {
  throw new Error('Refusing to control a process not created by this smoke test');
}
```

The smoke script creates its own named child and local TCP endpoint, observes only that fixture, tests bytes and pause/resume, and always restores/terminates fixture children in `finally`. It accepts no arbitrary PID. Add `test:agent-guard` to the root test chain and document permission/runtime/privacy limitations.

- [ ] **Step 4: Run all authoritative checks**

Run:

```bash
npm run test -w @itharbors/kit-agent-guard
npm run build -w @itharbors/kit-agent-guard
node scripts/agent-guard-smoke.mjs --duration-seconds 900 --report docs/superpowers/reports/2026-07-30-agent-traffic-guard-performance.md
npm run plugins:check
npm run check
git diff --check
```

Expected: PASS. The 15-minute report includes idle/stress CPU, background/watchdog RSS, storage projection, event-loop delay, hardware/OS, and explicit pass/fail against every budget.

- [ ] **Step 5: Audit all 10 design criteria and commit**

Map each criterion to a test, runtime output, measurement, manifest, or code inspection; missing/indirect evidence remains incomplete.

```bash
git add kits/agent-guard/tests scripts/agent-guard-smoke.mjs docs/superpowers/reports/2026-07-30-agent-traffic-guard-performance.md docs/guides/developing-plugins-and-kits.md docs/architecture/system-overview.md docs/architecture/plugin-runtime-model.md readme.md package.json package-lock.json
git commit -m '[Feature] 验证智能体流量守卫完整链路'
```

### Task 13: Final branch verification and PR handoff

**Files:**
- Verify only; modify files only to fix failures found by the completion audit.

**Interfaces:**
- Produces: clean worktree, focused commits, verified `PR_URL=`.

- [ ] **Step 1: Re-run from a clean build state**

```bash
npm run clean
npm run check
npm run test:change-workflow
npm run test:kit-workflow
git diff --check
git status --short
```

Expected: PASS and empty status. If clean removes tracked build products, rebuild and stage only required tracked outputs before rechecking.

- [ ] **Step 2: Inspect the full branch**

```bash
git log --oneline --decorate 6eaeb7625042c136bc7bb5215894941b8b26e34d..HEAD
git diff --stat 6eaeb7625042c136bc7bb5215894941b8b26e34d..HEAD
git diff --check 6eaeb7625042c136bc7bb5215894941b8b26e34d..HEAD
```

Expected: only Agent Guard, necessary framework changes, tests, and docs.

- [ ] **Step 3: Create an external PR body**

```markdown
## Summary

- add zero-configuration macOS Agent Guard monitoring for Claude Code and Codex
- detect byte-rate anomalies and recursive process/session storms without TLS decryption
- safely control only revalidated task processes with crash-safe recovery and bounded private storage

## Testing

- `npm run check`
- `node scripts/agent-guard-smoke.mjs --duration-seconds 900 --report docs/superpowers/reports/2026-07-30-agent-traffic-guard-performance.md`
- `npm run test:change-workflow`
- `npm run test:kit-workflow`
```

- [ ] **Step 4: Finish through the repository workflow**

Write the body to `/tmp/agent-traffic-guard-pr-body.md` with `apply_patch`, then run:

```bash
.agents/skills/change-workflow/scripts/finish-change.sh '实现本机智能体流量守卫' /tmp/agent-traffic-guard-pr-body.md
```

Expected: output contains `PR_URL=`; a push or compare URL is not a PR.

- [ ] **Step 5: Report evidence**

Report the PR URL, measured budgets, supported Agent/OS scope, zero-proxy privacy boundary, and only verification commands that actually ran. Keep the branch/worktree unless cleanup is explicitly requested.
