# Application Plugin Process Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run every application startup/background plugin in its own supervised operating-system process so one broken plugin is cleaned up and restarted without terminating Framework, Electron, sibling plugins, or Kit windows.

**Architecture:** Framework owns an `ApplicationPluginSupervisor` per startup plugin and communicates with a fixed runner through a validated, generation-scoped child-process RPC protocol. The runner keeps plugin functions inside the child and exposes a compatible application runtime facade; ApplicationRuntime keeps menu/message/service ownership, bootstrap state, restart policy, and explicit retry control.

**Tech Stack:** TypeScript ESM, Node `child_process` IPC with advanced serialization, Vitest fake timers and real child fixtures, existing Harbors ApplicationRuntime/MessageModule/MenuModule, Electron run-as-node packaged runtime.

## Global Constraints

- Every application startup plugin gets one child process; there is no in-process fallback.
- Session plugins remain in-process in this change and retain their current `PluginModule` behavior.
- IPC protocol version is exactly `1`; every message is generation-scoped and exact-field validated.
- Payload limits are 1 MiB serialized size, depth 32, and 256 pending requests per peer.
- Automatic restart delays are exactly 250 ms, 1 s, and 4 s; the fourth failure inside 60 seconds fuses the plugin; five stable minutes reset the budget.
- Definition/load timeout is 30 seconds; unload timeout is 10 seconds followed by SIGTERM and SIGKILL after 2 seconds.
- Plugin failure cleans owner routes/resources before restart is scheduled.
- Host-only application and notification tokens never enter plugin child environments.
- Agent Guard watchdog recovery and fail-closed pause semantics remain unchanged.
- Use TDD for every behavior change and commit only focused files with `[Feature]` Chinese titles.

---

### Task 1: Versioned IPC envelopes and bounded RPC peer

**Files:**
- Create: `packages/server/src/application/plugin-process/protocol.ts`
- Create: `packages/server/src/application/plugin-process/rpc-peer.ts`
- Test: `packages/server/tests/application/plugin-process-protocol.test.ts`

**Interfaces:**
- Produces `PLUGIN_PROCESS_PROTOCOL = 1`.
- Produces `PluginProcessEnvelope`, `PluginProcessRequest`, `PluginProcessResponse`, `PluginProcessEvent`.
- Produces `parsePluginProcessEnvelope(input, expectedGeneration)`.
- Produces `assertPluginProcessPayload(input)` for structured-clone-compatible bounded data.
- Produces `createPluginProcessRpcPeer({ generation, send, subscribe, maxPending? })` with `request`, `respond`, `emit`, and `close`.
- `close(error)` rejects all pending requests and makes future requests reject with the same terminal error.

- [ ] **Step 1: Write failing protocol tests**

Add literal tests that accept one valid request and reject wrong protocol, unknown fields, stale generation, function/symbol/prototype/cycle payloads, depth 33, serialized payload over 1 MiB, and a 257th pending request. Assert `close()` rejects pending and future requests with `APPLICATION_PLUGIN_UNAVAILABLE`.

```ts
const peer = createPluginProcessRpcPeer({
  generation: 'gen-1',
  send: vi.fn(),
  subscribe: (listener) => { receive = listener; return () => undefined; },
});
const pending = peer.request('invoke', { method: 'ping', args: [] });
receive({ protocol: 1, generation: 'gen-1', kind: 'response', requestId: '1', ok: true, payload: 'pong' });
await expect(pending).resolves.toBe('pong');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test -w packages/server -- --run tests/application/plugin-process-protocol.test.ts`

Expected: FAIL because the protocol modules do not exist.

- [ ] **Step 3: Implement exact validation and RPC settlement**

Use a null-prototype/plain-object walk with a `WeakSet`, explicit depth accounting, and `Buffer.byteLength(JSON.stringify(value), 'utf8')` after validation. Normalize remote errors to:

```ts
export interface PluginProcessErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
  retryAfterMs?: number;
}
```

Never deserialize a remote stack or arbitrary error properties.

- [ ] **Step 4: Run focused test and server typecheck**

Run: `npm run test -w packages/server -- --run tests/application/plugin-process-protocol.test.ts`

Expected: PASS with no unhandled rejections.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/application/plugin-process/protocol.ts packages/server/src/application/plugin-process/rpc-peer.ts packages/server/tests/application/plugin-process-protocol.test.ts
git commit -m "[Feature] 建立插件进程通信协议"
```

---

### Task 2: Fixed runner and child-side application runtime facade

**Files:**
- Create: `packages/server/src/application/plugin-process/runner-runtime.ts`
- Create: `packages/server/src/application/plugin-process/runner-host.ts`
- Create: `packages/server/src/application/plugin-process/runner.ts`
- Test: `packages/server/tests/application/plugin-process-runner.test.ts`
- Modify: `packages/server/tsconfig.build.json`

**Interfaces:**
- Produces `runApplicationPluginRunner({ transport, importModule?, exit, timers })` for deterministic tests.
- Produces executable `runner.ts`, which binds `process.send`, `process.on('message')`, `uncaughtException`, `unhandledRejection`, `disconnect`, SIGINT, and SIGTERM.
- Consumes Task 1 RPC envelopes.
- Initialize payload is exactly:

```ts
interface InitializeApplicationPluginPayload {
  entryPath: string;
  pluginName: string;
  runtime: {
    paths: { data: string; cache: string; temp: string; legacyData: string[] };
    hostMode: 'desktop' | 'web';
    pluginSnapshot: Array<{ name: string; path: string }>;
    menuSnapshot: unknown;
    serviceSnapshot: Record<string, unknown>;
    notificationCapability: boolean;
  };
}
```

- Runner operations are `initialize`, `invoke`, `attach`, `detach`, `runtime-snapshot`, `unload`, and `shutdown`.

- [ ] **Step 1: Write failing runner tests**

Create temporary ESM plugin entries and a memory transport. Cover one-definition-only, missing definition, method-name response, lifecycle load/unload, invoke result/error, forbidden owner override, runtime command drain before `loaded`, notification RPC, stale command rejection, and cleanup of `globalThis.editor`.

Add a runner fixture whose timer throws `runner exploded`; assert the transport emits `fatal` and the injected `exit({ failed: true })` runs once.

- [ ] **Step 2: Run focused test and verify RED**

Run: `npm run test -w packages/server -- --run tests/application/plugin-process-runner.test.ts`

Expected: FAIL because runner files do not exist.

- [ ] **Step 3: Implement definition capture and facade**

Keep `definition` and functions child-local. The facade must force its own owner and expose:

```ts
const runtime = Object.freeze({
  paths: Object.freeze(runtimePaths),
  host: Object.freeze({ mode, notifications }),
  plugin: pluginSnapshotFacade,
  menu: menuSnapshotFacade,
  message: messageRpcFacade,
  service: serviceSnapshotFacade,
});
```

Void runtime mutations enqueue `runtime-command` requests. `initialize` waits for `lifecycle.load()` and `Promise.all(pendingCommands)` before returning method names. Any command failure after load calls the runner fatal path.

- [ ] **Step 4: Make the executable runner fail closed**

Require exactly one IPC parent, reject a second initialize, never accept an entry override after initialization, and remove `globalThis.editor` in `finally`. On disconnect or fatal error, set a terminal flag, reject pending RPC, run best-effort unload for at most 10 seconds, and exit nonzero.

- [ ] **Step 5: Run focused tests and build output check**

Run: `npm run test -w packages/server -- --run tests/application/plugin-process-runner.test.ts`

Run: `npm run build -w packages/server && test -f packages/server/dist/application/plugin-process/runner.js`

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/application/plugin-process/runner-runtime.ts packages/server/src/application/plugin-process/runner-host.ts packages/server/src/application/plugin-process/runner.ts packages/server/tests/application/plugin-process-runner.test.ts packages/server/tsconfig.build.json
git commit -m "[Feature] 实现应用插件独立运行器"
```

---

### Task 3: Spawn adapter and terminal process cleanup

**Files:**
- Create: `packages/server/src/application/plugin-process/spawn.ts`
- Test: `packages/server/tests/application/plugin-process-spawn.test.ts`
- Modify: `scripts/lib/desktop-framework.mjs`
- Test: `scripts/lib/desktop-framework.test.mjs`

**Interfaces:**
- Produces `spawnApplicationPluginProcess(options): ApplicationPluginChild`.
- Produces `resolveApplicationPluginRunner(importMetaUrl)` selecting `runner.ts` plus the `tsx` loader in source/dev and compiled `runner.js` in build/packaged runtime.
- Child uses `stdio: ['ignore', 'pipe', 'pipe', 'ipc']`, `serialization: 'advanced'`, no detached process, and a sanitized environment.
- Child environment preserves `PATH`, `HOME`, `USER`, `TMPDIR`, locale variables, `CODEX_HOME`, and existing non-secret product configuration; it removes `HARBORS_APPLICATION_TOKEN`, notification owner tokens, credential transport secrets, and every key explicitly captured by `captureApplicationHostSecrets`.

- [ ] **Step 1: Write failing spawn-spec tests**

Inject a fake `spawn` and assert executable/arguments for Node dev, Node dist, and Electron run-as-node. Assert cwd remains the Framework cwd, host tokens are absent, IPC is enabled, and stdout/stderr are piped.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run test -w packages/server -- --run tests/application/plugin-process-spawn.test.ts`

Run: `node --test scripts/lib/desktop-framework.test.mjs`

Expected: FAIL because no application plugin spawn adapter exists.

- [ ] **Step 3: Implement spawn and runner resolution**

Return a narrow child wrapper with `pid`, `send`, `subscribeMessage`, `subscribeExit`, `terminate`, `kill`, and bounded 64 KiB stdout/stderr tails. Do not expose raw ChildProcess to ApplicationRuntime.

For Electron, set `ELECTRON_RUN_AS_NODE=1` only in the child environment. Do not place application control tokens in command-line arguments or environment.

- [ ] **Step 4: Add Framework final cleanup registration**

Expose the runner path/runtime mode through server options rather than a global. Ensure `runDesktopFrameworkProcess` shutdown awaits ApplicationRuntime disposal, which in later tasks drains every child.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test -w packages/server -- --run tests/application/plugin-process-spawn.test.ts`

Run: `node --test scripts/lib/desktop-framework.test.mjs`

```bash
git add packages/server/src/application/plugin-process/spawn.ts packages/server/tests/application/plugin-process-spawn.test.ts scripts/lib/desktop-framework.mjs scripts/lib/desktop-framework.test.mjs
git commit -m "[Feature] 启动并清理插件子进程"
```

---

### Task 4: Supervisor state machine, owner-first cleanup, restart, and fuse

**Files:**
- Create: `packages/server/src/application/plugin-process/supervisor.ts`
- Create: `packages/server/src/application/plugin-process/types.ts`
- Test: `packages/server/tests/application/plugin-process-supervisor.test.ts`

**Interfaces:**
- Produces `ApplicationPluginSupervisor` with `start`, `invoke`, `attach`, `detach`, `updateRuntimeSnapshot`, `retry`, `stop`, `getState`, and `subscribe`.
- Produces `ApplicationPluginProcessState` containing status, generation, pid, restartCount, lastFailureAt, error, and retryAfterMs.
- Consumes `spawnApplicationPluginProcess`, Task 1 RPC, and callbacks:

```ts
interface ApplicationPluginSupervisorHost {
  initializePayload(generation: string): InitializeApplicationPluginPayload;
  handleRuntimeCommand(plugin: string, command: RuntimeCommand): Promise<unknown>;
  clearOwner(plugin: string): Promise<void> | void;
  onStateChanged(state: ApplicationPluginProcessState): void;
}
```

- [ ] **Step 1: Write failing supervisor state tests**

Use a controllable fake child and fake timers. Assert `starting -> running`, invoke forwarding, owner cleanup before restart scheduling, pending rejection, 250/1000/4000 ms backoff, fourth failure fuse, five-minute stable reset, explicit retry generation replacement, one-child invariant, unload timeout escalation, and no restart during stop.

Mutation assertion: if `clearOwner` is moved after scheduling, the test must fail on event order.

- [ ] **Step 2: Run focused test and verify RED**

Run: `npm run test -w packages/server -- --run tests/application/plugin-process-supervisor.test.ts`

Expected: FAIL because supervisor does not exist.

- [ ] **Step 3: Implement generation-sticky terminal behavior**

Use a monotonically increasing opaque generation string. On exit/disconnect/fatal: mark unavailable synchronously, close RPC, await host cleanup, publish state, then create exactly one restart timer. Ignore every message whose generation is no longer current.

- [ ] **Step 4: Implement restart budget and stop escalation**

Store failure timestamps using injected `now()`. Prune entries older than 60 seconds. Schedule three delays exactly. `retry()` cancels backoff, clears failures, cleans any current generation, and starts a new generation. `stop()` sets the stopping flag before sending unload, so exit cannot schedule restart.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm run test -w packages/server -- --run tests/application/plugin-process-supervisor.test.ts`

```bash
git add packages/server/src/application/plugin-process/supervisor.ts packages/server/src/application/plugin-process/types.ts packages/server/tests/application/plugin-process-supervisor.test.ts
git commit -m "[Feature] 监督并重启故障插件进程"
```

---

### Task 5: ApplicationRuntime process integration and bootstrap projection

**Files:**
- Modify: `packages/server/src/application/runtime.ts`
- Modify: `packages/server/src/application/types.ts`
- Modify: `packages/server/src/application/service-registry.ts`
- Test: `packages/server/tests/application/runtime.test.ts`
- Test: `packages/server/tests/application/application-process-runtime.test.ts`

**Interfaces:**
- `ApplicationRuntimeOptions` gains injectable `createPluginSupervisor` and process runtime options; production defaults to Task 4.
- `ApplicationRuntime` gains `retryPlugin(name): Promise<ApplicationBootstrap>`.
- `ApplicationPluginStatus` becomes the seven-state union from the design.
- `ApplicationPluginState` gains optional `generation`, `pid`, `restartCount`, `lastFailureAt`, `errorCode`, and `retryAfterMs`.
- `ApplicationServiceRegistry.snapshot()` returns a structured clone of values and rejects non-cloneable registrations.

- [ ] **Step 1: Rewrite application runtime tests around supervisor boundaries**

Replace assertions that depend on plugin code mutating test-process globals. Inject fake supervisors and assert sequential startup, degraded continuation, menu/message/service owner cleanup, reverse stop order, bootstrap events, retry behavior, and notification capability forwarding.

Keep a test proving Session `PluginModule` still imports in-process and behaves unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run test -w packages/server -- --run tests/application/runtime.test.ts tests/application/application-process-runtime.test.ts`

Expected: FAIL because ApplicationRuntime still owns an in-process PluginModule.

- [ ] **Step 3: Replace startup PluginModule with supervisors**

Continue reading plugin manifests with the existing resolver, reject Session-only contributions before spawn, attach static contributions only after supervisor reports running, and route contributed methods through `supervisor.invoke()`.

Implement host runtime commands with forced owner:

```ts
switch (command.type) {
  case 'menu.attach': return menu.attach(pluginName, command.contribute);
  case 'message.broadcast': return message.broadcast(command.topic, ...command.args);
  case 'service.register': return service.register(pluginName, command.name, command.value);
  case 'notification.create': return notificationCapability.create(command.input);
}
```

Manual message registrations use child handler IDs; Framework route callbacks invoke the owning supervisor handler. Unknown command types fail the generation.

- [ ] **Step 4: Publish state without leaking diagnostics**

Map supervisor errors to stable bootstrap fields. Do not expose entry path, stderr, stack, child environment, notification payload, or credential details. Application phase is `ready` only when all supervisors are running and diagnostics are empty.

- [ ] **Step 5: Run focused tests and server test suite**

Run: `npm run test -w packages/server -- --run tests/application/runtime.test.ts tests/application/application-process-runtime.test.ts`

Run: `npm run test -w packages/server`

Expected: all server tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/application/runtime.ts packages/server/src/application/types.ts packages/server/src/application/service-registry.ts packages/server/tests/application/runtime.test.ts packages/server/tests/application/application-process-runtime.test.ts
git commit -m "[Feature] 将后台插件接入隔离进程"
```

---

### Task 6: Authenticated explicit plugin retry control

**Files:**
- Create: `packages/server/src/routes/application-plugin-retry.ts`
- Create: `packages/server/tests/routes/application-plugin-retry.test.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/tests/application/server-lifecycle.test.ts`

**Interfaces:**
- Adds fixed route `POST /api/application/plugin/retry`.
- Body is exactly `{ "plugin": "@scope/name" }` and is limited by existing JSON body controls.
- Requires the same `x-harbors-application-token` comparison used by application menu mutation.
- Calls `ApplicationRuntime.retryPlugin(plugin)` and returns the sanitized bootstrap.

- [ ] **Step 1: Write failing route tests**

Cover method, content type, missing/wrong token, unknown fields, invalid plugin identity, unknown plugin, running plugin, fused plugin success, and secret-free error responses.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm run test -w packages/server -- --run tests/routes/application-plugin-retry.test.ts tests/application/server-lifecycle.test.ts`

Expected: FAIL with route not found.

- [ ] **Step 3: Implement route using existing mutation auth helpers**

Do not create a second token parser. Reuse or extract the constant-time application mutation authorization used by `application-menu-trigger.ts`.

- [ ] **Step 4: Run focused tests and commit**

Run: `npm run test -w packages/server -- --run tests/routes/application-plugin-retry.test.ts tests/application/server-lifecycle.test.ts`

```bash
git add packages/server/src/routes/application-plugin-retry.ts packages/server/tests/routes/application-plugin-retry.test.ts packages/server/src/app.ts packages/server/tests/application/server-lifecycle.test.ts packages/server/src/routes/application-menu-trigger.ts
git commit -m "[Feature] 支持显式重启故障插件"
```

---

### Task 7: Real child-process fault-containment acceptance

**Files:**
- Create: `packages/server/tests/fixtures/application-plugin/healthy/package.json`
- Create: `packages/server/tests/fixtures/application-plugin/healthy/main/dist/index.js`
- Create: `packages/server/tests/fixtures/application-plugin/crashing/package.json`
- Create: `packages/server/tests/fixtures/application-plugin/crashing/main/dist/index.js`
- Create: `packages/server/tests/application/plugin-process-acceptance.test.ts`
- Modify: `packages/server/src/application/plugin-process/spawn.ts`

**Interfaces:**
- Healthy fixture returns its pid and an incrementing generation-local counter.
- Crashing fixture supports methods `crashUncaught`, `crashRejection`, `exit42`, and `ping`.
- Acceptance test starts a real ApplicationRuntime and HTTP server, not a fake child.

- [ ] **Step 1: Write failing real-process acceptance test**

Assert healthy and crashing plugin pids differ from Framework and each other. Trigger each crash mode and prove:

- `/api/health` remains 200;
- healthy sibling request remains successful;
- crashed request rejects with `APPLICATION_PLUGIN_UNAVAILABLE`;
- bootstrap moves through restarting/degraded and returns to running;
- plugin pid changes after restart;
- no stale owner menu or message route exists between generations.

- [ ] **Step 2: Run test and verify RED**

Run: `npm run build -w packages/server && npm run test -w packages/server -- --run tests/application/plugin-process-acceptance.test.ts`

Expected: FAIL until real spawn and runner path work together.

- [ ] **Step 3: Complete source/dist runner resolution and process teardown**

Make the acceptance pass under Vitest source mode and after `packages/server` build. Record every fixture pid and assert all are gone after `runtime.dispose()`.

- [ ] **Step 4: Run acceptance repeatedly**

Run: `for i in 1 2 3; do npm run test -w packages/server -- --run tests/application/plugin-process-acceptance.test.ts || exit 1; done`

Expected: three clean passes with no orphan pids.

- [ ] **Step 5: Commit**

```bash
git add packages/server/tests/fixtures/application-plugin packages/server/tests/application/plugin-process-acceptance.test.ts packages/server/src/application/plugin-process/spawn.ts
git commit -m "[Feature] 验证插件故障不扩散"
```

---

### Task 8: Official startup plugin compatibility and Agent Guard invariant

**Files:**
- Test: `packages/server/tests/application/official-startup-plugin-process.test.ts`

**Interfaces:**
- All three currently published official startup plugins load unchanged through real isolated runners.
- Spawn environment preserves Scheduler's non-secret `HARBORS_DATA_ROOT` compatibility while removing host-only secrets.
- Existing Agent Guard smoke remains the authority for detached watchdog recovery; the Framework acceptance proves killing the actual Agent Guard child does not terminate Framework and creates a new generation.

- [ ] **Step 1: Write failing official-plugin runtime tests**

Assert each official startup plugin reports a pid distinct from Framework, methods remain callable, Notifications reaches a fake host capability, and Scheduler retains its current data-directory behavior.

Terminate the actual Agent Guard child from the host, verify Framework and sibling plugins remain available, and verify a replacement Agent Guard generation becomes running. Separately run the unchanged Agent Guard smoke to prove stdin-close recovery revalidates and resumes a paused fixture.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run test -w packages/server -- --run tests/application/official-startup-plugin-process.test.ts`

Run: `npm run test --prefix kits/scheduler -- --run plugins/scheduler-service/tests/plugin-main.test.ts`

Expected: process acceptance is absent before the Framework integration exists.

- [ ] **Step 3: Preserve published-Kit compatibility in the process facade**

Pass the same non-sensitive product environment and Framework cwd that current startup plugins observe, while stripping host-only tokens. Do not edit market Kit sources on the Framework branch. If a Kit-specific source change becomes necessary, stop that part and start a separate Kit workflow only after its Framework dependency exists on `main`.

- [ ] **Step 4: Run official Kit checks**

Run each with a distinct `mktemp -d` output directory:

```bash
NOTIFICATIONS_OUTPUT=$(mktemp -d)
SCHEDULER_OUTPUT=$(mktemp -d)
AGENT_GUARD_OUTPUT=$(mktemp -d)
npm run kit:check -- notifications --output-directory "$NOTIFICATIONS_OUTPUT"
npm run kit:check -- scheduler --output-directory "$SCHEDULER_OUTPUT"
npm run kit:check -- agent-guard --output-directory "$AGENT_GUARD_OUTPUT"
```

Expected: every command exits 0 and produces one `.hkit`.

- [ ] **Step 5: Run Agent Guard smoke and commit**

Run: `npm run smoke --prefix kits/agent-guard`

Expected: report shows paused fixture recovered after plugin-process termination and no fixture remains stopped.

```bash
git add packages/server/tests/application/official-startup-plugin-process.test.ts packages/server/src/application/plugin-process/spawn.ts
git commit -m "[Feature] 验证官方后台插件进程兼容"
```

---

### Task 9: Runtime documentation and desktop packaging contract

**Files:**
- Modify: `docs/architecture/plugin-runtime-model.md`
- Modify: `docs/architecture/runtime-flows.md`
- Modify: `docs/guides/developing-plugins-and-kits.md`
- Modify: `scripts/lib/desktop-package.test.mjs`
- Modify: `scripts/lib/desktop-framework.test.mjs`

**Interfaces:**
- Documents process topology, structured-clone service limitation, asynchronous cross-plugin visibility, restart/fuse states, explicit retry, and Session non-migration.
- Desktop runtime contains `packages/server/dist/application/plugin-process/runner.js`.

- [ ] **Step 1: Write failing packaging assertions**

Assert staged and packaged runtime include the compiled runner and Electron child environment receives `ELECTRON_RUN_AS_NODE=1` without host tokens.

- [ ] **Step 2: Run desktop tests and verify RED**

Run: `node --test scripts/lib/desktop-package.test.mjs scripts/lib/desktop-framework.test.mjs`

Expected: FAIL on missing runner/process contract assertion.

- [ ] **Step 3: Update packaging and documentation**

Keep documentation explicit that process isolation is crash containment rather than an OS permission sandbox. Include the restart state diagram and owner cleanup order from the design.

- [ ] **Step 4: Run desktop tests and commit**

Run: `node --test scripts/lib/desktop-package.test.mjs scripts/lib/desktop-framework.test.mjs`

```bash
git add docs/architecture/plugin-runtime-model.md docs/architecture/runtime-flows.md docs/guides/developing-plugins-and-kits.md scripts/lib/desktop-package.test.mjs scripts/lib/desktop-framework.test.mjs
git commit -m "[Feature] 完善插件隔离运行文档"
```

---

### Task 10: Web and Electron live acceptance, full verification, and PR

**Files:**
- No planned source changes. Any directly caused regression returns to the task that owns the affected file, receives a failing regression test there, and is committed with that task before this verification task continues.

**Interfaces:**
- No new interfaces; this task verifies the complete design contract.

- [ ] **Step 1: Run full automated verification**

Run: `npm run check`

Expected: Framework, Client, desktop scripts, workflows, all Kits, and framework plugin checks exit 0.

- [ ] **Step 2: Run Web live fault acceptance**

Start `npm run dev:web`, open one healthy Kit and Agent Guard, record Framework/plugin pids, terminate only Agent Guard child, and verify health/other Kit requests remain available while Agent Guard bootstrap moves restarting -> running with a new pid. Stop the dev process cleanly.

- [ ] **Step 3: Run Electron live fault acceptance**

Start `npm start`. Verify three official startup plugins have distinct child pids. Terminate Scheduler child and confirm Electron, tray, BrowserWindows, Framework port, Notifications and Agent Guard remain alive; Scheduler restarts with a new pid without window reload. Quit Electron normally and assert no plugin runner process remains.

- [ ] **Step 4: Review completion against the design**

Check every item under the design document's “交付边界” and “测试与验收”. Treat missing runtime evidence as incomplete; do not infer Electron behavior from Node tests.

- [ ] **Step 5: Request read-only code review**

Review `BASE_COMMIT..HEAD` for protocol validation, owner cleanup ordering, restart races, token leakage, orphan processes, Agent Guard recovery, test realism, and packaging. Fix every Critical/Important issue with a new failing test and focused commit.

- [ ] **Step 6: Finish the change**

Create a body file outside the repository containing `## Summary` and `## Testing`, then run:

```bash
.agents/skills/change-workflow/scripts/finish-change.sh "隔离并自动恢复后台插件进程" /absolute/path/to/body.md
```

Expected: clean worktree, branch pushed, and verified `PR_URL=` targeting `main`.
