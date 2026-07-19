# SQLite Kit Final Review Fix Report

Date: 2026-07-19
Review source: `.superpowers/sdd/final-review-findings.md`

## Outcome

All Critical findings, seven of the eight Important findings, and every actionable Minor finding were fixed in focused commits. The remaining Important finding is the real renderer/iframe acceptance test: the repository-native Electron attempt could start its main script but could not reach Electron readiness in this execution environment, so no hanging or simulated iframe harness was committed.

## Fix commits

| Commit | Findings resolved |
| --- | --- |
| `4c7815e` `[Bug] 阻断只读 SQLite 对象的 SQL 写入` | Authoritative SQL target extraction and view/virtual/shadow write rejection; confirmed targets retained in the Panel warning |
| `5a475f1` `[Bug] 保持 SQLite 格式化内容语义` | Lossless SQL formatting for strings, quoted identifiers, and comments |
| `e35fdd0` `[Bug] 稳定识别可空主键记录` | Nullable/non-unique declared primary keys use rowid identity and stable ordering where available |
| `2422f20` `[Bug] 修复 SQLite 面板状态与窄屏交互` | Stale connection/schema responses, cell-detail clearing, immutable current path, native radio selection, focus-managed narrow drawer, undo expiry, and status duplication |
| `dd76d10` `[Bug] 修复拉取请求 CI 触发范围` | Pull-request checks no longer use repository-inaccurate path filters |

The pre-review implementation commit `3ce8e98` already contained the system-object expansion regressions and implementation. Its plan is now marked complete with commit evidence.

## TDD evidence

### SQL authorization and confirmation audit

- RED: focused tests reported 4 failures: qualified targets resolved as `main`, protected-object writes reached SQLite, revalidation reached the worker, and the warning omitted target names.
- GREEN: the same 4 tests passed; the complete SQL analysis/worker/Panel set passed 37 tests.
- Command: `npm run test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/sql-analysis.test.ts plugins/sqlite-workbench/tests/sql-worker.test.ts plugins/sqlite-workbench/tests/panel.test.ts`

### Lossless SQL formatting

- RED: protected tokens lost their original whitespace/content.
- GREEN: `plugins/sqlite-workbench/tests/sql-format.test.ts` passed 5 tests.

### Nullable primary-key identity

- RED: two rows with `NULL` declared primary keys produced duplicate primary-key identities.
- GREEN: SQLite service and mutation suites passed 41 tests.

### Panel state, connection display, responsive behavior, and undo expiry

- RED: 7 focused regressions failed for stale schema state, cell detail, current connection display, row semantics, narrow navigation focus, undo expiry, and footer duplication.
- GREEN: Panel and accessibility suites passed 36 tests; the built plugin check also passed.

### CI pull-request coverage

- RED: the workflow contract test found a `pull_request.paths` allowlist.
- GREEN: `node --test scripts/lib/ci-workflow.test.mjs` passed 4 tests.

### System-object expansion documentation

- GREEN: `npm run test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/panel.test.ts -t "system object group"` passed 2 focused regressions.

## Final verification

`npm run check` exited 0 after rebuilding all packages/plugins and running:

- Server: 268 tests passed.
- Client: 245 tests passed.
- SQLite Kit: 131 tests passed, including the two real-editor runtime integration tests.
- MySQL Kit: 41 tests passed; its environment-gated live integration test remained skipped as before.
- Repository Node tests: 6 passed, including the CI workflow contract.
- Feature workflow: 22 checks passed.
- Plugin output validation: passed for all plugins.

## Remaining acceptance limitation

The missing real Panel iframe acceptance remains unresolved. A TDD spike first proved the intended completion-matrix assertion RED, then launched Electron 31 with a real HTTP server session and actual injected Panel URL. Electron logged that it had entered the runner, but `app.whenReady()` did not resolve within 60 seconds, so no `BrowserWindow` or child frame could be created. Repeating with `--headless`, `--disable-gpu`, disabled hardware acceleration, and a hidden window produced the same signature. The spike was removed to avoid committing a hanging or fake test.

The closest repository-native automated coverage remains:

- `kits/sqlite/tests/runtime-integration.test.ts`: real editor, built plugin resolver, temporary databases, CRUD/policy/schema/filter/export/undo wiring.
- `kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts` and `accessibility.test.ts`: actual Panel DOM behavior under jsdom, including dialogs, focus, response races, selection, and responsive navigation.
- `kits/sqlite/plugins/sqlite-workbench/tests/sql-worker.test.ts`: real worker cancellation and recovery.

Linux CI execution also requires a remote workflow run; this local macOS task did not have authority to push or create a pull request. The corrected workflow now schedules `npm run check` for every pull request change.

## Re-review fixes

Date: 2026-07-19

The two remaining merge-blocking findings and the related table-semantics Minor finding are resolved. The explicitly environment-gated real iframe follow-up remains unchanged; no fake or hanging harness was added.

### Commits and files

| Commit | Files | Resolution |
| --- | --- | --- |
| `bb49768` `[Bug] 修复 SQLite 降序整数主键标识` | `main/src/sqlite-service.ts`, `tests/sqlite-service.test.ts` | Uses SQLite's `origin='pk'` autoindex metadata to distinguish the legacy nullable `INTEGER PRIMARY KEY DESC` form from a real rowid alias; duplicate `NULL` keys receive distinct rowid identities and mutate one row only. |
| `d7e0e11` `[Bug] 修复 SQLite 窄屏导航焦点泄漏` | Panel `index.ts`, `index.css`, `panel.test.ts`, `accessibility.test.ts` | Closed narrow navigation is `inert`, accessibility-hidden, visibility-hidden, and pointer-disabled; the obscured workspace becomes inert while open; focus still moves into the drawer and returns on Escape; `<tbody>` retains native semantics. |

### RED evidence

Identity command:

```bash
npm run test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/sqlite-service.test.ts -t "INTEGER PRIMARY KEY DESC"
```

Result: 1 focused failure. Both duplicate `NULL` rows returned `{ kind: 'primary-key', values: { id: null } }` instead of distinct rowid identities `1` and `2`.

Accessibility command:

```bash
npm run test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/panel.test.ts plugins/sqlite-workbench/tests/accessibility.test.ts -t "narrow navigation|native table body|closed narrow drawer"
```

Result: 3 focused failures. The narrow CSS lacked hidden/noninteractive rules, the closed drawer lacked `inert`, and the data `<tbody>` still exposed `role="radiogroup"`.

### GREEN evidence

```bash
npm run test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/sqlite-service.test.ts -t "INTEGER PRIMARY KEY DESC"
npm run test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/sqlite-service.test.ts
```

Result: the focused regression passed 1/1; the complete service file passed 35/35.

```bash
npm run test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/panel.test.ts plugins/sqlite-workbench/tests/accessibility.test.ts -t "narrow navigation|native table body|closed narrow drawer"
npm run test -w @itharbors/kit-sqlite -- --run plugins/sqlite-workbench/tests/panel.test.ts plugins/sqlite-workbench/tests/accessibility.test.ts
node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-workbench
node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-workbench
```

Result: 3/3 focused regressions passed, then the complete Panel/accessibility set passed 38/38; plugin build and output validation exited 0.

### Final verification

`npm run check` exited 0 after the re-review commits:

- Server: 268 tests passed.
- Client: 245 tests passed.
- SQLite Kit: 134 tests passed.
- MySQL Kit: 41 tests passed; its pre-existing environment-gated live integration test remained skipped.
- Repository Node tests: 6 passed.
- Feature workflow: 22 checks passed.
- All package/plugin builds and plugin output checks passed.

### Remaining concerns

- Real Panel iframe acceptance remains an Electron-capable environment follow-up for the readiness limitation documented above; this re-review explicitly accepts that disposition.
- The narrow-layout regression honestly combines browser `matchMedia` contract simulation for DOM state/focus with static breakpoint-rule verification. jsdom does not evaluate media queries or implement native inert tab traversal, so final viewport/tab-order confirmation still belongs in the future real-renderer acceptance run.
- A remote Ubuntu Actions run remains pending until the branch is pushed or a pull request is created.
