# Task 5 Report: Application Runtime Process Integration

## Status

- Implemented on `feature/plugin-process-isolation` from base `3a412bcc4715bf7b9ecc71d29c4e5a250d29f8ff`.
- Commit: `[Feature] 将后台插件接入隔离进程` (this Task 5 commit).

## RED evidence

1. Added the missing Supervisor handler invocation contract first. The focused Supervisor command failed typecheck because `ApplicationPluginSupervisor.invokeHandler()` did not exist; the minimal handler-target RPC implementation then passed 51/51 tests.
2. Added Service Registry clone-boundary tests first. Typecheck failed because `snapshot()` did not exist; the implementation now rejects non-cloneable registrations before mutation and returns structured-cloned snapshots.
3. Rewrote Application Runtime coverage around injected fake supervisors. The required focused command failed because `processRuntime`, `createPluginSupervisor`, and `retryPlugin()` did not exist and the old Runtime still imported Application plugins in-process.
4. Added lifecycle compatibility coverage before preserving cross-plugin Supervisor `attach`/`detach`; it failed because no lifecycle attachments were projected.
5. Added the custom-factory transport boundary before allowing injected supervisors without production process options; it failed with `APPLICATION_PLUGIN_PROCESS_NOT_CONFIGURED` until the production-default gate was separated from custom injection.
6. Added hung snapshot and detach regressions before making those cross-process notifications non-blocking. Both failed because an unresponsive child could block a host command or mandatory owner cleanup.
7. Added a forged host-callback owner regression before forcing the captured `spec.name`; it failed because the callback-supplied plugin name was still trusted.
8. Independent review identified four concurrency/dispatch gaps. Regressions failed first because slow snapshot delivery queued all 301 states, a fast retry could reattach before an old detach completed, multi-method broadcasts called the same child handler twice, and a throwing bootstrap listener interrupted mandatory cleanup.
9. Added a startup-boundary race before the final lifecycle reconciliation pass. It failed when a plugin returned to `running` after the last per-plugin attach pass but before startup became complete.
10. Added a Supervisor-failure timing regression before guarding cleanup snapshot delivery. It failed because `APPLICATION_PLUGIN_UNAVAILABLE` from the dying generation was treated as a healthy-generation snapshot fault and explicitly stopped the Supervisor, taking over its automatic restart.
11. Final production-path review found that neither the Web entry nor the desktop Framework default supplied process runtime options. Entry regressions failed before Web source/dist resolution was anchored to the spawn module and desktop default configuration targeted the packaged runtime runner contract.
12. The final public-schema consumer audit moved the installed-Kit validation fixture to `errorCode` first; it failed with `failed: undefined` until the runtime client stopped reading the removed raw `error` field.

## Implementation decisions

- Application startup plugins use `PluginModule.register()`/`getInfo()` only for manifest, entry, and static contribution validation. Runtime never calls Application `PluginModule.load()`, `unload()`, or `callPlugin()`; a Session regression proves Session `PluginModule` import/call behavior remains in-process.
- Every prepared Application plugin owns one injected or production `ApplicationPluginSupervisor`. Initial starts are sequential, one failure leaves startup degraded while later plugins continue, disposal stops created supervisors in reverse order, and `retryPlugin()` re-enters the same supervisor lifecycle.
- Production uses `createApplicationPluginSupervisor` and requires `processRuntime`; missing production configuration becomes stable `APPLICATION_PLUGIN_PROCESS_NOT_CONFIGURED` state. A custom factory may own its transport setup without production process options.
- The Web entry now resolves `runner.ts` plus `tsx` in source mode and emitted `runner.js` in built mode from the spawn module's own URL. The desktop Framework supplies an Electron run-as-node default targeting Task 9's staged `packages/server/dist/application/plugin-process/runner.js` contract; explicit host injection still takes precedence.
- Initialize payloads contain only the absolute validated entry, isolated plugin paths, host mode, plugin/menu/service snapshots, and a notification capability boolean. The owner token never crosses IPC. Notification commands construct an owner-bound host capability.
- The full `RuntimeCommand` union is projected. Child-provided owners and callback plugin names are ignored in favor of the captured spec owner. Manual request/broadcast handler IDs call `invokeHandler()` on their owning supervisor; static methods and plugin calls use `invoke()` on the appropriate supervisor.
- Static Session-only contributions and panel methods are rejected before spawn. Host menu/message contributions are installed only after the Supervisor reports `running`; cross-plugin lifecycle attach/detach also occurs only between running supervisors.
- Supervisor cleanup removes menu, request/broadcast routes, services, static method routes, and lifecycle attachment bookkeeping. Per-pair detach completion is sequenced before a replacement attach without allowing a hung child to block mandatory owner cleanup.
- Runtime snapshot delivery keeps at most one request in flight and one latest replacement per Supervisor, so a slow child converges without exhausting the 256-request RPC bound. Cleanup never targets its own failing owner, `APPLICATION_PLUGIN_UNAVAILABLE` is left to the Supervisor lifecycle, and other snapshot delivery failures are fail-closed behind a per-plugin latch.
- Static multi-method broadcasts register one route per method, while runtime-registered callbacks execute once per broadcast. Fire-and-forget handler rejection and bootstrap-listener failures are isolated from Framework and lifecycle control flow.
- Bootstrap mirrors the seven-state Supervisor union and exposes only stable process fields (`generation`, `pid`, `restartCount`, `lastFailureAt`, `errorCode`, `retryAfterMs`). Process messages, entry diagnostics, stderr, stack, environment, tokens, and notification inputs are not copied into bootstrap errors. Existing spec `path` remains for the established bootstrap contract.
- The installed-Kit runtime client consumes `errorCode`, so degraded activation messages retain a stable failure reason without reintroducing raw process diagnostics.

## Verification

- Required focused Runtime suites: `npm run test -w packages/server -- --run tests/application/runtime.test.ts tests/application/application-process-runtime.test.ts` — 21/21 passed with server typecheck.
- Runtime, process-integration, Supervisor, and Service Registry combined verification: 76/76 passed with server typecheck.
- Task 1–4 plus production bootstrap regression: host environment 2/2, notification capability 8/8, protocol 30/30, spawn 22/22, supervisor 51/51, process lifecycle 4/4, runner 51/51; 168/168 passed with server typecheck.
- Desktop Framework 11/11 and application runtime client 7/7 passed; the built resolver was also executed and selected `dist/application/plugin-process/runner.js`.
- Build: `npm run build -w packages/server` — passed.
- Diff hygiene: `git diff --check` — passed.

## Full server suite evidence

`npm run test -w packages/server` was attempted. Typecheck passed, and 40/56 test files passed. The remaining failures are pre-existing workspace/runtime blockers unrelated to Task 5:

1. Native SQLite ABI mismatch: `better_sqlite3.node` was built with `NODE_MODULE_VERSION 148`, while the current Node runtime requires `127`. This caused the credential/session/server tests to fail before exercising Task 5 behavior.
2. Missing built artifacts for repository builtins: Session/editor integration tests report `Plugin "@itharbors/panel" package.json main file does not exist` (and the same missing dist condition for `@itharbors/menu`).

No Task 5 focused or Task 1–4 regression failed in that run.

## Concerns

- Full-suite acceptance remains blocked until the native dependency is rebuilt for the active Node ABI and builtin plugin dist entries are generated.
- Task 6 retry routing is intentionally not implemented here; Task 5 exposes only the Runtime method.

## Independent review

- The first review found lifecycle detach/reattach ordering, snapshot backpressure, broadcast multiplicity/rejection handling, bootstrap-listener isolation, startup reconciliation, and notification branch coverage gaps. Each finding received a focused regression and implementation fix.
- A second pass found the dying-generation snapshot race that could cancel automatic restart; the `APPLICATION_PLUGIN_UNAVAILABLE` regression now preserves Supervisor-owned restart behavior.
- The stable-diff pass found missing production caller configuration. Web and Electron defaults now reach the source/built and staged runner contracts respectively without weakening direct-runtime missing-config degradation.
- The public-schema consumer pass found and fixed the remaining `error` to `errorCode` migration mismatch.
- Final stable-diff re-review: ready, with zero Critical, Important, or Minor findings.

## Fix round 1

### RED evidence

1. Desktop Framework coverage first asserted that the parsed notification port reaches `createServer`; the test received `undefined` until `notificationPort` was added to the server options. The owner authentication token remains host-only and is still represented in plugin initialization by a capability boolean.
2. Two cross-plugin lifecycle races failed first: an existing observer that became unavailable during reverse attach stopped the newly started subject, and a non-unavailable observer implementation error was also charged to that subject. Observer failures are now attributed to the observer's captured generation; an unavailable/replaced observer is left for its own restart reconciliation.
3. A deferred reverse attach followed by owner cleanup and another generation restart failed first with `detach, attach` completing before the old attach was released. Each ordered plugin pair now has one transition chain, producing `old attach, detach, replacement attach` while mandatory owner cleanup remains non-blocking.
4. Supervisor tests first failed typecheck because `start()` returned no definition and `getDefinition()` did not exist. Exact-shape initialize results are now cloned, validated, and frozen before the Supervisor publishes `running`. A Runtime fake then reproduced a manifest declaring `run` while the child definition omitted it; startup incorrectly returned `ready` until static contribution attachment gained method validation and generation rollback.
5. Terminal-lifecycle tests first reproduced all three resurrection paths: dispose before start allowed a later ready startup, start after stopped returned the cached ready bootstrap, and dispose during a gated startup left the public phase at `starting`. Runtime now synchronously latches terminal intent, makes the concurrent startup observe `stopping`, drains all created supervisors, and rejects later start/retry calls with stable `APPLICATION_RUNTIME_UNAVAILABLE`.
6. Follow-up transition audit reproduced a replacement attach that was queued behind detach but not yet visible to a second owner cleanup. It completed after cleanup and left a stale active attachment. Attach intent is now generation-reserved before entering the ordered-pair chain, so cleanup can cancel or append detachment even before the RPC begins.
7. Independent review reproduced a direct-leg unavailable error cancelling the observer's Supervisor-owned automatic restart, and a reverse attach's ordinary late error failing its observer after the subject had already changed generation. Both directions now classify results against the captured observer and attached generations; unavailable or stale results never trigger explicit failure.
8. A retry gated inside `supervisor.retry()` first resolved a `stopping` bootstrap when disposal won. Retry now rechecks terminal intent after rejection, successful retry, definition validation, lifecycle reconciliation, and before returning.
9. A bootstrap listener disposing synchronously from the first `starting` event reproduced an orphan: `disposeInternal()` observed no assigned `startPromise`, completed empty cleanup, and the original startup later created a Supervisor. `start()` now publishes its Promise before executing `startInternal`, and every startup boundary stops creating work once terminal intent is latched.
10. A never-settling lifecycle attach first kept its ordered plugin pair locked after 30 seconds of simulated time. Lifecycle attach is now bounded at 30 seconds; timeout is attributed to and stops the observer generation, which closes the RPC/process before a replacement generation can attach.
11. Second-pass review showed that a timeout race alone was insufficient: if the subject changed generation, the stale result classifier ignored the timeout, and even a current-pair timeout unlocked the transition before observer stop completed. New tests first left the observer running or exposed replacement work after 30 seconds. Timeout handling now stops the original observer generation inside the same transition before its tail can release, regardless of attached-generation drift.
12. A never-settling detach first kept replacement attach queued indefinitely. Detach now uses the same 30-second bound and in-transition observer stop, preserving mandatory cleanup's non-blocking API while ensuring later generations cannot inherit a live stale RPC.
13. Concurrent and reentrant startup tests were tightened to require the in-flight `start()` itself to reject with `APPLICATION_RUNTIME_UNAVAILABLE` when disposal wins. `dispose()` treats that self-induced terminal rejection as expected, completes cleanup, and still propagates unrelated startup/cleanup failures.

### Implementation decisions

- Desktop startup forwards only the notification port required to construct the host capability. The notification owner proof/token is not included in child initialization payloads.
- Direct `subject.attach(other)` remains the subject generation's responsibility. Reverse `observer.attach(subject)` captures the observer generation: unavailable or replaced observers do not fail the subject, while other same-generation errors fail and clean up the observer only.
- Lifecycle bookkeeping stores both observer and attached generations. Attach, detach, and replacement attach share a non-rejecting per-pair tail; the externally awaited transition still preserves the original error for correct owner attribution.
- The runner's initialize result is exposed as immutable `{ lifecycle, methods }` metadata. Supervisor accepts only the exact canonical shape with a strictly sorted, unique, non-empty method list. Runtime requires every manifest request/broadcast target method before registering menu/message contributions.
- `dispose()` records terminal intent and publishes `stopping` synchronously. It then waits for any in-progress startup, stops all supervisors created by it in reverse order, and publishes `stopped`; cached startup state can no longer bypass the terminal latch.
- Startup Promise publication is reentrancy-safe: `startInternal()` begins from a queued microtask only after `startPromise` is assigned, then checks the terminal latch after every user-observable or asynchronous preparation/start boundary.
- Both lifecycle directions classify attach results against the exact observer/attached generation pair. Attach intent is reserved before queue entry, pair transitions are serialized, and a 30-second attach bound fails/stops the responsible observer instead of leaving cleanup and replacement generations permanently blocked.
- Attach and detach timeouts terminate the still-owning observer generation from inside the ordered-pair transition. The transition tail is released only after Supervisor stop has closed the old RPC/process, so an attached-generation change cannot turn a timeout into a stale late mutation.

### Verification

- Focused Supervisor and Application process integration: 77/77 passed with server typecheck.
- Task 1–5 application/process regression set: 209/209 passed across 10 test files with server typecheck.
- Desktop Framework and Application runtime client: 18/18 passed.
- Server build: `npm run build -w packages/server` passed.
- Diff hygiene: `git diff --check` passed.
- Full server suite was attempted again: typecheck passed; 40/56 files passed, with 473 tests passed, 130 failed, and 34 skipped. The 18-test increase over the pre-fix run is entirely the new fix-round coverage. All failures remain attributable to the same two workspace blockers: native SQLite ABI 148 versus active Node ABI 127, or missing builtin panel/menu dist entries.

### Independent review

- The first fix-round review reproduced five Important issues around notification wiring, attach attribution/ordering, definition validation, and terminal disposal; each received a focused RED regression and fix.
- The second pass found the assignment-before-callback orphan, both-side generation attribution gaps, retry/dispose reentrancy, and unbounded lifecycle transitions. These were reproduced before Promise publication, terminal checkpoints, pair-generation checks, and bounded operations were added.
- The timeout re-review required observer termination to occur inside the ordered-pair transition and extended the same guarantee to detach. Stale-subject attach timeout and hung-detach regressions now prove the old observer generation is stopped before the pair tail releases.
- Final review: ready, with zero Critical, Important, or Minor findings.

## Fix round 2

### RED evidence

1. An unguarded bootstrap listener that called `dispose()` again for every `stopping` event recursively re-entered before `disposePromise` was assigned. The focused regression observed 2,035 stopping events instead of one and spawned duplicate cleanup tasks.
2. Three stopping listeners plus concurrent callers received different promises and recursively produced 6,102 listener callbacks instead of three.
3. When Supervisor cleanup rejected, reentrant callers did not share the outer rejection and Vitest reported 3,308 unhandled rejections from duplicate internal disposal tasks.
4. The first deferred implementation removed the reentrancy window but added one scheduling hop. An existing lifecycle timing regression failed until cleanup execution began directly after publication of the shared promise and stopping event.

### Implementation decisions

- `dispose()` remains an ordinary method so callers receive the exact stored Promise object rather than an async-wrapper Promise.
- The first caller creates and stores one deferred Promise before terminal intent, phase mutation, event emission, or observer callbacks. Every simultaneous or reentrant call returns that same object immediately.
- Mandatory cleanup starts only after promise publication and is invoked once. Its fulfillment or rejection settles the shared deferred, with both branches attached to the internal task so it cannot produce a separate unhandled rejection.
- Synchronous cleanup-executor exceptions are caught and routed through the same deferred rejection. Existing synchronous `stopping` publication and dispose-before-start/start-during-dispose semantics are preserved.

### Verification

- Focused Supervisor and Application process integration: 81/81 passed with server typecheck.
- Task 1–5 application/process regression set: 213/213 passed across 10 test files with server typecheck.
- Desktop Framework and Application runtime client: 18/18 passed.
- Server build: `npm run build -w packages/server` passed.
- Diff hygiene: `git diff --check` passed.

### Independent review

- Final read-only review confirmed promise publication precedes all terminal state changes and callbacks, every caller receives the exact shared Promise, and cleanup is invoked once with synchronous and asynchronous failures routed to the deferred.
- Ready, with zero Critical, Important, or Minor findings.
