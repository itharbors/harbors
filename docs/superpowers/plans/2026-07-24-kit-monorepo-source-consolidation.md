# Kit Monorepo Source Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `main:kits/{sqlite,mysql,notifications}` the complete, independently valid source of truth for all three official Kits.

**Architecture:** Keep the existing npm monorepo and root lock file. Add a strict policy-backed Kit identity loader, place each publish manifest beside its runtime `package.json`, remove stale product remnants, and expose one targeted checker that builds, tests, validates, packs, and inspects exactly one Kit.

**Tech Stack:** Node.js 22.18.0, npm 10.9.3 workspaces, ES modules, Node test runner, Vitest, `@itharbors/kit-core`, `@itharbors/kit-cli`.

## Global Constraints

- `main` is the only active long-lived source branch; old `kit/sqlite`, `kit/mysql`, and `kit/notifications` remain read-only rollback refs.
- Official Kit directories are exactly `kits/sqlite`, `kits/mysql`, and `kits/notifications`.
- Repository-local Author and Committer must be `VisualSJ <devhacker520@hotmail.com>`.
- The root `package-lock.json` is the only npm lock file on `main`; each Kit declares its own dependencies in its own `package.json`.
- Initial migrated versions are exactly `0.1.0-preview.1`, matching the old product branch manifests.
- No Framework version field or Framework release trigger changes in this plan.
- The nested `harbors-kits/` clone is ignored but not deleted or modified.
- All edits use the repository commit-title convention with concise Chinese summaries.

---

### Task 1: Add the official Kit policy and identity loader

**Files:**
- Create: `registry/policy.json`
- Create: `scripts/lib/kit-monorepo.mjs`
- Create: `scripts/lib/kit-monorepo.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `parseKitPackageManifest(value)` from `@itharbors/kit-core`.
- Produces: `OFFICIAL_KIT_SLUGS: readonly string[]`.
- Produces: `loadKitPolicy({ repositoryRoot, policyFile? }): Promise<KitPolicy>`.
- Produces: `loadOfficialKit({ repositoryRoot, slug }): Promise<{ slug, directory, id, label, summary, runner, manifest, packageJson }>`.

- [ ] **Step 1: Write failing policy and identity tests**

Create `scripts/lib/kit-monorepo.test.mjs` with tests that:

```js
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  OFFICIAL_KIT_SLUGS,
  loadOfficialKit,
  loadKitPolicy,
} from './kit-monorepo.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

test('loads the exact official Kit set from one strict policy', async () => {
  const policy = await loadKitPolicy({ repositoryRoot });
  assert.deepEqual(OFFICIAL_KIT_SLUGS, ['mysql', 'notifications', 'sqlite']);
  assert.equal(policy.repository, 'itharbors/harbors');
  assert.deepEqual(policy.signerWorkflows, [
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1',
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2',
  ]);
});

test('rejects unknown Kit slugs before resolving a path', async () => {
  await assert.rejects(
    loadOfficialKit({ repositoryRoot, slug: '../sqlite' }),
    /unknown official Kit slug/i,
  );
});
```

- [ ] **Step 2: Run the test and confirm the module is missing**

Run: `node --test scripts/lib/kit-monorepo.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/lib/kit-monorepo.mjs`.

- [ ] **Step 3: Add the exact policy document**

Create `registry/policy.json`:

```json
{
  "schemaVersion": 1,
  "repository": "itharbors/harbors",
  "workflow": "itharbors/harbors/.github/workflows/publish-kit.yml",
  "signerWorkflows": [
    "itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1",
    "itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2"
  ],
  "kits": {
    "mysql": {
      "id": "@itharbors/kit-mysql",
      "label": "MySQL",
      "summary": "MySQL 数据库连接、浏览、编辑、关系图与 SQL 工作台",
      "runner": "ubuntu-latest"
    },
    "notifications": {
      "id": "@itharbors/kit-notifications",
      "label": "Notifications",
      "summary": "桌面通知中心与 Codex notify-user Skill 安装能力",
      "runner": "ubuntu-latest"
    },
    "sqlite": {
      "id": "@itharbors/kit-sqlite",
      "label": "SQLite",
      "summary": "SQLite 数据库浏览、编辑、关系图与 SQL 工作台",
      "runner": "macos-14"
    }
  }
}
```

- [ ] **Step 4: Implement strict policy and manifest loading**

Create `scripts/lib/kit-monorepo.mjs`. It must reject unknown policy fields, non-canonical slugs, duplicate IDs, unsupported runners, repository drift, missing directories, and manifest/package identity or version mismatches. Its public shape is:

```js
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseKitPackageManifest } from '@itharbors/kit-core';

const POLICY_FILE = 'registry/policy.json';
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const ALLOWED_RUNNERS = new Set(['ubuntu-latest', 'macos-14']);

export const OFFICIAL_KIT_SLUGS = Object.freeze(['mysql', 'notifications', 'sqlite']);

export async function loadKitPolicy({
  repositoryRoot,
  policyFile = path.join(repositoryRoot, POLICY_FILE),
}) {
  const raw = JSON.parse(await readFile(policyFile, 'utf8'));
  const expectedKeys = ['kits', 'repository', 'schemaVersion', 'signerWorkflows', 'workflow'];
  if (JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('Kit policy contains unexpected fields');
  }
  if (raw.schemaVersion !== 1 || raw.repository !== 'itharbors/harbors') {
    throw new Error('Kit policy identity is invalid');
  }
  if (raw.workflow !== 'itharbors/harbors/.github/workflows/publish-kit.yml') {
    throw new Error('Kit policy workflow is invalid');
  }
  const expectedSigners = [
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1',
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2',
  ];
  if (JSON.stringify(raw.signerWorkflows) !== JSON.stringify(expectedSigners)) {
    throw new Error('Kit policy signer workflows are invalid');
  }
  const slugs = Object.keys(raw.kits ?? {}).sort();
  if (JSON.stringify(slugs) !== JSON.stringify(OFFICIAL_KIT_SLUGS)) {
    throw new Error('Kit policy official slug set is invalid');
  }
  const ids = new Set();
  for (const slug of slugs) {
    const entry = raw.kits[slug];
    if (!SLUG_PATTERN.test(slug) || !entry || typeof entry !== 'object') {
      throw new Error(`Kit policy entry is invalid: ${slug}`);
    }
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['id', 'label', 'runner', 'summary'])) {
      throw new Error(`Kit policy entry contains unexpected fields: ${slug}`);
    }
    if (entry.id !== `@itharbors/kit-${slug}` || ids.has(entry.id)) {
      throw new Error(`Kit policy id is invalid: ${slug}`);
    }
    if (!ALLOWED_RUNNERS.has(entry.runner) || !entry.label || !entry.summary) {
      throw new Error(`Kit policy metadata is invalid: ${slug}`);
    }
    ids.add(entry.id);
  }
  return Object.freeze(raw);
}

export async function loadOfficialKit({ repositoryRoot, slug }) {
  if (!OFFICIAL_KIT_SLUGS.includes(slug)) {
    throw new Error(`Unknown official Kit slug: ${String(slug)}`);
  }
  const policy = await loadKitPolicy({ repositoryRoot });
  const directory = await realpath(path.join(repositoryRoot, 'kits', slug));
  const manifest = parseKitPackageManifest(JSON.parse(
    await readFile(path.join(directory, 'kit.json'), 'utf8'),
  ));
  const packageJson = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const metadata = policy.kits[slug];
  if (manifest.id !== metadata.id || packageJson.name !== metadata.id) {
    throw new Error(`Kit identity mismatch: ${slug}`);
  }
  if (manifest.version !== packageJson.version) {
    throw new Error(`Kit version mismatch: ${slug}`);
  }
  return Object.freeze({ slug, directory, ...metadata, manifest, packageJson });
}
```

- [ ] **Step 5: Register the focused test script**

Add to root `package.json`:

```json
"test:kit-monorepo": "node --test scripts/lib/kit-monorepo.test.mjs"
```

Append `npm run test:kit-monorepo` to the root `test` script.

- [ ] **Step 6: Run the policy contract test**

Run: `npm run test:kit-monorepo`

Expected: PASS because this task tests only policy parsing and rejection before directory loading.

- [ ] **Step 7: Commit the policy contract**

```bash
git add registry/policy.json scripts/lib/kit-monorepo.mjs scripts/lib/kit-monorepo.test.mjs package.json
git commit -m "[Feature] 定义官方 Kit 目录契约"
```

### Task 2: Add manifests, reconcile branch tips, and remove stale product remnants

**Files:**
- Create: `kits/sqlite/kit.json`
- Create: `kits/mysql/kit.json`
- Create: `kits/notifications/kit.json`
- Modify: `kits/sqlite/package.json`
- Modify: `kits/mysql/package.json`
- Modify: `kits/notifications/package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Delete: `kits/sqlite/plugins/sqlite-workbench/**`
- Delete: `kits/mysql/plugins/mysql-workbench/**`
- Create: `docs/guides/kit-source-migration-audit.md`
- Modify: `scripts/lib/kit-monorepo.test.mjs`

**Interfaces:**
- Consumes: `loadOfficialKit({ repositoryRoot, slug })` from Task 1.
- Produces: three directory-local publishable Kit projects at version `0.1.0-preview.1`.
- Produces: a checked-in audit tying each retired product branch tip to the reconciled `main` directory.

- [ ] **Step 1: Extend the failing contract test to reject undeclared directories**

First add the real-directory identity test and the undeclared-directory assertion to
`scripts/lib/kit-monorepo.test.mjs`:

```js
import { readdir } from 'node:fs/promises';

test('loads three directory-local manifests with matching runtime identity', async () => {
  for (const slug of OFFICIAL_KIT_SLUGS) {
    const kit = await loadOfficialKit({ repositoryRoot, slug });
    assert.equal(kit.directory, path.join(repositoryRoot, 'kits', slug));
    assert.equal(kit.manifest.id, kit.id);
    assert.equal(kit.manifest.version, kit.packageJson.version);
    assert.equal(kit.packageJson.name, kit.id);
    assert.equal(kit.manifest.version, '0.1.0-preview.1');
    assert.equal(kit.manifest.channel, 'preview');
  }
});

test('contains no legacy plugin directories outside each Kit declaration', async () => {
  for (const slug of OFFICIAL_KIT_SLUGS) {
    const kit = await loadOfficialKit({ repositoryRoot, slug });
    const declared = new Set([
      ...(kit.packageJson['ce-editor'].kit.plugin ?? []),
      ...(kit.packageJson['ce-editor'].kit.startup?.plugins ?? []),
    ]);
    const directories = await readdir(`${kit.directory}/plugins`, { withFileTypes: true });
    for (const directory of directories.filter((entry) => entry.isDirectory())) {
      const packageName = `@itharbors/${directory.name}`;
      assert.ok(declared.has(packageName), `${slug} contains undeclared directory ${directory.name}`);
    }
  }
});
```

Run: `npm run test:kit-monorepo`

Expected: FAIL with `ENOENT` for `kits/mysql/kit.json`.

- [ ] **Step 2: Add the three exact product manifests**

Create `kits/sqlite/kit.json`:

```json
{
  "schemaVersion": 1,
  "id": "@itharbors/kit-sqlite",
  "version": "0.1.0-preview.1",
  "channel": "preview",
  "publisher": "itharbors",
  "requires": {
    "harbors": ">=0.0.1 <0.1.0",
    "kitApi": "^1.0.0",
    "protocolVersion": 1
  },
  "target": {
    "platform": "darwin",
    "arch": "arm64",
    "nodeAbi": "127"
  },
  "permissions": ["filesystem", "native-code"],
  "entry": "package.json"
}
```

Create `kits/mysql/kit.json`:

```json
{
  "schemaVersion": 1,
  "id": "@itharbors/kit-mysql",
  "version": "0.1.0-preview.1",
  "channel": "preview",
  "publisher": "itharbors",
  "requires": {
    "harbors": ">=0.0.1 <0.1.0",
    "kitApi": "^1.0.0",
    "protocolVersion": 1
  },
  "target": {"platform": "any", "arch": "any"},
  "permissions": ["network"],
  "entry": "package.json"
}
```

Create `kits/notifications/kit.json`:

```json
{
  "schemaVersion": 1,
  "id": "@itharbors/kit-notifications",
  "version": "0.1.0-preview.1",
  "channel": "preview",
  "publisher": "itharbors",
  "requires": {
    "harbors": ">=0.0.1 <0.1.0",
    "kitApi": "^1.0.0",
    "protocolVersion": 1
  },
  "target": {"platform": "any", "arch": "any"},
  "permissions": ["network", "filesystem", "application-startup"],
  "entry": "package.json"
}
```

- [ ] **Step 3: Align runtime package versions and remove stale directories**

Change only the top-level `version` in each target `package.json` from `0.0.1` to
`0.1.0-preview.1`. Delete all tracked files under:

```text
kits/sqlite/plugins/sqlite-workbench/
kits/mysql/plugins/mysql-workbench/
```

These directories contain obsolete built output and are absent from both current manifests and old product branch tips.

- [ ] **Step 4: Regenerate the root lock deterministically**

Run: `npm install --package-lock-only --ignore-scripts`

Expected: exit 0; root workspace entries for the three Kit packages show `0.1.0-preview.1`; no
`kits/*/package-lock.json` is created.

- [ ] **Step 5: Ignore the paused nested repository**

Append exactly this anchored entry to `.gitignore`:

```gitignore
/harbors-kits/
```

Run: `git status --short`

Expected: `harbors-kits/` is absent from status output.

- [ ] **Step 6: Record the source reconciliation evidence**

Create `docs/guides/kit-source-migration-audit.md` containing:

```markdown
# Kit 产品分支回迁审计

| Kit | 只读回退 tip | 迁移结论 |
| --- | --- | --- |
| SQLite | `c6bc4e725a934352a650c9a310d8c8472c038522` | 插件源码与 `main/kits/sqlite` 一致；保留 main 的运行时集成测试；移除未声明的旧 workbench 产物；迁入 `kit.json` 与 0.1.0-preview.1 版本。 |
| MySQL | `e6ccc5869d4280f553da307f5bb6899506923be2` | 插件源码与 `main/kits/mysql` 一致；保留 main 的运行时集成测试；移除未声明的旧 workbench 产物；迁入 `kit.json` 与 0.1.0-preview.1 版本。 |
| Notifications | `c777ae7b8fd4f43796d6eb83fb97fefe67bdeada` | 插件源码与 `main/kits/notifications` 一致；迁入 `kit.json` 与 0.1.0-preview.1 版本。 |

三个旧分支只作为回退来源，不再接收 Kit 开发或发布提交。旧分支根部复制的 Framework 工具、Workflow、Skill 和锁文件不迁入 `kits/*`。
```

- [ ] **Step 7: Run the monorepo and manifest checks**

Run:

```bash
npm run build -w @itharbors/kit-core
npm run build -w @itharbors/kit-cli
npm run test:kit-monorepo
npm run kit -- validate kits/sqlite
npm run kit -- validate kits/mysql
npm run kit -- validate kits/notifications
```

Expected: every command exits 0; each validate command prints its matching Kit ID and
`KIT_VERSION=0.1.0-preview.1`.

- [ ] **Step 8: Commit the reconciled source of truth**

```bash
git add .gitignore package-lock.json kits/sqlite kits/mysql kits/notifications docs/guides/kit-source-migration-audit.md scripts/lib/kit-monorepo.test.mjs
git commit -m "[Refactor] 回迁三个 Kit 到主分支目录"
```

### Task 3: Add a targeted build-test-pack checker

**Files:**
- Create: `scripts/lib/kit-check.mjs`
- Create: `scripts/lib/kit-check.test.mjs`
- Create: `scripts/check-kit.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `loadOfficialKit({ repositoryRoot, slug })` from Task 1.
- Produces: `checkOfficialKit({ repositoryRoot, slug, outputDirectory, runCommand }): Promise<{ artifactPath, kit }>`.
- Produces CLI: `node scripts/check-kit.mjs <sqlite|mysql|notifications> --output-directory <absolute-directory>`.

- [ ] **Step 1: Write failing command-sequence tests**

Create `scripts/lib/kit-check.test.mjs`. Inject a `runCommand(command, args, options)` fake and assert the exact order:

```js
[
  ['npm', ['run', 'build', '-w', '@itharbors/mysql-contracts']],
  ['npm', ['run', 'build', '-w', '@itharbors/relationship-graph']],
  ['npm', ['run', 'build', '-w', '@itharbors/kit-core']],
  ['npm', ['run', 'build', '-w', '@itharbors/kit-cli']],
  [process.execPath, ['scripts/ce-plugin.mjs', 'build', 'kits/mysql/plugins/mysql-core']],
  [process.execPath, ['scripts/ce-plugin.mjs', 'build', 'kits/mysql/plugins/mysql-data']],
  [process.execPath, ['scripts/ce-plugin.mjs', 'build', 'kits/mysql/plugins/mysql-explorer']],
  [process.execPath, ['scripts/ce-plugin.mjs', 'build', 'kits/mysql/plugins/mysql-relationships']],
  [process.execPath, ['scripts/ce-plugin.mjs', 'build', 'kits/mysql/plugins/mysql-schema']],
  [process.execPath, ['scripts/ce-plugin.mjs', 'build', 'kits/mysql/plugins/mysql-sql']],
  ['npm', ['test', '-w', '@itharbors/kit-mysql']],
  [process.execPath, ['packages/kit-cli/dist/cli.js', 'validate', 'kits/mysql']],
  [process.execPath, ['packages/kit-cli/dist/cli.js', 'pack', 'kits/mysql', '--output', path.join(outputDirectory, 'kit-mysql-0.1.0-preview.1-any-any.hkit')]],
  [process.execPath, ['packages/kit-cli/dist/cli.js', 'inspect', path.join(outputDirectory, 'kit-mysql-0.1.0-preview.1-any-any.hkit'), '--json']],
]
```

Also assert that Notifications invokes `scripts/prepare-notification-skill-resource.mjs` after its plugins build, and an unknown slug is rejected before any command runs.

- [ ] **Step 2: Run the test and confirm the checker is missing**

Run: `node --test scripts/lib/kit-check.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/lib/kit-check.mjs`.

- [ ] **Step 3: Implement the targeted checker**

Implement `scripts/lib/kit-check.mjs` with these rules:

```js
const BUILD_WORKSPACES = Object.freeze({
  mysql: ['@itharbors/mysql-contracts', '@itharbors/relationship-graph', '@itharbors/kit-core', '@itharbors/kit-cli'],
  notifications: ['@itharbors/kit-core', '@itharbors/kit-cli'],
  sqlite: ['@itharbors/sqlite-contracts', '@itharbors/relationship-graph', '@itharbors/kit-core', '@itharbors/kit-cli'],
});

export async function checkOfficialKit({
  repositoryRoot,
  slug,
  outputDirectory,
  runCommand = runCheckedCommand,
}) {
  const kit = await loadOfficialKit({ repositoryRoot, slug });
  for (const workspace of BUILD_WORKSPACES[slug]) {
    await runCommand('npm', ['run', 'build', '-w', workspace], { cwd: repositoryRoot });
  }

  const pluginNames = [
    ...(kit.packageJson['ce-editor'].kit.plugin ?? []),
    ...(kit.packageJson['ce-editor'].kit.startup?.plugins ?? []),
  ].map((name) => name.replace(/^@itharbors\//u, '')).sort();
  for (const pluginName of pluginNames) {
    await runCommand(process.execPath, [
      'scripts/ce-plugin.mjs', 'build', `kits/${slug}/plugins/${pluginName}`,
    ], { cwd: repositoryRoot });
  }
  if (slug === 'notifications') {
    await runCommand(process.execPath, ['scripts/prepare-notification-skill-resource.mjs'], {
      cwd: repositoryRoot,
    });
  }
  await runCommand('npm', ['test', '-w', kit.id], { cwd: repositoryRoot });
  await runCommand(process.execPath, ['packages/kit-cli/dist/cli.js', 'validate', `kits/${slug}`], {
    cwd: repositoryRoot,
  });
  const artifactName = deriveArtifactName(kit.manifest);
  const artifactPath = path.join(outputDirectory, artifactName);
  await mkdir(outputDirectory, { recursive: true });
  await runCommand(process.execPath, [
    'packages/kit-cli/dist/cli.js', 'pack', `kits/${slug}`, '--output', artifactPath,
  ], { cwd: repositoryRoot });
  await runCommand(process.execPath, [
    'packages/kit-cli/dist/cli.js', 'inspect', artifactPath, '--json',
  ], { cwd: repositoryRoot });
  return Object.freeze({ artifactPath, kit });
}
```

`runCheckedCommand` must use `spawn` with `stdio: 'inherit'`, reject on non-zero exit or signal, and never invoke a shell.

- [ ] **Step 4: Implement the thin CLI and root script**

Create `scripts/check-kit.mjs` to accept exactly three arguments after the script name:

```text
<slug> --output-directory <absolute-directory>
```

Reject a relative output path or extra arguments with exit code 2. Call `checkOfficialKit`, print
`KIT=<slug>` and `ARTIFACT=<absolute path>` on success, and print one `ERROR=<single line>` on failure.

Add to `package.json`:

```json
"kit:check": "node scripts/check-kit.mjs",
"test:kit-check": "node --test scripts/lib/kit-check.test.mjs"
```

Append `npm run test:kit-check` to the root `test` script.

- [ ] **Step 5: Run unit tests and one real Kit check**

Run:

```bash
npm run test:kit-check
kit_output_dir=$(mktemp -d)
npm run kit:check -- notifications --output-directory "$kit_output_dir"
```

Expected: unit tests PASS; the real command exits 0 and produces exactly one Notifications `.hkit` plus successful offline inspect output.

- [ ] **Step 6: Commit the targeted checker**

```bash
git add scripts/lib/kit-check.mjs scripts/lib/kit-check.test.mjs scripts/check-kit.mjs package.json
git commit -m "[Feature] 新增单 Kit 完整检查入口"
```

### Task 4: Verify all three directory products

**Files:**
- Modify only if verification exposes a source-reconciliation defect in files already listed in Tasks 1–3.

**Interfaces:**
- Consumes: `npm run kit:check -- <slug> --output-directory <directory>`.
- Produces: three inspected `.hkit` files, each built solely from its matching `kits/<slug>` directory.

- [ ] **Step 1: Run all focused unit suites**

Run:

```bash
npm run test:kit-monorepo
npm run test:kit-check
npm run test:kit-publish
```

Expected: all tests PASS.

- [ ] **Step 2: Build, test, validate, pack, and inspect every Kit**

Run:

```bash
sqlite_output=$(mktemp -d)
mysql_output=$(mktemp -d)
notifications_output=$(mktemp -d)
npm run kit:check -- sqlite --output-directory "$sqlite_output"
npm run kit:check -- mysql --output-directory "$mysql_output"
npm run kit:check -- notifications --output-directory "$notifications_output"
```

Expected: all three commands exit 0; each output directory contains one `.hkit`; each inspection reports the matching Kit ID and `0.1.0-preview.1`.

- [ ] **Step 3: Prove artifact isolation**

Run:

```bash
sqlite_artifact="$sqlite_output/kit-sqlite-0.1.0-preview.1-darwin-arm64-abi127.hkit"
mysql_artifact="$mysql_output/kit-mysql-0.1.0-preview.1-any-any.hkit"
notifications_artifact="$notifications_output/kit-notifications-0.1.0-preview.1-any-any.hkit"
npm run kit -- inspect "$sqlite_artifact" --json
npm run kit -- inspect "$mysql_artifact" --json
npm run kit -- inspect "$notifications_artifact" --json
! unzip -Z1 "$sqlite_artifact" | rg '(^|/)(mysql|notifications)(/|$)'
! unzip -Z1 "$mysql_artifact" | rg '(^|/)(sqlite|notifications)(/|$)'
! unzip -Z1 "$notifications_artifact" | rg '(^|/)(sqlite|mysql)(/|$)'
```

Expected: all assertions pass; GitHub source ZIP is not referenced anywhere in the inspected manifests.

- [ ] **Step 4: Run the repository regression gate**

Run: `npm run check`

Expected: exit 0.

- [ ] **Step 5: Confirm verification made no new changes**

Run: `git status --short`

Expected: empty output. If verification exposed a defect, return to the owning task, add a failing regression test,
fix it there, rerun that task, and use that task's commit message; never create an empty verification commit.
