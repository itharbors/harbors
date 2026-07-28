# Build Cache Design

## Context

`npm start` invokes `npm run build:runtime` through the npm `prestart`
lifecycle. A no-change runtime build currently takes about 22 seconds on the
development machine, and a second identical build takes the same time. About
17 seconds are spent rebuilding runtime plugins: each plugin deletes its
output directory and starts one or more TypeScript processes even when none of
its inputs changed.

The previous startup-preparation change deliberately reused the complete build
and excluded incremental caching from that change's scope. This design changes
that constraint: builds remain correctness-first, but completed tasks may be
reused when their inputs and outputs are proven identical.

## Goals

- Make `npm run build`, `npm run build:runtime`, and the corresponding plugin
  builds reuse unchanged local outputs.
- Reduce a no-change `npm run build:runtime` from roughly 22 seconds to less
  than 2 seconds on the same development machine.
- Rebuild only the tasks affected by changed, added, or removed inputs.
- Never report a cache hit when required output is missing, changed, or stale.
- Preserve the existing build order, failure propagation, generated output,
  plugin discovery rules, and startup behavior.
- Provide an explicit full-rebuild escape hatch and make `clean` remove cache
  state.

## Non-goals

- Remote or shared CI caching.
- Restoring deleted build outputs from an artifact store. A cache hit reuses
  outputs already present in the worktree; missing outputs cause a rebuild.
- Replacing npm workspaces, TypeScript, Vite, or the plugin compiler.
- Parallelizing cold builds. Task scheduling stays sequential so caching can be
  introduced independently from resource-concurrency changes.
- Changing package-level Kit build commands that do not participate in the
  root `build` or `build:runtime` entry points.

## Selected Approach

Add a small repository-owned task runner with a content-addressed local cache.
The root build commands select a task graph, and each task declares its input
files, output roots, upstream task dependencies, and existing build command.

Before executing a task, the runner computes an input digest. A task is a cache
hit only when all of the following hold:

1. A successful record exists for the current cache schema and task name.
2. The recorded input digest equals the current input digest.
3. The current output manifest exactly matches the manifest recorded after the
   successful build.

Otherwise, the runner executes the task and writes a new record only after the
command succeeds and the declared outputs exist.

This approach is preferred over adding Turborepo because it avoids a dependency
and task-model migration for a small repository. TypeScript `incremental` alone
is insufficient because plugin builds delete their output directories and also
run Vite, esbuild, resource-copy, and validation steps.

## Components

### Cache engine

`scripts/lib/build-cache.mjs` owns generic cache behavior:

- recursively enumerate regular files under declared input and output paths;
- hash relative paths, file bytes, and task/dependency metadata with SHA-256;
- compare the current output manifest with the recorded manifest;
- execute one task and return `hit` or `built`;
- atomically replace a task record after a successful build;
- leave the previous record untouched when a build fails.

Cache records live under `.cache/harbors-build/v1/`, which is ignored by Git.
Each task has a separate JSON record so one successful task remains reusable
when a later task fails.

The input digest includes:

- cache schema version;
- task name and command arguments;
- `process.version`, `process.platform`, and `process.arch`;
- the digest of every upstream task;
- the sorted path and content of every declared input file.

Input enumeration follows explicit files and directories, ignores generated
output directories and `node_modules`, preserves dotfiles, and follows no
symbolic links. A deleted file changes the sorted manifest and therefore the
digest.

The output manifest stores every regular output file's repository-relative
path, size, and SHA-256 digest. Missing, extra, or modified output files cause a
miss. Output roots must exist after a successful command; empty output roots are
valid only when a task declares that explicitly.

### Task graph

`scripts/lib/build-tasks.mjs` translates the existing build commands into task
definitions. It uses the existing plugin discovery functions rather than
maintaining a second plugin list.

Workspace tasks are defined for:

- plugin types;
- CSV, SQLite, and MySQL contracts;
- relationship graph;
- Kit core and Kit CLI;
- client TypeScript/Vite assets;
- server TypeScript output.

Every discovered plugin is its own task. Its inputs include the plugin package,
manifest, TypeScript configuration, main sources, panel sources, and the shared
plugin build implementation. Its dependencies include the workspace artifacts
that its compiler resolves. Because plugin tasks are independent cache units,
editing one plugin does not rebuild the other plugins.

The notification skill-resource preparation remains a separate task after the
notification plugins it consumes.

The `all` graph contains every task currently reached by `npm run build`. The
`runtime` graph contains exactly the smaller task set currently reached by
`npm run build:runtime`. Plugin-only graphs support the existing
`plugins:build` and `plugins:build:runtime` commands without nesting the runner.

### Command entry point

`scripts/build.mjs` accepts one graph name:

```text
node scripts/build.mjs <all|runtime|plugins|plugins-runtime> [--force]
```

It evaluates tasks in topological order, prints a concise `HIT`, `BUILD`, or
`FAIL` line for each task, and preserves the failing command's non-zero exit
status. `--force` bypasses cache reads but still writes fresh successful
records.

Root package scripts delegate to this entry point. `npm run build -- --force`
and `npm run build:runtime -- --force` therefore provide explicit full builds.

### Clean behavior

`scripts/clean.mjs` removes `.cache/harbors-build` in addition to existing
generated outputs. The next build after `clean` must execute every selected
task because both records and outputs are absent.

## Cache Correctness

The cache is an optimization, never the source of truth:

- an absent or malformed record is a miss;
- an unknown schema version is a miss;
- an input hash mismatch is a miss;
- missing, extra, or corrupted output is a miss;
- a failed command does not update its record;
- dependency digests flow into downstream digests;
- `--force` always executes selected tasks;
- `clean` removes both records and outputs.

Cache metadata is local and disposable. Deleting it can only make the next build
slower, not change the resulting artifacts.

## Testing

Unit tests use temporary directories and real files to cover:

- first execution builds and records outputs;
- an identical second execution is a hit and does not invoke the command;
- changed, added, and deleted inputs cause a rebuild;
- missing, added, and corrupted outputs cause a rebuild;
- a changed upstream digest invalidates a dependent task;
- malformed records are treated as misses;
- failed commands do not create or replace successful records;
- `--force` executes a cache hit again.

Task-graph tests use temporary fixture plugins and assert selection and
dependencies without executing the expensive compilers. Existing plugin build
tests continue to verify actual generated artifacts and validation.

Integration verification runs:

1. a forced runtime build;
2. an unchanged runtime build and verifies all selected tasks report `HIT`;
3. a no-change timing measurement with a target below 2 seconds;
4. a controlled plugin-source change in a temporary copy and verifies only the
   affected plugin task and its downstream tasks rebuild;
5. `npm run clean` followed by a runtime build and verifies all selected tasks
   rebuild successfully;
6. the focused build-cache, plugin-build, clean, and Electron launcher tests.

## Rollout and Compatibility

No cache is migrated from earlier versions. The first build after this change
is a normal full build and creates version-1 records. Existing output paths and
consumer commands remain unchanged, so Electron and packaging continue to read
the same artifacts. A future cache format change increments the schema path and
naturally causes one full rebuild.
