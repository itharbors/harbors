# Build Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a correct local content-fingerprint cache to root workspace and plugin builds so unchanged runtime builds complete in less than two seconds.

**Architecture:** A generic cache engine hashes task inputs and dependency results, validates the exact current output manifest, and records only successful builds. A repository-specific task graph maps the existing workspace and per-plugin build commands onto that engine; the root npm scripts select all, runtime, or plugin-only graphs.

**Tech Stack:** Node.js ESM, npm workspaces, SHA-256, Node test runner, TypeScript, Vite, existing plugin compiler

## Global Constraints

- Do not add a third-party build-system dependency.
- Keep build tasks sequential; cold-build parallelization is outside this change.
- Cache records are local metadata under `.cache/harbors-build/v1` and never restore absent outputs.
- A hit requires an equal input digest and an exact output path, size, and SHA-256 manifest.
- Input digests include task command, Node runtime identity, upstream result digests, and sorted input file paths and bytes.
- Build failures never create or replace a successful cache record.
- `--force` bypasses reads and refreshes successful records.
- `npm run clean` removes both generated outputs and `.cache/harbors-build`.
- Preserve existing output paths, plugin discovery, command failure status, `prestart`, `start`, `electron`, and `dev` behavior.
- Use `[Optimize]` with a concise Chinese summary for implementation commits.

---

### Task 1: Content-fingerprint cache engine

**Files:**
- Create: `scripts/lib/build-cache.mjs`
- Create: `scripts/lib/build-cache.test.mjs`

**Interfaces:**
- Consumes task objects shaped as `{ name, command: { file, args }, inputs, outputs }` plus `rootDir`, `cacheDir`, dependency result digests, and `force`.
- Produces `runCachedTask(options): Promise<{ status: 'hit' | 'built', inputDigest: string, resultDigest: string }>`.
- Produces cache records `{ schemaVersion, taskName, inputDigest, outputs, resultDigest }` written atomically after successful commands.

- [ ] **Step 1: Write failing tests for first build and identical cache hit**

Create a temporary fixture containing `src/input.txt`. Use a real Node child
command that copies its contents to `dist/output.txt` and appends to
`executions.log`. Call the desired API twice:

```js
const first = await runCachedTask({ rootDir, cacheDir, task });
const second = await runCachedTask({ rootDir, cacheDir, task });

assert.equal(first.status, 'built');
assert.equal(second.status, 'hit');
assert.equal(await readFile(join(rootDir, 'executions.log'), 'utf8'), 'run\n');
assert.match(second.resultDigest, /^[a-f0-9]{64}$/u);
```

Run:

```bash
node --test scripts/lib/build-cache.test.mjs
```

Expected: FAIL because `build-cache.mjs` does not exist.

- [ ] **Step 2: Implement deterministic file enumeration, digests, command execution, and atomic records**

Implement `runCachedTask` with these concrete rules:

```js
export async function runCachedTask({
  rootDir,
  cacheDir,
  task,
  dependencyDigests = [],
  force = false,
}) { /* hash inputs, validate record, run command, capture outputs, rename record */ }
```

Use `spawnSync(task.command.file, task.command.args, { cwd: rootDir, stdio:
'inherit' })`. Throw an error carrying the exit status when the child exits
non-zero or cannot start. Recursively enumerate regular files without following
symbolic links; reject declared paths that escape `rootDir`. Treat absent input
paths as errors and absent output paths as cache misses before execution or
errors after successful execution.

Run the focused test and expect PASS.

- [ ] **Step 3: Write failing invalidation tests**

Add separate behavior tests proving each mutation invokes the real fixture
command one additional time:

```js
await writeFile(inputPath, 'changed');        // changed input
await writeFile(addedInputPath, 'added');     // added input
await rm(addedInputPath);                     // deleted input
await rm(outputPath);                         // missing output
await writeFile(outputPath, 'corrupted');     // modified output
await writeFile(extraOutputPath, 'extra');    // extra output
```

Add a dependency test where the same files and command receive
`dependencyDigests: ['upstream-a']` and then `['upstream-b']`; the second value
must rebuild. Run the focused test and verify the new tests fail because these
mutations are not all detected.

- [ ] **Step 4: Complete exact input/output manifest invalidation**

Hash sorted repository-relative paths and bytes for inputs. Capture sorted
output entries containing `{ path, size, sha256 }` and require deep equality on
cache reads. Compute `resultDigest` from the input digest and canonical output
manifest so downstream tasks observe changed generated content.

Run the focused test and expect PASS.

- [ ] **Step 5: Write and pass failure, malformed-record, and force tests**

Add tests that:

- replace the child command with `node -e "process.exit(7)"` and assert rejection
  without a new record;
- prewrite invalid JSON and a wrong schema record and assert a normal rebuild;
- call an otherwise valid hit with `force: true` and assert one extra execution;
- mutate the production cache-hit branch mentally: returning a hit without
  output comparison, input comparison, or schema comparison must break at least
  one test.

Implement only the missing branches, then run:

```bash
node --test scripts/lib/build-cache.test.mjs
```

Expected: all cache-engine tests pass with no warnings.

- [ ] **Step 6: Commit the cache engine**

```bash
git add scripts/lib/build-cache.mjs scripts/lib/build-cache.test.mjs
git diff --cached --check
git commit -m "[Optimize] 增加内容指纹构建缓存"
```

---

### Task 2: Repository build task graph

**Files:**
- Create: `scripts/lib/build-tasks.mjs`
- Create: `scripts/lib/build-tasks.test.mjs`

**Interfaces:**
- Consumes `discoverAllPlugins`, `discoverRuntimePlugins`, and `discoverPlugin` from `scripts/lib/plugin-build/discover.mjs`.
- Produces `createBuildPlan(rootDir, graphName): { cacheDir: string, tasks: BuildTask[] }` for `all`, `runtime`, `plugins`, and `plugins-runtime`.
- Every task has a stable name, command, input paths, output paths, and dependency task names.

- [ ] **Step 1: Write failing plan-selection tests**

Against the real repository, derive expected plugin directories by calling the
existing discovery functions and compare them to task metadata:

```js
const runtime = createBuildPlan(rootDir, 'runtime');
assert.deepEqual(
  runtime.tasks.filter((task) => task.kind === 'plugin').map((task) => task.pluginDir),
  discoverRuntimePlugins(rootDir).map((value) => relative(rootDir, value)),
);
assert.deepEqual(runtime.tasks.slice(0, 5).map(({ name }) => name), [
  'workspace:plugin-types',
  'workspace:kit-core',
  'workspace:kit-cli',
  'workspace:client',
  'workspace:server',
]);
```

Assert the `all` graph includes all nine workspace builds in the current root
script, every plugin returned by `discoverAllPlugins`, and a final notification
resource task. Assert plugin-only graphs omit workspace compilation but still
retain dependency ordering among selected tasks.

Run:

```bash
node --test scripts/lib/build-tasks.test.mjs
```

Expected: FAIL because `build-tasks.mjs` does not exist.

- [ ] **Step 2: Implement workspace task definitions and graph selection**

Create stable workspace tasks using the existing commands:

```js
{
  name: 'workspace:plugin-types',
  command: { file: 'npm', args: ['run', 'build', '-w', '@itharbors/plugin-types'] },
  inputs: ['package-lock.json', 'tsconfig.json', 'packages/plugin-types/package.json',
    'packages/plugin-types/tsconfig.json', 'packages/plugin-types/src'],
  outputs: ['packages/plugin-types/dist'],
  dependencies: [],
}
```

Define equivalent tasks for contracts, relationship graph, Kit core, Kit CLI,
client, and server. Client/server depend on plugin types; Kit CLI depends on Kit
core. Preserve the exact current root-script order when selecting tasks.

- [ ] **Step 3: Implement per-plugin tasks and internal dependency mapping**

For each discovered plugin, call `discoverPlugin` and declare only source and
configuration inputs, never its `dist` outputs. Include these shared compiler
inputs in every plugin task:

```js
[
  'package-lock.json',
  'tsconfig.json',
  'scripts/ce-plugin.mjs',
  'scripts/lib/plugin-build',
]
```

Derive output roots from `plugin.main.distDir` and every panel `distDir`. Derive
workspace dependencies from internal dependency names in the plugin's
`package.json`: contract packages, relationship graph, Kit core, Kit CLI, and
plugin types. Use the direct command
`node scripts/ce-plugin.mjs build <repository-relative-plugin-dir>`.

Define the notification resource task with source inputs
`.agents/skills/notify-user`, `scripts/prepare-notification-skill-resource.mjs`,
and `scripts/lib/codex-skill-resource.mjs`; its output is the copied resource
directory beneath the notification-background plugin `dist` and it depends on
that plugin task.

Run the focused task-graph tests and expect PASS.

- [ ] **Step 4: Add validation tests for unknown graphs and unsafe duplicate outputs**

Assert `createBuildPlan(rootDir, 'unknown')` throws. Add a fixture task-list
validation test proving two tasks cannot claim the same output root, because
independent records would otherwise race or invalidate each other. Implement
the validation and run the focused tests.

- [ ] **Step 5: Commit the task graph**

```bash
git add scripts/lib/build-tasks.mjs scripts/lib/build-tasks.test.mjs
git diff --cached --check
git commit -m "[Optimize] 建立增量构建任务图"
```

---

### Task 3: Build CLI and npm command integration

**Files:**
- Create: `scripts/build.mjs`
- Create: `scripts/lib/build-cli.test.mjs`
- Modify: `package.json`
- Modify: `scripts/lib/electron-launcher.test.mjs`
- Modify: `scripts/lib/codex-skill-resource.test.mjs`

**Interfaces:**
- Consumes `createBuildPlan` and `runCachedTask`.
- Provides `node scripts/build.mjs <all|runtime|plugins|plugins-runtime> [--force]`.
- Root scripts `build`, `build:runtime`, `plugins:build`, and `plugins:build:runtime` delegate to this CLI.

- [ ] **Step 1: Write failing CLI behavior tests**

Export a `runBuild({ rootDir, graphName, force, stdout })` function from the new
entry module while guarding direct CLI execution. Inject only a temporary task
plan for unit tests, and execute real Node fixture commands through the cache
engine. Assert first and second output contain:

```text
BUILD fixture:one
HIT fixture:one
```

Assert `--force` prints `BUILD` again, unknown/multiple graph arguments exit
with usage, and a child exit status of 7 is preserved by the CLI.

Run:

```bash
node --test scripts/lib/build-cli.test.mjs
```

Expected: FAIL because `scripts/build.mjs` does not exist.

- [ ] **Step 2: Implement sequential CLI execution and concise status output**

Walk selected tasks in order. Resolve dependency result digests from previously
completed tasks. Print `HIT <name>` or `BUILD <name>` after each result and
`FAIL <name>` before propagating an error. Reject a plan whose dependency has
not already completed.

Run the CLI tests and expect PASS.

- [ ] **Step 3: Write failing package-command contract tests**

Update the Electron launcher test to require:

```js
assert.equal(packageJson.scripts['build:runtime'], 'node scripts/build.mjs runtime');
assert.equal(packageJson.scripts['plugins:build:runtime'],
  'node scripts/build.mjs plugins-runtime');
assert.equal(packageJson.scripts.build, 'node scripts/build.mjs all');
assert.equal(packageJson.scripts['plugins:build'], 'node scripts/build.mjs plugins');
```

Replace the Codex skill-resource source-text assertion with a task-plan behavior
assertion proving the `plugins` graph places `resource:notify-user` after and
dependent on `plugin:kits/notifications/plugins/notification-background`.

Run both focused tests and verify they fail against the old package scripts.

- [ ] **Step 4: Switch root npm scripts to cached graphs**

Modify only the four build script values in `package.json`. Keep `prestart`,
`start`, `electron`, `dev`, packaging, and checks unchanged. Ensure the root
`test` command includes the three new test files so CI runs them.

Run:

```bash
node --test scripts/lib/build-cache.test.mjs scripts/lib/build-tasks.test.mjs \
  scripts/lib/build-cli.test.mjs scripts/lib/electron-launcher.test.mjs \
  scripts/lib/codex-skill-resource.test.mjs
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit CLI integration**

```bash
git add package.json scripts/build.mjs scripts/lib/build-cli.test.mjs \
  scripts/lib/electron-launcher.test.mjs scripts/lib/codex-skill-resource.test.mjs
git diff --cached --check
git commit -m "[Optimize] 接入缓存构建命令"
```

---

### Task 4: Clean semantics and end-to-end verification

**Files:**
- Modify: `.gitignore`
- Modify: `scripts/clean.mjs`
- Create: `scripts/lib/build-clean.test.mjs`
- Modify: `package.json`

**Interfaces:**
- `npm run clean` deletes `.cache/harbors-build` and all existing build output targets.
- Git ignores only `/.cache/harbors-build/`, not arbitrary repository cache directories.

- [ ] **Step 1: Write a failing clean behavior test**

In a temporary fixture repository, create a cache record and representative
output directory, then execute an exported `cleanBuildArtifacts(rootDir)` from
`scripts/clean.mjs`. Assert both are absent afterward. Keep the direct-script
path invoking the same function against the actual repository.

Run:

```bash
node --test scripts/lib/build-clean.test.mjs
```

Expected: FAIL because `clean.mjs` has no exported cleaner and does not include
the cache target.

- [ ] **Step 2: Refactor clean into an exported function and add the cache target**

Add `.cache/harbors-build` to the target set before traversal. Preserve all
existing plugin, coverage, Vite, Vitest, and `.tsbuildinfo` discovery behavior.
Add `/.cache/harbors-build/` to `.gitignore` and the clean test to the root test
command. Run the focused test and expect PASS.

- [ ] **Step 3: Link installed dependencies into the isolated worktree**

For verification only, create the worktree-local `node_modules` symlink using
the absolute primary-checkout dependency directory. Do not commit the link; it
is ignored by Git. Confirm `git status --short` remains unchanged except for
intended source edits.

- [ ] **Step 4: Verify forced build, cache hit, and timing**

Run:

```bash
npm run build:runtime -- --force
/usr/bin/time -p npm run build:runtime
```

Expected: the forced command prints `BUILD` for every runtime task; the second
command prints `HIT` for every task and completes in less than 2 seconds on the
same machine used for the 22-second baseline.

- [ ] **Step 5: Verify output invalidation and clean rebuild**

Delete one generated output file from a runtime plugin and rerun
`npm run build:runtime`. Expected: only that plugin prints `BUILD`; unrelated
tasks print `HIT`.

Then run:

```bash
npm run clean
npm run build:runtime
```

Expected: clean reports the cache directory and generated outputs removed; the
following command rebuilds all runtime tasks successfully.

- [ ] **Step 6: Run focused and regression checks**

```bash
node --test scripts/lib/build-cache.test.mjs scripts/lib/build-tasks.test.mjs \
  scripts/lib/build-cli.test.mjs scripts/lib/build-clean.test.mjs \
  scripts/lib/plugin-build/discover.test.mjs scripts/lib/plugin-build/scripts.test.mjs \
  scripts/lib/electron-launcher.test.mjs scripts/lib/codex-skill-resource.test.mjs
npm run plugins:check
git diff --check
git status --short
```

Expected: every test and plugin validation passes, diff check is clean, and
status contains only the intended change files.

- [ ] **Step 7: Commit clean integration**

```bash
git add .gitignore package.json scripts/clean.mjs scripts/lib/build-clean.test.mjs
git diff --cached --check
git commit -m "[Optimize] 完善构建缓存清理"
```

- [ ] **Step 8: Perform completion audit**

Compare current files and command output against every goal in
`docs/superpowers/specs/2026-07-28-build-cache-design.md`: root and plugin build
entry points cache, changed inputs and outputs invalidate, failures do not
poison records, force rebuild works, clean removes records, startup contracts
remain unchanged, and measured no-change runtime build is below two seconds.
Do not claim completion if any item lacks direct evidence.
