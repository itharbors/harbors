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
