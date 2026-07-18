# Architecture Hardening 02: Plugin and Kit Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent plugin runtime cross-talk and make plugin/Kit state changes recoverable after failures.

**Architecture:** Serialize only module-top-level plugin definition capture with a process-wide async mutex, then run normal lifecycle work outside the critical section. Model Kit replacement as prepare/replace/commit with explicit rollback and an unusable Editor state when rollback itself fails.

**Tech Stack:** TypeScript, Node.js ESM dynamic import, Vitest, temporary plugin/Kit fixtures

## Global Constraints

- Preserve the existing module-top-level `editor.plugin.define()` plugin entry format.
- Server plugins remain trusted project code in this phase.
- The load mutex covers all `PluginModule` instances in the Node.js process.
- `globalThis.editor` must always be restored in `finally`.
- A failed Kit switch must expose either the previous working Kit or an explicitly unusable Editor, never partial new state.

---

## File Structure

- `packages/server/src/framework/plugin/load-lock.ts`: focused process-wide async mutex.
- `packages/server/src/framework/plugin/index.ts`: plugin definition capture and lifecycle state transitions.
- `packages/server/src/framework/plugin/plugin.ts`: explicit loading/unloading/failed status representation.
- `packages/server/src/editor/index.ts`: transactional Kit prepare, replace, commit and rollback.
- `packages/server/src/editor/types.ts`: public Editor availability and error contract.
- `packages/server/tests/framework/plugin-runtime.test.ts`: concurrent capture and failure cleanup.
- `packages/server/tests/integration/kit-switch.test.ts`: successful commit, rollback and rollback-failure behavior.

### Task 1: Add a process-wide plugin definition lock

**Files:**
- Create: `packages/server/src/framework/plugin/load-lock.ts`
- Modify: `packages/server/src/framework/plugin/index.ts`
- Test: `packages/server/tests/framework/plugin-runtime.test.ts`

**Interfaces:**
- Produces: `withPluginDefinitionLock<T>(work: () => Promise<T>): Promise<T>`.
- Consumes: no application state; the lock is shared by module scope.

- [ ] **Step 1: Write the concurrent loading regression test**

Add a test that creates two PluginModule instances and two temporary ESM entries whose definitions are delayed by different top-level awaits:

```ts
it('isolates runtime definition capture across PluginModule instances', async () => {
  const first = await createRuntimePluginFixture('first-plugin', 25);
  const second = await createRuntimePluginFixture('second-plugin', 0);
  const firstHost = createRuntimeHost('first-session');
  const secondHost = createRuntimeHost('second-session');
  const firstModule = new PluginModule();
  const secondModule = new PluginModule();

  await firstModule.register(first.path);
  await secondModule.register(second.path);
  await Promise.all([
    firstModule.load(first.path, firstHost),
    secondModule.load(second.path, secondHost),
  ]);

  expect(firstModule.getInfo('first-plugin')?.instance?.definition.name).toBe('first-plugin');
  expect(secondModule.getInfo('second-plugin')?.instance?.definition.name).toBe('second-plugin');
  expect((globalThis as { editor?: unknown }).editor).toBeUndefined();
});
```

The fixture entry must call `editor.plugin.define({ name: '<fixture name>' })` after its top-level delay.

- [ ] **Step 2: Run the test and verify the race**

```bash
npm run test -w packages/server -- --run tests/framework/plugin-runtime.test.ts
```

Expected: the new test FAILS by capturing the wrong definition, missing a definition, or observing leaked global state.

- [ ] **Step 3: Implement the mutex**

Create:

```ts
let tail: Promise<void> = Promise.resolve();

export async function withPluginDefinitionLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}
```

Wrap only previous-global capture, runtime assignment, dynamic import and restoration in `withPluginDefinitionLock`. Keep lifecycle `load` and `attach` after the locked callback returns.

- [ ] **Step 4: Run plugin runtime tests**

```bash
npm run test -w packages/server -- --run tests/framework/plugin-runtime.test.ts tests/framework/plugin.test.ts
```

Expected: PASS, including the new concurrent test.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/framework/plugin/load-lock.ts packages/server/src/framework/plugin/index.ts packages/server/tests/framework/plugin-runtime.test.ts
git commit -m "fix: isolate concurrent plugin definition loading"
```

### Task 2: Make plugin load failure cleanup deterministic

**Files:**
- Modify: `packages/server/src/framework/plugin/plugin.ts`
- Modify: `packages/server/src/framework/plugin/index.ts`
- Test: `packages/server/tests/framework/plugin-runtime.test.ts`

**Interfaces:**
- Produces: state transitions `registered -> loading -> running -> unloading -> registered`, with failure returning to registered.
- Consumes: existing owner cleanup hooks in the runtime host.

- [ ] **Step 1: Add failure-state tests**

```ts
it('returns a plugin to a reloadable registered state after lifecycle load fails', async () => {
  const fixture = await createFailingRuntimePluginFixture('reloadable-plugin');
  const module = new PluginModule();
  const host = createRuntimeHost('failure-session');
  await module.register(fixture.path);

  await expect(module.load(fixture.path, host)).rejects.toThrow('load failed');
  expect(module.listLoaded()).not.toContain('reloadable-plugin');
  expect(module.getInfo('reloadable-plugin')?.status).toBe(PluginStatus.Idle);

  fixture.allowLoad();
  await expect(module.load(fixture.path, host)).resolves.toBeUndefined();
});
```

Also assert that a failed load removes the plugin's Panel, Message and Menu owner contributions.

- [ ] **Step 2: Run the focused test**

```bash
npm run test -w packages/server -- --run tests/framework/plugin-runtime.test.ts
```

Expected: FAIL if the failed instance or owner contribution remains.

- [ ] **Step 3: Implement explicit transitions and cleanup**

Set status before each phase and centralize failure reset:

```ts
private resetFailedPlugin(plugin: Plugin): void {
  this.nameMap.delete(plugin.name);
  plugin.instance = null;
  plugin.status = PluginStatus.Idle;
}
```

Call runtime owner cleanup in a `finally` path before `resetFailedPlugin`. Preserve the original load error; if cleanup fails, throw `new AggregateError([loadError, cleanupError], 'Plugin load and cleanup failed')`.

- [ ] **Step 4: Run plugin suites**

```bash
npm run test -w packages/server -- --run tests/framework/plugin-runtime.test.ts tests/framework/plugin.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/framework/plugin/plugin.ts packages/server/src/framework/plugin/index.ts packages/server/tests/framework/plugin-runtime.test.ts
git commit -m "fix: reset plugin state after load failures"
```

### Task 3: Make Kit switching transactional

**Files:**
- Modify: `packages/server/src/editor/index.ts`
- Modify: `packages/server/src/editor/types.ts`
- Test: `packages/server/tests/integration/kit-switch.test.ts`

**Interfaces:**
- Produces: `Editor.isUsable(): boolean` and transactional `kit.switchKit(name): Promise<void>`.
- Consumes: PluginModule load/unload cleanup guarantees from Tasks 1 and 2.

- [ ] **Step 1: Add rollback assertions**

Extend the existing failing Kit fixture test:

```ts
const previousKit = editor.kit.getCurrent();
const previousSnapshot = editor.window.getSnapshot();

await expect(editor.kit.switchKit(failingKit.path)).rejects.toThrow('bad plugin load');

expect(editor.kit.getCurrent()).toEqual(previousKit);
expect(editor.window.getSnapshot()).toEqual(previousSnapshot);
expect(editor.plugin.listLoaded()).toEqual(expect.arrayContaining(['@ce/log']));
expect(editor.isUsable()).toBe(true);
```

Add a fixture where both new load and old-plugin restore fail, then assert `isUsable()` is false and subsequent Kit/plugin operations reject with `Editor is unavailable`.

- [ ] **Step 2: Run the Kit switch suite**

```bash
npm run test -w packages/server -- --run tests/integration/kit-switch.test.ts
```

Expected: the snapshot and unusable-state assertions FAIL.

- [ ] **Step 3: Separate preparation from mutation**

Introduce internal prepared data:

```ts
interface PreparedKit {
  descriptor: KitDescriptor;
  kitPath: string;
  plugins: ActiveExternalPlugin[];
}
```

Resolve descriptor, layout files and every plugin path into `PreparedKit` before unloading the current plugins.

- [ ] **Step 4: Implement replace/commit/rollback**

Keep `previousExternalPlugins`, `previousKit`, and `previousWindowManager` unchanged until all new plugins load. Commit with one assignment block:

```ts
activeExternalPlugins = loadedPlugins;
kit.register(prepared.descriptor);
kit.switchKit(prepared.descriptor.name);
windowManager = nextWindowManager;
```

On failure, clean new plugins and restore old plugins. If restoration fails, set `usable = false` and throw:

```ts
throw new AggregateError([switchError, restoreError], 'Kit switch and rollback failed');
```

All public mutating methods call `assertUsable()` first.

- [ ] **Step 5: Run Editor and Kit tests**

```bash
npm run test -w packages/server -- --run tests/integration/kit-switch.test.ts tests/framework/editor.test.ts tests/framework/kit.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/editor/index.ts packages/server/src/editor/types.ts packages/server/tests/integration/kit-switch.test.ts
git commit -m "fix: make kit switching transactional"
```
