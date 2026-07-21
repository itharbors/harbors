# In-App notify-user Skill Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users install or update the Harbors-bundled `notify-user` Skill by clicking a Notification Kit main-menu command, without network access or an external installer.

**Architecture:** The existing Kit menu pipeline invokes a zero-argument `installCodexSkill` method in the Notification Center server plugin. A focused Node installer copies the Electron-provided bundled Skill into `$CODEX_HOME/skills/notify-user` atomically, records Harbors ownership and a content digest, rejects unmanaged conflicts, and reports the result through the existing Notification Host.

**Tech Stack:** TypeScript server plugin, Node.js filesystem/crypto APIs, Electron process environment, Vitest, existing Harbors menu and Notification Host protocols.

## Global Constraints

- The formal user flow is offline and must not invoke GitHub, Codex CLI, `osascript`, `notify-send`, or PowerShell.
- The menu method accepts no source path, target path, or Skill name from the caller.
- The source is `HARBORS_NOTIFY_SKILL_SOURCE`; the destination is `$CODEX_HOME/skills/notify-user`, falling back to `~/.codex/skills/notify-user`.
- Never overwrite an existing unmarked Skill or follow a destination Skill symlink.
- Tests use temporary directories only and never write to the real user Skill directory.
- Keep `.agents/skills/notify-user` as the development source; packaged Electron resolves `resources/skills/notify-user`.

---

### Task 1: Atomic Codex Skill installer

**Files:**
- Create: `kits/notifications/plugins/notification-center/main/src/codex-skill-installer.ts`
- Create: `kits/notifications/plugins/notification-center/tests/codex-skill-installer.test.ts`

**Interfaces:**
- Produces: `createCodexSkillInstaller({ sourceDir, codexHome }): { install(): Promise<CodexSkillInstallResult> }`.
- Produces: result status `installed | updated | current`, destination, and digest; typed errors use stable codes for missing source, conflict, and unsafe symlink.

```ts
export type CodexSkillInstallResult = {
  status: 'installed' | 'updated' | 'current';
  destination: string;
  digest: string;
};

export class CodexSkillInstallError extends Error {
  constructor(public readonly code: 'SKILL_SOURCE_INVALID' | 'SKILL_CONFLICT' | 'SKILL_UNSAFE_PATH', message: string) {
    super(message);
  }
}

export function createCodexSkillInstaller(options: {
  sourceDir: string;
  codexHome: string;
}): { install(): Promise<CodexSkillInstallResult> };
```

- [ ] **Step 1: Write failing first-install and repeated-install tests**

Create a temporary source containing `SKILL.md`, `agents/openai.yaml`, and `scripts/notify.mjs`. Assert the first call copies all files plus `.harbors-skill.json` under `<codexHome>/skills/notify-user`, and the second call returns `current` without changing content.

```ts
const installer = createCodexSkillInstaller({ sourceDir, codexHome });
await expect(installer.install()).resolves.toMatchObject({ status: 'installed' });
await expect(readFile(path.join(codexHome, 'skills/notify-user/SKILL.md'), 'utf8')).resolves.toContain('name: notify-user');
await expect(installer.install()).resolves.toMatchObject({ status: 'current' });
```

- [ ] **Step 2: Run the focused installer test and verify RED**

Run: `npm exec -w @itharbors/kit-notifications -- vitest run plugins/notification-center/tests/codex-skill-installer.test.ts`

Expected: FAIL because `codex-skill-installer.ts` does not exist.

- [ ] **Step 3: Implement validation, digesting, staging, and first install**

Use `lstat`, recursive deterministic SHA-256 hashing, `mkdtemp`, `cp`, `writeFile`, and `rename`. Reject source symlinks and a destination whose `lstat().isSymbolicLink()` is true. Write marker schema `{ owner: "itharbors", skill: "notify-user", digest: "...", version: 1 }`.

```ts
const marker = { owner: 'itharbors', skill: 'notify-user', digest, version: 1 };
await cp(sourceDir, stagingDir, { recursive: true, dereference: false });
await writeFile(path.join(stagingDir, '.harbors-skill.json'), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
await rename(stagingDir, destination);
```

- [ ] **Step 4: Run the focused installer test and verify GREEN**

Run the Task 1 focused command. Expected: first-install and current-version cases PASS.

- [ ] **Step 5: Add failing update, unmanaged-conflict, modified-managed, and concurrency tests**

Assert a marked older digest updates atomically; an unmarked directory and a managed directory modified after installation are preserved with `SKILL_CONFLICT`; a destination symlink is rejected; two immediate `install()` calls return the same in-flight Promise and one result.

```ts
const first = installer.install();
const second = installer.install();
expect(second).toBe(first);
await expect(first).resolves.toMatchObject({ status: 'installed' });
await expect(conflictingInstaller.install()).rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
```

- [ ] **Step 6: Run focused tests and verify RED for update behavior**

Expected: new update/conflict/concurrency cases FAIL while first-install cases remain green.

- [ ] **Step 7: Implement minimal update, rollback, conflict, and in-flight behavior**

Rename the old managed directory to a same-parent backup, rename the staged directory into place, remove the backup after success, and restore it if the second rename fails. Treat installed content whose digest no longer matches its marker as a conflict. Cache and clear the in-flight Promise in the installer closure.

- [ ] **Step 8: Run focused tests and commit the installer**

Expected: all installer tests PASS and no temp directories remain.

Commit: `[Feature] 新增通知 Skill 原子安装器`.

### Task 2: Resolve the Electron-bundled Skill source

**Files:**
- Create: `scripts/lib/codex-skill-resource.mjs`
- Create: `scripts/lib/codex-skill-resource.test.mjs`
- Modify: `scripts/electron.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `resolveCodexSkillSource({ isPackaged, resourcesPath, rootDir })` returning `<resourcesPath>/skills/notify-user` when packaged and `<rootDir>/.agents/skills/notify-user` in development.
- Consumes: `HARBORS_NOTIFY_SKILL_SOURCE` in Task 3.

```js
export function resolveCodexSkillSource({ isPackaged, resourcesPath, rootDir }) {
  return path.resolve(isPackaged
    ? path.join(resourcesPath, 'skills', 'notify-user')
    : path.join(rootDir, '.agents', 'skills', 'notify-user'));
}
```

- [ ] **Step 1: Write a failing resolver and Electron environment-wiring test**

Assert both paths are absolute and normalized. Add a source assertion that `startFramework()` passes the resolved path as `HARBORS_NOTIFY_SKILL_SOURCE` alongside `HARBORS_NOTIFICATION_PORT`.

- [ ] **Step 2: Run the focused Node test and verify RED**

Run: `node --test scripts/lib/codex-skill-resource.test.mjs scripts/lib/electron-launcher.test.mjs`

Expected: FAIL because the resolver and environment wiring are absent.

- [ ] **Step 3: Implement the resolver and pass it to the Framework child**

Resolve once after Electron readiness using `app.isPackaged`, `process.resourcesPath`, and the existing `rootDir`; add it to the exact child environment. Register the resolver test in the root `npm test` Node test list.

```js
const codexSkillSource = resolveCodexSkillSource({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  rootDir,
});

HARBORS_NOTIFY_SKILL_SOURCE: codexSkillSource,
```

- [ ] **Step 4: Run focused tests and commit resource wiring**

Expected: resolver and Electron launcher tests PASS.

Commit: `[Feature] 注入内置通知 Skill 资源路径`.

### Task 3: Register and execute the Notification Kit menu command

**Files:**
- Modify: `kits/notifications/plugins/notification-center/package.json`
- Modify: `kits/notifications/plugins/notification-center/main/src/index.ts`
- Modify: `kits/notifications/plugins/notification-center/tests/main.test.ts`
- Modify: `kits/notifications/tests/kit-manifest.test.ts`

**Interfaces:**
- Consumes: `createCodexSkillInstaller` from Task 1 and `HARBORS_NOTIFY_SKILL_SOURCE` from Task 2.
- Produces: zero-argument plugin method and menu message `installCodexSkill`.

```json
{
  "type": "menu",
  "id": "install-codex-notification-skill",
  "label": "Install or Update Codex Notification Skill…",
  "message": "installCodexSkill",
  "order": 10
}
```

- [ ] **Step 1: Write failing manifest and plugin-method tests**

Assert a direct Kit menu action with id `install-codex-notification-skill`, label `Install or Update Codex Notification Skill…`, and message `installCodexSkill`. In a temporary `CODEX_HOME`, invoke the method and assert it installs the Skill and POSTs a transient success notification containing “next Codex turn”.

- [ ] **Step 2: Run Notification Kit tests and verify RED**

Run: `npm run test -w @itharbors/kit-notifications`

Expected: FAIL because the menu contribution and method do not exist.

- [ ] **Step 3: Add the menu contribution, request mapping, and installer method**

The method takes no arguments, lazily creates one installer from trusted environment variables, catches stable installer errors, and POSTs result notifications through `hostRequest('/v1/notifications', { method: 'POST', headers: { 'content-type': 'application/json' }, body })`.

```ts
async installCodexSkill() {
  try {
    const result = await getSkillInstaller().install();
    await sendInstallNotification(result);
    return result;
  } catch (error) {
    const failure = normalizeInstallFailure(error);
    await sendInstallFailureNotification(failure);
    return failure;
  }
}
```

- [ ] **Step 4: Add result feedback cases**

Map `installed`/`updated` to transient `success`, `current` to transient `info`, and conflict/resource/permission failure to persistent `error`. Return a serializable result instead of throwing after the Host accepts the feedback notification.

- [ ] **Step 5: Run Notification Kit tests and commit menu integration**

Expected: manifest, plugin main, installer, and panel tests PASS.

Commit: `[Feature] 注册通知 Skill 安装菜单`.

### Task 4: Replace the GitHub-first user documentation

**Files:**
- Modify: `readme.md`
- Modify: `docs/guides/developing-plugins-and-kits.md`
- Modify: `.agents/skills/notify-user/tests/notify.test.mjs`

**Interfaces:**
- Documents: `Notifications -> Install or Update Codex Notification Skill…` as the formal user flow.

- [ ] **Step 1: Change the documentation contract test to require the menu flow**

Assert README contains the menu label, bundled/offline language, and `~/.codex/skills/notify-user`, and no longer presents the GitHub URL as the formal installation prompt.

```js
assert.match(readme, /Install or Update Codex Notification Skill/);
assert.match(readme, /~\/\.codex\/skills\/notify-user/);
assert.doesNotMatch(readme, /安装为用户级 Codex Skill/);
```

- [ ] **Step 2: Run the Skill test and verify RED**

Run: `node --test .agents/skills/notify-user/tests/notify.test.mjs`

Expected: FAIL against the existing GitHub-first README.

- [ ] **Step 3: Rewrite README and the developer guide**

Explain that Harbors ships the Skill, the user clicks the Notifications menu, installation is available on the next Codex turn, and Web-only mode cannot install it. Keep the absolute-path Agent invocation example and failure contract.

- [ ] **Step 4: Run focused documentation and Skill validation**

Run: `node --test .agents/skills/notify-user/tests/notify.test.mjs`

Run: `python3 /Users/bytedance/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/notify-user`

Expected: both PASS.

Commit: `[Feature] 更新通知 Skill 应用内安装文档`.

### Task 5: Full verification and PR update

**Files:**
- Verify all files modified by Tasks 1-4.

**Interfaces:**
- Produces: a clean, pushed `feature/notification-kit` branch and updated PR #10.

- [ ] **Step 1: Build and verify the Notification plugin output**

Run: `node scripts/ce-plugin.mjs build kits/notifications/plugins/notification-center`

Run: `node scripts/ce-plugin.mjs check kits/notifications/plugins/notification-center`

- [ ] **Step 2: Run complete verification**

Run: `npm run check`

Expected: exit code 0 with all builds, tests, workflow checks, and plugin checks passing.

- [ ] **Step 3: Inspect repository state**

Run: `git status --short`, `git diff --check`, and inspect every staged file. Confirm no real user Skill directory was written.

- [ ] **Step 4: Request independent code review and fix all Critical/Important findings**

Review installer rollback, symlink handling, menu reachability, trusted source propagation, result feedback, and test isolation.

- [ ] **Step 5: Push and verify the existing pull request**

Push `feature/notification-kit`, confirm PR #10 remains open and points to the new head, and update its Summary/Testing sections with the menu installation flow and commands actually run.
