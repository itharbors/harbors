# Skill Manager Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independently publishable Skill Manager Kit that manages global Codex Skills by default and optionally compares a selected source folder with the global installation.

**Architecture:** A single Session plugin owns all filesystem access through focused scanner, comparator, directory-browser, recovery-store, mutator, and service modules. Its Panel receives opaque IDs and immutable snapshot projections through the existing Harbors message protocol, so the renderer never submits raw filesystem paths or performs writes.

**Tech Stack:** TypeScript, Node.js filesystem APIs, `yaml@2.9.0`, Harbors plugin runtime, DOM APIs, Vitest, jsdom, npm workspaces, Harbors Kit CLI.

## Global Constraints

- Kit identity is `@itharbors/kit-skill-manager`; plugin identity is `@itharbors/skill-manager`.
- Initial version is `0.1.0-preview.1` and Registry runner is `ubuntu-latest`.
- Global root is `$CODEX_HOME/skills`, falling back to `~/.codex/skills`; Panel cannot override it.
- Selected source folders are Session-only and are never reopened after restart.
- Source scans never follow symlinks and skip `.git`, `node_modules`, `.worktrees`, and the recovery store.
- `.system` Skills are discoverable but read-only.
- Install/update/disable/uninstall/restore accept opaque snapshot IDs, revision, and expected digest, never a Panel-supplied path.
- Uninstall is recoverable; the first version has no permanent deletion.
- Panel renders Skill text with DOM `textContent`, never `innerHTML` from Skill content.
- Tests use temporary `CODEX_HOME` directories and never access the real user Skill directory.
- Every commit on `feature/skill-manager-kit` uses `[Feature]` with a concise Chinese summary.

---

## File Map

### Kit and repository integration

- `kits/skill-manager/kit.json`: published Kit identity, compatibility, target, and filesystem permission.
- `kits/skill-manager/package.json`: workspace, build/test scripts, layout, window entries, and plugin list.
- `kits/skill-manager/layout.json`: one simple full-window manager Panel.
- `kits/skill-manager/main.html`: main Harbors host entry.
- `kits/skill-manager/secondary.html`: required secondary host entry.
- `kits/skill-manager/vitest.config.ts`: Kit-local test discovery.
- `kits/skill-manager/README.md`: user flow, safety model, and development commands.
- `kits/skill-manager/tests/kit-manifest.test.ts`: static Kit contract and root test-gate coverage.
- `kits/skill-manager/tests/runtime-integration.test.ts`: temporary-home service acceptance flow.
- `registry/policy.json`: official Skill Manager Registry entry.
- `package.json`: root test gate includes the new workspace.
- `package-lock.json`: workspace and exact `yaml@2.9.0` production dependency.
- `readme.md`: user-facing official Kit list and repository tree.
- `docs/guides/developing-plugins-and-kits.md`: official Kit list and Skill Manager development notes.
- `docs/architecture/kit-and-session-model.md`: source/global Session behavior.

### Plugin service

- `kits/skill-manager/plugins/skill-manager/package.json`: Panel, request, and broadcast contributions.
- `main/src/types.ts`: shared server-domain types and stable error codes.
- `main/src/frontmatter.ts`: YAML frontmatter parsing and projection.
- `main/src/digest.ts`: bounded, symlink-rejecting directory digest.
- `main/src/skill-scanner.ts`: source/global/recovery discovery.
- `main/src/skill-comparator.ts`: merged status projection.
- `main/src/directory-browser.ts`: opaque Session directory navigation.
- `main/src/safe-path.ts`: directory identity and no-symlink assertions.
- `main/src/skill-store.ts`: recovery records, disabled/trash entries, and journals.
- `main/src/skill-mutator.ts`: serialized lifecycle transactions.
- `main/src/skill-service.ts`: source selection, generations, revisions, snapshots, and operations.
- `main/src/index.ts`: Harbors plugin lifecycle/message adapter only.
- `tests/frontmatter.test.ts`, `digest.test.ts`, `skill-scanner.test.ts`, `skill-comparator.test.ts`, `directory-browser.test.ts`, `skill-store.test.ts`, `skill-mutator.test.ts`, `skill-service.test.ts`, `plugin-main.test.ts`: focused Node tests.

### Panel

- `panel.manager/src/index.html`: semantic Panel root.
- `panel.manager/src/index.ts`: state machine, rendering, bindings, stale-response protection, and accessibility.
- `panel.manager/src/index.css`: responsive three-column workspace and reduced-motion behavior.
- `tests/panel.test.ts`: jsdom interaction, stale response, escaping, keyboard, and dialog tests.

---

### Task 1: Bootstrap the publishable Kit contract

**Files:**
- Create: `kits/skill-manager/package.json`
- Create: `kits/skill-manager/kit.json`
- Create: `kits/skill-manager/vitest.config.ts`
- Create: `kits/skill-manager/layout.json`
- Create: `kits/skill-manager/main.html`
- Create: `kits/skill-manager/secondary.html`
- Create: `kits/skill-manager/README.md`
- Create: `kits/skill-manager/plugins/skill-manager/package.json`
- Create: `kits/skill-manager/plugins/skill-manager/main/src/index.ts`
- Create: `kits/skill-manager/plugins/skill-manager/panel.manager/src/index.html`
- Create: `kits/skill-manager/plugins/skill-manager/panel.manager/src/index.ts`
- Create: `kits/skill-manager/plugins/skill-manager/panel.manager/src/index.css`
- Create: `kits/skill-manager/tests/kit-manifest.test.ts`
- Modify: `registry/policy.json`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces Kit `@itharbors/kit-skill-manager` with one Panel `@itharbors/skill-manager.manager`.
- Produces request names `getSnapshot`, `browseDirectory`, `selectSource`, `clearSource`, `rescan`, `getSkillDetail`, and `performAction`.
- Produces broadcasts `snapshot.changed`, `scan.progress`, and `operation.progress` mapped to Panel methods.

- [ ] **Step 1: Create the test harness and failing manifest contract**

Create the workspace `package.json`, Vitest config, and `kit-manifest.test.ts`. The central assertions must be:

```ts
expect(pkg.name).toBe('@itharbors/kit-skill-manager');
expect(manifest).toMatchObject({
  id: '@itharbors/kit-skill-manager',
  version: '0.1.0-preview.1',
  channel: 'preview',
  permissions: ['filesystem'],
});
expect(pkg['ce-editor'].kit.plugin).toEqual(['@itharbors/skill-manager']);
expect(plugin['ce-editor'].contribute.message.request).toEqual({
  getSnapshot: ['getSnapshot'],
  browseDirectory: ['browseDirectory'],
  selectSource: ['selectSource'],
  clearSource: ['clearSource'],
  rescan: ['rescan'],
  getSkillDetail: ['getSkillDetail'],
  performAction: ['performAction'],
});
```

- [ ] **Step 2: Run the manifest test and observe the missing contract**

Run: `npm run test -w @itharbors/kit-skill-manager -- --run tests/kit-manifest.test.ts`

Expected: FAIL because `kit.json`, layout, plugin manifest, or root test-gate registration is missing.

- [ ] **Step 3: Add the minimal Kit, Panel, plugin, Registry, and root-gate files**

Use this Kit shape:

```json
{
  "name": "@itharbors/kit-skill-manager",
  "version": "0.1.0-preview.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node ../../scripts/ce-plugin.mjs build plugins/skill-manager",
    "test": "vitest run --config vitest.config.ts"
  },
  "dependencies": { "yaml": "2.9.0" },
  "ce-editor": {
    "kit": {
      "menuRoot": { "id": "skill-manager", "label": "Skill Manager" },
      "layouts": { "default": "layout.json" },
      "windowEntries": { "main": "main.html", "secondary": "secondary.html" },
      "plugin": ["@itharbors/skill-manager"],
      "theme": { "--ce-accent": "#b8f36b" }
    }
  }
}
```

Both the Kit package and plugin manifest declare `yaml: "2.9.0"` so npm installs it for development and the Kit packer follows the plugin production dependency. Stub methods return a frozen empty snapshot; the stub Panel uses `textContent` to render `Skill Manager`.

- [ ] **Step 4: Update and verify the workspace lock**

Run: `npm install --ignore-scripts`

Expected: `package-lock.json` contains `kits/skill-manager`, the plugin workspace, and exact `yaml@2.9.0` resolution; the dependency is also available to the plugin build.

- [ ] **Step 5: Run the contract test and plugin build**

Run: `npm run test -w @itharbors/kit-skill-manager -- --run tests/kit-manifest.test.ts`

Expected: PASS.

Run: `npm run build -w @itharbors/kit-skill-manager`

Expected: plugin main and Panel dist files are generated successfully.

- [ ] **Step 6: Commit the bootstrap**

```bash
git add kits/skill-manager registry/policy.json package.json package-lock.json
git commit -m '[Feature] 初始化 Skill 管理 Kit'
```

### Task 2: Parse and scan Skills safely

**Files:**
- Create: `kits/skill-manager/plugins/skill-manager/main/src/types.ts`
- Create: `kits/skill-manager/plugins/skill-manager/main/src/frontmatter.ts`
- Create: `kits/skill-manager/plugins/skill-manager/main/src/digest.ts`
- Create: `kits/skill-manager/plugins/skill-manager/main/src/skill-scanner.ts`
- Create: `kits/skill-manager/plugins/skill-manager/tests/frontmatter.test.ts`
- Create: `kits/skill-manager/plugins/skill-manager/tests/digest.test.ts`
- Create: `kits/skill-manager/plugins/skill-manager/tests/skill-scanner.test.ts`

**Interfaces:**
- Produces `parseSkillFrontmatter(source: string): SkillManifest`.
- Produces `digestSkillDirectory(root: string, limits: ScanLimits, signal?: AbortSignal): Promise<SkillDigest>`.
- Produces `scanSourceRoot(root: string, options: ScanOptions): Promise<SkillScanResult>`.
- Produces `scanGlobalRoot(root: string, options: ScanOptions): Promise<SkillScanResult>`.

- [ ] **Step 1: Write failing parser, digest, and scanner tests**

Cover quoted and block YAML values, missing delimiters, duplicate/invalid names, nested source Skills, direct-child global Skills, protected `.system` Skills, ignored directories, symlinks, special files, permission errors, overlap, cancellation, and bounded size. Use this fixture helper signature:

```ts
async function createSkill(root: string, folder: string, manifest: string, files = {}) {
  const directory = path.join(root, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), manifest);
  for (const [name, value] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), String(value));
  }
  return directory;
}
```

- [ ] **Step 2: Run focused tests and verify missing exports**

Run: `npm run test -w @itharbors/kit-skill-manager -- --run plugins/skill-manager/tests/frontmatter.test.ts plugins/skill-manager/tests/digest.test.ts plugins/skill-manager/tests/skill-scanner.test.ts`

Expected: FAIL because parser, digest, and scanner modules do not exist.

- [ ] **Step 3: Define stable domain types and errors**

Define exact core types:

```ts
export type SkillManifest = { name: string; description: string };
export type SkillOrigin = 'source' | 'global' | 'system' | 'disabled' | 'trash';
export type SkillDiagnostic = { code: string; message: string; relativePath?: string };
export type SkillCandidate = {
  id: string;
  origin: SkillOrigin;
  directory: string;
  basename: string;
  manifest: SkillManifest | null;
  digest: string | null;
  protected: boolean;
  diagnostics: SkillDiagnostic[];
};
export type ScanLimits = { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
export type SkillScanResult = { candidates: SkillCandidate[]; diagnostics: SkillDiagnostic[]; truncated: boolean };
```

`SkillManagerError` contains stable codes `INVALID_SKILL`, `UNSAFE_PATH`, `SCAN_LIMIT`, `SCAN_CANCELLED`, `STALE_SNAPSHOT`, and `SKILL_CONFLICT`.

- [ ] **Step 4: Implement YAML projection, bounded digest, and the two scan modes**

Parse frontmatter with `parseDocument` from `yaml`; reject non-string `name`/`description`. Hash sorted `relativePath + NUL + bytes + NUL`. Use `lstat`, never `stat`, to reject links. Source scanning is recursive; global scanning checks direct children plus `.system` direct children. Continue after candidate-local errors and mark overlap after discovery.

- [ ] **Step 5: Run scanner tests and build**

Run the Task 2 focused test command. Expected: PASS.

Run: `npm run build -w @itharbors/kit-skill-manager`. Expected: PASS.

- [ ] **Step 6: Commit scanning**

```bash
git add kits/skill-manager/plugins/skill-manager/main/src kits/skill-manager/plugins/skill-manager/tests
git commit -m '[Feature] 实现 Skill 安全扫描'
```

### Task 3: Compare source, global, and recovery states

**Files:**
- Create: `kits/skill-manager/plugins/skill-manager/main/src/skill-comparator.ts`
- Create: `kits/skill-manager/plugins/skill-manager/tests/skill-comparator.test.ts`
- Modify: `kits/skill-manager/plugins/skill-manager/main/src/types.ts`

**Interfaces:**
- Produces `SkillStatus = 'source-only' | 'current' | 'update-available' | 'global-only' | 'disabled' | 'trashed' | 'protected' | 'conflict' | 'invalid'`.
- Produces `compareSkillScans(input: CompareInput): SkillListItem[]`.
- `SkillListItem` exposes opaque `id`, display metadata, status, allowed actions, source/global digests, and diagnostics, but no internal path.

- [ ] **Step 1: Write the failing nine-state comparison matrix**

Build candidates with a helper and assert exact status/action tuples. Required examples:

```ts
expect(statusOf(compareSkillScans({ source: [source('a', 'one')], global: [], recovery: [] }), 'a'))
  .toEqual(['source-only', ['install']]);
expect(statusOf(compareSkillScans({ source: [source('a', 'two')], global: [global('a', 'one')], recovery: [] }), 'a'))
  .toEqual(['update-available', ['update']]);
expect(statusOf(compareSkillScans({ source: [source('a', 'one'), source('a', 'two')], global: [], recovery: [] }), 'a'))
  .toEqual(['conflict', []]);
```

- [ ] **Step 2: Run the comparator test and verify failure**

Run: `npm run test -w @itharbors/kit-skill-manager -- --run plugins/skill-manager/tests/skill-comparator.test.ts`

Expected: FAIL because `compareSkillScans` is missing.

- [ ] **Step 3: Implement deterministic comparison**

Group candidates by manifest name, promote invalid/protected/conflicting groups before digest comparison, detect source basename collisions against global directories, and sort by normalized name then status. Allowed actions are derived server-side: `install`, `update`, `disable`, `uninstall`, or `restore`.

- [ ] **Step 4: Run comparator and scanner tests**

Run: `npm run test -w @itharbors/kit-skill-manager -- --run plugins/skill-manager/tests/skill-comparator.test.ts plugins/skill-manager/tests/skill-scanner.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit comparison**

```bash
git add kits/skill-manager/plugins/skill-manager/main/src/types.ts kits/skill-manager/plugins/skill-manager/main/src/skill-comparator.ts kits/skill-manager/plugins/skill-manager/tests/skill-comparator.test.ts
git commit -m '[Feature] 增加 Skill 状态对照'
```

### Task 4: Add opaque directory browsing

**Files:**
- Create: `kits/skill-manager/plugins/skill-manager/main/src/directory-browser.ts`
- Create: `kits/skill-manager/plugins/skill-manager/main/src/safe-path.ts`
- Create: `kits/skill-manager/plugins/skill-manager/tests/directory-browser.test.ts`

**Interfaces:**
- Produces `createDirectoryBrowser({ homeDirectory, filesystemRoots }): DirectoryBrowser`.
- `DirectoryBrowser.open(id?: string): Promise<DirectoryPage>` returns `current`, optional `parentId`, and child `{ id, name }` records.
- `DirectoryBrowser.resolveSelection(id: string): Promise<{ directory: string; displayPath: string }>` is service-only; the raw path is never returned by plugin methods.

- [ ] **Step 1: Write failing browser security tests**

Assert initial home listing, parent navigation, sorted children, forged ID rejection, cross-instance ID rejection, symlink exclusion, and directory inode replacement rejection between listing and selection.

- [ ] **Step 2: Run the browser test and verify failure**

Run: `npm run test -w @itharbors/kit-skill-manager -- --run plugins/skill-manager/tests/directory-browser.test.ts`

Expected: FAIL because the browser module is missing.

- [ ] **Step 3: Implement capability-backed navigation**

Store each ID in a private Map with canonical path plus `{ dev, ino }`; use `randomUUID()` IDs; only issue children discovered by `readdir`; revalidate identity before opening or selecting. Return display paths only in `DirectoryPage.current.label`.

- [ ] **Step 4: Run browser tests**

Run the Task 4 focused command. Expected: PASS.

- [ ] **Step 5: Commit browsing**

```bash
git add kits/skill-manager/plugins/skill-manager/main/src/directory-browser.ts kits/skill-manager/plugins/skill-manager/main/src/safe-path.ts kits/skill-manager/plugins/skill-manager/tests/directory-browser.test.ts
git commit -m '[Feature] 增加安全目录选择'
```

### Task 5: Build the disabled/trash recovery store

**Files:**
- Create: `kits/skill-manager/plugins/skill-manager/main/src/skill-store.ts`
- Create: `kits/skill-manager/plugins/skill-manager/tests/skill-store.test.ts`
- Modify: `kits/skill-manager/plugins/skill-manager/main/src/skill-scanner.ts`
- Modify: `kits/skill-manager/plugins/skill-manager/main/src/types.ts`

**Interfaces:**
- Produces `createSkillStore({ codexHome }): SkillStore`.
- `SkillStore.list(): Promise<RecoveryEntry[]>` validates records against stored content.
- `SkillStore.moveFromGlobal(input: MoveInput): Promise<RecoveryEntry>` supports `disabled` and `trash`.
- `SkillStore.restore(input: RestoreInput): Promise<void>` refuses occupied or changed targets.
- Store root is exactly `<codexHome>/skill-manager-store/v1`.

- [ ] **Step 1: Write failing recovery tests**

Cover first disable, first uninstall, record content, list projection, restore, occupied target, tampered stored content, missing record, record-publication failure rollback, system Skill refusal, and concurrent moves for the same global directory.

- [ ] **Step 2: Run store tests and verify failure**

Run: `npm run test -w @itharbors/kit-skill-manager -- --run plugins/skill-manager/tests/skill-store.test.ts`

Expected: FAIL because `createSkillStore` is missing.

- [ ] **Step 3: Implement records and recoverable moves**

Use exact record shape:

```ts
type RecoveryRecord = {
  schemaVersion: 1;
  id: string;
  action: 'disabled' | 'trash';
  skillName: string;
  originalBasename: string;
  digest: string;
  createdAt: string;
};
```

Create entry directories with mode `0o700`, stage record to a temporary file, rename the Skill into `entry/skill`, then atomically publish `records/<id>.json`. If record publication fails, rename the Skill back to its unchanged global target before returning the error; if rollback also fails, retain a journal and recovery ID. Serialize by canonical global path and recovery ID. Recompute digests before restore.

- [ ] **Step 4: Integrate recovery candidates into scanning and comparison**

Map validated records to `disabled`/`trash` candidates; invalid records become diagnostics and never writable list items.

- [ ] **Step 5: Run store, scanner, and comparator tests**

Run: `npm run test -w @itharbors/kit-skill-manager -- --run plugins/skill-manager/tests/skill-store.test.ts plugins/skill-manager/tests/skill-scanner.test.ts plugins/skill-manager/tests/skill-comparator.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit recovery storage**

```bash
git add kits/skill-manager/plugins/skill-manager/main/src kits/skill-manager/plugins/skill-manager/tests/skill-store.test.ts
git commit -m '[Feature] 实现 Skill 可恢复停用与卸载'
```

### Task 6: Add atomic install and update transactions

**Files:**
- Create: `kits/skill-manager/plugins/skill-manager/main/src/skill-mutator.ts`
- Create: `kits/skill-manager/plugins/skill-manager/tests/skill-mutator.test.ts`
- Modify: `kits/skill-manager/plugins/skill-manager/main/src/skill-store.ts`
- Modify: `kits/skill-manager/plugins/skill-manager/main/src/types.ts`

**Interfaces:**
- Produces `createSkillMutator({ globalRoot, scanner, store }): SkillMutator`.
- `install(input: MutationInput): Promise<MutationReceipt>`.
- `update(input: MutationInput): Promise<MutationReceipt>`.
- `disable`, `uninstall`, and `restore` delegate through one serialized action surface.
- Every input contains service-resolved directories plus expected revision/digest; no public method accepts a Panel path.

- [ ] **Step 1: Write failing transaction tests**

Cover install, destination appearance race, source change during staging, successful update, publish failure rollback, backup recovery failure receipt, stale expected digest, symlink source, cross-device rename error, same-target serialization, and different-target concurrency.

- [ ] **Step 2: Run mutator tests and verify failure**

Run: `npm run test -w @itharbors/kit-skill-manager -- --run plugins/skill-manager/tests/skill-mutator.test.ts`

Expected: FAIL because `createSkillMutator` is missing.

- [ ] **Step 3: Implement staging and install**

Create `.skill-manager-stage-<uuid>` inside the global root, copy regular files without dereferencing links, verify staged digest, revalidate root identity, create the final directory exclusively, copy staged entries, and verify the published digest. Remove only the exact validated staging directory on failure.

- [ ] **Step 4: Implement update journal and rollback**

Write `journals/<uuid>.json` with target basename, expected old digest, backup basename, and stage basename. Rename old target to `.skill-manager-backup-<uuid>`, publish staged content, verify, then remove backup and journal. On failure restore backup; if restoration fails, return `recoveryId` and leave both journal and backup intact.

- [ ] **Step 5: Run all filesystem-domain tests**

Run: `npm run test -w @itharbors/kit-skill-manager -- --run plugins/skill-manager/tests/frontmatter.test.ts plugins/skill-manager/tests/digest.test.ts plugins/skill-manager/tests/skill-scanner.test.ts plugins/skill-manager/tests/skill-comparator.test.ts plugins/skill-manager/tests/directory-browser.test.ts plugins/skill-manager/tests/skill-store.test.ts plugins/skill-manager/tests/skill-mutator.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit mutations**

```bash
git add kits/skill-manager/plugins/skill-manager/main/src kits/skill-manager/plugins/skill-manager/tests/skill-mutator.test.ts
git commit -m '[Feature] 实现 Skill 原子安装与更新'
```

### Task 7: Connect service state and Harbors messages

**Files:**
- Create: `kits/skill-manager/plugins/skill-manager/main/src/skill-service.ts`
- Create: `kits/skill-manager/plugins/skill-manager/tests/skill-service.test.ts`
- Create: `kits/skill-manager/plugins/skill-manager/tests/plugin-main.test.ts`
- Modify: `kits/skill-manager/plugins/skill-manager/main/src/index.ts`

**Interfaces:**
- Produces `createSkillService({ codexHome, homeDirectory, broadcast }): SkillService`.
- Snapshot shape is `{ revision, generation, mode, globalRootLabel, sourceRootLabel, scanning, truncated, counts, items, diagnostics }`.
- Service methods exactly match the manifest request names.

- [ ] **Step 1: Write failing service-generation and adapter tests**

Assert default global scan, source select, source clear, cancellation of an older source scan, immutable revision increments, stale detail/action rejection, server-side action lookup, rescan after mutation, unload cancellation, and broadcast method names.

- [ ] **Step 2: Run service tests and verify failure**

Run: `npm run test -w @itharbors/kit-skill-manager -- --run plugins/skill-manager/tests/skill-service.test.ts plugins/skill-manager/tests/plugin-main.test.ts`

Expected: FAIL because the service and complete adapter are missing.

- [ ] **Step 3: Implement the service state machine**

Resolve `CODEX_HOME` in the adapter, create one service per plugin load, and call `dispose()` on unload. Each async scan captures generation; only the current generation may replace `snapshot`. Detail/action methods resolve `skillId` through the current private index and require revision plus expected digest.

- [ ] **Step 4: Implement the thin plugin adapter**

The main entry registers only these methods:

```ts
methods: {
  getSnapshot: () => service.getSnapshot(),
  browseDirectory: (input) => service.browseDirectory(input),
  selectSource: (input) => service.selectSource(input),
  clearSource: () => service.clearSource(),
  rescan: () => service.rescan(),
  getSkillDetail: (input) => service.getSkillDetail(input),
  performAction: (input) => service.performAction(input),
}
```

Broadcast through `runtime.message.broadcast('snapshot.changed', snapshot)` and the two progress names declared in the manifest.

- [ ] **Step 5: Run service tests and Kit build**

Run the Task 7 focused test command. Expected: PASS.

Run: `npm run build -w @itharbors/kit-skill-manager`. Expected: PASS.

- [ ] **Step 6: Commit service integration**

```bash
git add kits/skill-manager/plugins/skill-manager/main/src kits/skill-manager/plugins/skill-manager/tests/skill-service.test.ts kits/skill-manager/plugins/skill-manager/tests/plugin-main.test.ts
git commit -m '[Feature] 接通 Skill 管理消息服务'
```

### Task 8: Build the accessible management Panel and finish integration

**Files:**
- Modify: `kits/skill-manager/plugins/skill-manager/panel.manager/src/index.html`
- Modify: `kits/skill-manager/plugins/skill-manager/panel.manager/src/index.ts`
- Modify: `kits/skill-manager/plugins/skill-manager/panel.manager/src/index.css`
- Create: `kits/skill-manager/plugins/skill-manager/tests/panel.test.ts`
- Create: `kits/skill-manager/tests/runtime-integration.test.ts`
- Modify: `kits/skill-manager/README.md`
- Modify: `readme.md`
- Modify: `docs/guides/developing-plugins-and-kits.md`
- Modify: `docs/architecture/kit-and-session-model.md`

**Interfaces:**
- Panel requests only the seven manifest methods and handles `onSnapshotChanged`, `onScanProgress`, and `onOperationProgress` broadcasts.
- Runtime test uses `createSkillService` with an isolated temporary Codex home and source directory.

- [ ] **Step 1: Write failing Panel and runtime acceptance tests**

Cover initial global mode, source directory browser, source/global status filters, selection/detail loading, install/update/disable/uninstall/restore confirmation, stale detail response, disabled controls during operations, escaped malicious Skill text, keyboard list navigation, dialog focus trap/Escape/focus restore, `aria-live`, responsive CSS, and reduced motion. Runtime acceptance must create two source Skills and one global Skill, then prove `source-only`, `update-available`, install, update, disable, and restore.

- [ ] **Step 2: Run Panel and runtime tests and verify failure**

Run: `npm run test -w @itharbors/kit-skill-manager -- --run plugins/skill-manager/tests/panel.test.ts tests/runtime-integration.test.ts`

Expected: FAIL because the stub Panel and missing acceptance flow do not implement the contract.

- [ ] **Step 3: Implement the Panel state machine and semantic DOM**

Maintain `{ snapshot, selectedId, detail, filter, query, browser, dialog, pendingAction, error }`. Use DOM creation and `textContent`; never interpolate Skill values into HTML. Increment a local request generation for snapshot/detail/browser calls and ignore older generations. Broadcast handlers normalize and apply only newer revisions.

- [ ] **Step 4: Implement the three-column visual system**

Use design tokens with a deep graphite surface, lime accent, warm paper detail pane, compact sans typography, and monospace metadata. Keep density suitable for a management tool: toolbar, 220px filter rail, flexible list, minmax detail pane; collapse to list/detail navigation below 860px. Limit motion to opacity/transform and disable it under `prefers-reduced-motion`.

- [ ] **Step 5: Add confirmations and accessible keyboard behavior**

Destructive confirmations name the Skill and destination state. Trap Tab inside the dialog, close with Escape, restore focus to the invoking button, support ArrowUp/ArrowDown in the list, and update a polite status region after scans and actions.

- [ ] **Step 6: Complete runtime acceptance and documentation**

Document default global mode, selecting a source, state meanings, recoverable operations, protected `.system`, development commands, and the absence of permanent deletion/network install. Update official Kit lists and Session-source behavior in repository docs.

- [ ] **Step 7: Run focused and complete Skill Manager verification**

Run: `npm run test -w @itharbors/kit-skill-manager`

Expected: all Skill Manager tests PASS.

Run: `npm run build -w @itharbors/kit-skill-manager`

Expected: plugin main and Panel build PASS.

Run: `npm run kit:check -- skill-manager`

Expected: manifest validation, tests, build, pack, and inspection PASS with a generated `.hkit` in the isolated output directory.

Run: `npm run test:kit-monorepo && npm run test:kit-ci-selection && node --test scripts/lib/kit-catalog.test.mjs scripts/lib/kit-docs.test.mjs`

Expected: repository Kit discovery, CI selection, catalog, and documentation regression tests PASS.

- [ ] **Step 8: Inspect, commit, and verify the complete diff**

```bash
git status --short
git diff --check
git add kits/skill-manager readme.md docs/guides/developing-plugins-and-kits.md docs/architecture/kit-and-session-model.md
git commit -m '[Feature] 完成 Skill 管理工作台'
```

Run: `git status --short`. Expected: clean worktree.

Run the Task 8 focused and repository verification commands again after the commit. Expected: all PASS.
