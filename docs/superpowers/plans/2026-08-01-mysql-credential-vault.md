# MySQL Local Credential Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Electron and explicitly loopback-only Web hosts remember MySQL passwords in the operating-system credential store without exposing saved secrets to Panels, other Kits, remote deployments, repository files, or application data.

**Architecture:** Add an immutable host credential mode, an application-owned SQLite metadata store plus native keyring adapter, and an owner-bound plugin runtime facade. `mysql-core` alone resolves opaque profile IDs inside the Server and continues to own every `mysql2` pool; the browser receives only non-secret metadata.

**Tech Stack:** TypeScript, Node.js, `better-sqlite3@12.10.1`, `@napi-rs/keyring@1.3.0`, Electron 43.2.0, Vitest, jsdom, npm workspaces.

## Global Constraints

- Implement in a new `feature/mysql-credential-vault` worktree, not on the docs branch.
- Web defaults to `off`; `local` requires every public listener to bind explicitly to `127.0.0.1` or `::1`; `multi-user` fails as unimplemented.
- Never infer mode from request addresses, Host, Forwarded, X-Forwarded-For, or an omitted bind address.
- Never persist passwords in SQLite, Session data, browser storage, logs, errors, URLs, snapshots, broadcasts, or fixtures.
- Never provide file, shell, CLI, environment-key, fixed-key, `basic_text`, or other fallback storage.
- Require both Kit permission `credentials` and plugin capability `credentials`; only `@itharbors/mysql-core` declares the capability.
- Use service `com.itharbors.credentials.v1` and account `<sha256(kitId + NUL + pluginName + NUL + local)>:<profileId>:<secretVersion>`.
- Saved secrets never return to a Panel. Never auto-connect on startup, Kit load, Panel mount, or profile selection.
- Follow TDD and use focused Chinese commit titles with the repository's exact tag convention.

## File Structure

- `packages/host-security/`: shared pure host-mode validation.
- `packages/plugin-types/src/credentials.ts`: profile, capability, and facade contracts.
- `packages/server/src/credentials/`: scope, keyring, SQLite state machine, errors, and vault orchestration.
- `packages/server/src/framework/plugin/`: capability parsing and facade injection.
- `packages/mysql-contracts/`: browser-safe saved-profile protocol.
- `kits/mysql/plugins/mysql-core/`: sole saved-secret consumer.
- `kits/mysql/plugins/mysql-explorer/panel.connection/`: manual/saved UI with no saved-secret state.
- Desktop build files: externalize, package, and unpack the N-API binary.

---

### Task 1: Add immutable credential mode and permission governance

**Files:**
- Create: `packages/host-security/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `tests/mode.test.ts`
- Create: `packages/plugin-types/src/credentials.ts`
- Modify: `packages/plugin-types/src/index.ts`
- Modify: `packages/kit-core/src/model.ts`, `packages/kit-core/tests/schema.test.ts`
- Modify: `packages/gateway/package.json`, `packages/gateway/src/index.ts`
- Create: `packages/gateway/src/security.ts`, `packages/gateway/tests/security.test.ts`
- Modify: `packages/server/package.json`, `packages/server/src/index.ts`, `packages/server/src/server.ts`
- Modify: `packages/server/tests/application/server-lifecycle.test.ts`
- Modify: `scripts/electron.mjs`, `scripts/lib/electron-launcher.test.mjs`
- Modify: `scripts/lib/kit-registry/resolver.mjs`, `scripts/lib/kit-registry/resolver.test.mjs`
- Modify: `scripts/lib/kit-registry/audit.test.mjs`, `scripts/lib/kit-publish/metadata.test.mjs`
- Modify: `scripts/lib/kit-manager-view.mjs`, `scripts/lib/kit-manager-view.test.mjs`
- Modify: `scripts/lib/build-tasks.mjs`, `package-lock.json`
- Modify: `package.json`

**Interfaces:**
- Produces `CredentialMode`, `resolveCredentialMode()`, `CredentialCapabilitySnapshot`, `CredentialProfile`, `PluginCredentialVault`, and permission `credentials`.
- Consumes `ApplicationHostMode`, process environment, and existing Registry permission projection.

- [ ] **Step 1: Write failing mode, startup, and permission tests**

```ts
expect(resolveCredentialMode({ hostMode: 'web', requested: undefined, bindHost: undefined })).toBe('off');
expect(resolveCredentialMode({ hostMode: 'desktop', requested: undefined, bindHost: '127.0.0.1' })).toBe('local');
expect(() => resolveCredentialMode({ hostMode: 'web', requested: 'local', bindHost: '0.0.0.0' })).toThrow(/loopback/i);
expect(() => resolveCredentialMode({ hostMode: 'web', requested: 'multi-user', bindHost: '127.0.0.1' })).toThrow(/not implemented/i);
expect(parseKitPackageManifest({ ...kitManifest, permissions: ['network', 'credentials'] }).permissions).toContain('credentials');
```

Also prove omitted bind addresses, forwarded headers, and loopback `remoteAddress` cannot enable local mode.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run test -w @itharbors/host-security && npm run test -w @itharbors/kit-core -- --run tests/schema.test.ts && npm run test -w @itharbors/gateway -- --run tests/security.test.ts`

Expected: FAIL because the workspace, resolver, permission, and guards do not exist.

- [ ] **Step 3: Implement the resolver and public types**

```ts
export type CredentialMode = 'off' | 'local' | 'multi-user';
export function resolveCredentialMode(input: { hostMode: 'desktop' | 'web'; requested?: string; bindHost?: string }): CredentialMode {
  const mode = input.requested ?? (input.hostMode === 'desktop' ? 'local' : 'off');
  if (mode === 'multi-user') throw new Error('multi-user credential mode is not implemented');
  if (mode !== 'off' && mode !== 'local') throw new Error('Invalid credential mode');
  if (mode === 'local' && input.bindHost !== '127.0.0.1' && input.bindHost !== '::1') throw new Error('Local credential mode requires explicit loopback');
  return mode;
}
```

Define `CredentialProfile`, `PluginCredentialVault` (including a reason-bearing `capability()` snapshot and compatible `available()` helper), and a capability snapshot exposing only mode/status/stable reason. Gateway and Server call the resolver before listening. Electron passes `HARBORS_CREDENTIAL_MODE: 'local'` beside its explicit loopback binding.
Add `npm run test -w @itharbors/host-security` to the root `test` script so `npm run check` cannot omit this invariant.

```ts
export type CredentialCapabilitySnapshot =
  | { mode: 'off' | 'local' | 'multi-user'; status: 'available' }
  | { mode: 'off' | 'local' | 'multi-user'; status: 'unavailable'; reason: 'CREDENTIALS_DISABLED' | 'CREDENTIALS_UNAVAILABLE' | 'CREDENTIALS_LOCKED' };
```

- [ ] **Step 4: Govern and display the permission**

```ts
export const KIT_PERMISSIONS = [
  'network', 'filesystem', 'native-code', 'process-control', 'application-startup', 'credentials',
] as const;
```

Make `credentials` official-publisher-only. Add label `凭据存储 — 高风险` and install notice `此版本可在系统凭据库中保存和使用登录秘密。`.
Extend publication metadata tests to prove `credentials` reaches signed Release and Registry projections unchanged. Extend audit tests to prove install/activation audit entries keep their existing fixed fields and never include profile metadata, permission details, account IDs, or secrets.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm run test -w @itharbors/host-security && npm run test -w @itharbors/kit-core && npm run test -w @itharbors/gateway && node --test scripts/lib/kit-registry/resolver.test.mjs scripts/lib/kit-manager-view.test.mjs scripts/lib/electron-launcher.test.mjs`

Commit:

```bash
git add packages/host-security packages/plugin-types packages/kit-core packages/gateway packages/server scripts/electron.mjs scripts/lib package-lock.json
git commit -m '[Feature] 增加本机凭据模式与权限治理'
```

### Task 2: Implement transactional metadata and native keyring storage

**Files:**
- Create: `packages/server/src/credentials/errors.ts`, `scope.ts`, `keyring.ts`, `store.ts`, `vault.ts`, `index.ts`
- Create: `packages/server/tests/credentials/scope.test.ts`, `store.test.ts`, `keyring.test.ts`, `vault.test.ts`
- Modify: `packages/server/package.json`, `package-lock.json`

**Interfaces:**
- Consumes `CredentialProfile` and `PluginCredentialVault`.
- Produces `CredentialVault.bind()`, `capability()`, `recover()`, `close()`, and injectable `KeyringAdapter`.

- [ ] **Step 1: Pin dependency and write failing identity/store tests**

Run: `npm install @napi-rs/keyring@1.3.0 --save-exact -w @itharbors/server`

```ts
expect(credentialScopeDigest('@itharbors/kit-mysql', '@itharbors/mysql-core')).toMatch(/^[a-f0-9]{64}$/u);
expect(credentialAccount(scope, profileId, secretVersion)).toBe(`${scope}:${profileId}:${secretVersion}`);
store.createPending({ scope, id, label: '生产库', metadata, secretVersion });
expect(store.listActive(scope)).toEqual([]);
```

Reject labels over 80 characters, metadata over 4096 UTF-8 bytes, nested values, invalid UUIDs, and reserved secret/scope keys.

- [ ] **Step 2: Implement identities and SQLite state machine**

```ts
export const CREDENTIAL_SERVICE = 'com.itharbors.credentials.v1';
export const credentialScopeDigest = (kitId: string, pluginName: string) =>
  createHash('sha256').update(`${kitId}\0${pluginName}\0local`, 'utf8').digest('hex');
export const credentialAccount = (scope: string, id: string, version: string) => `${scope}:${id}:${version}`;
```

Create `credential_profiles` with `pending|active|deleting` and `credential_secret_cleanup`. Add compare-and-swap activation/update, active list/get, mark-delete, cleanup, and recovery statements. Public rows omit scope/state/reference.

- [ ] **Step 3: Implement no-fallback keyring and stable errors**

```ts
export interface KeyringAdapter {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}
```

`createNativeKeyringAdapter()` lazily imports `@napi-rs/keyring` only in local mode, then wraps `new Entry(CREDENTIAL_SERVICE, account)`. Import/backend failure returns an unavailable vault so manual MySQL remains usable; mode `off` never imports the native module. Map failures only to `CREDENTIALS_DISABLED`, `CREDENTIALS_UNAVAILABLE`, `CREDENTIALS_LOCKED`, `CREDENTIAL_PROFILE_NOT_FOUND`, `CREDENTIAL_PROFILE_CONFLICT`, or `CREDENTIAL_OPERATION_FAILED`, with fixed Chinese messages and no native text. Do not invoke shell commands or add fallback adapters. Test Linux/no-service and missing-module behavior through injected loaders.

Probe backend health with a read-only `get` on a fixed reserved non-profile account. Never persist a health secret. Keep a loaded adapter after probe failure and retain the loader after import failure so capability checks can retry without restart; serialize concurrent probes and never probe/reopen after close begins.

- [ ] **Step 4: Test and implement transaction compensation/recovery**

```ts
const profile = await vault.put({ label: '生产库', metadata, secret: 'never-log-this' });
await expect(vault.get(profile.id)).resolves.toEqual({ profile, secret: 'never-log-this' });
const persisted = new Database(databasePath).prepare('SELECT * FROM credential_profiles').all();
expect(JSON.stringify(persisted)).not.toContain('never-log-this');
```

Inject failure at every keyring/SQLite boundary. New secret precedes activation; updates use a new version before pointer swap; deletion hides metadata before secret deletion; failed cleanup queues only an opaque account; recovery is idempotent. Serialize per `<scope,id>`.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test -w @itharbors/server -- --run tests/credentials`

```bash
git add packages/server/src/credentials packages/server/tests/credentials packages/server/package.json package-lock.json
git commit -m '[Feature] 实现系统凭据存储事务'
```

### Task 3: Inject an owner-bound facade into authorized plugins

**Files:**
- Modify: `packages/server/src/framework/plugin/types.ts`, `index.ts`
- Modify: `packages/server/src/framework/kit/types.ts`
- Modify: `packages/server/src/editor/types.ts`, `index.ts`
- Modify: `packages/server/src/server.ts`, `app.ts`
- Modify: `packages/server/src/application/types.ts`, `runtime.ts`
- Modify: `packages/server/tests/framework/plugin-runtime.test.ts`, `kit.test.ts`
- Modify: `packages/server/tests/application/runtime.test.ts`, `server-lifecycle.test.ts`

**Interfaces:**
- Consumes vault binding, host mode, Kit permission, and plugin capability.
- Produces optional `PluginRuntime.credentials`, `PluginInfo.capabilities`, `KitDescriptor.permissions`, and bootstrap credential status.

- [ ] **Step 1: Write failing four-gate isolation tests**

```ts
expect(mysqlCoreRuntime.credentials).toBeDefined();
expect(mysqlExplorerRuntime.credentials).toBeUndefined();
expect(offModeCoreRuntime.credentials).toBeUndefined();
await expect(mysqlCoreRuntime.credentials!.get(otherScopeProfileId)).rejects.toMatchObject({ code: 'CREDENTIAL_PROFILE_NOT_FOUND' });
```

Independently cover missing Kit permission, missing plugin capability, non-owner Kit, and mode off. Reject unknown/duplicate capabilities and Kit package/`kit.json` mismatches.

- [ ] **Step 2: Parse declarations and inject only explicit facades**

```ts
export type PluginCapability = 'credentials';
export type PluginLoadOptions =
  | { scope: 'session'; host: PluginRuntimeHost; credentials?: PluginCredentialVault }
  | { scope: 'application'; host: ApplicationPluginRuntimeHost };
```

Parse unique `ce-editor.capabilities`. Parse adjacent `kit.json`, require ID/package identity, and copy permissions to `KitDescriptor`. `PluginModule` never looks up a global vault; `createEditor` binds a facade only after all gates pass.

- [ ] **Step 3: Own vault lifecycle and bootstrap status**

```ts
const credentialVault = options.credentialVault
  ?? (credentialMode === 'local' ? createLocalCredentialVault({ dbPath }) : undefined);
```

Recover before listen, pass vault to Editors, expose only mode/status/reason in application bootstrap/events, dispose Sessions before closing the vault, and assert order in tests.

- [ ] **Step 4: Run tests and commit**

Run: `npm run test -w @itharbors/server -- --run tests/framework/plugin-runtime.test.ts tests/framework/kit.test.ts tests/application/runtime.test.ts tests/application/server-lifecycle.test.ts tests/credentials`

```bash
git add packages/server/src packages/server/tests/framework packages/server/tests/application
git commit -m '[Feature] 限制插件凭据访问边界'
```

### Task 4: Add saved profiles to MySQL contracts and core

**Files:**
- Modify: `packages/mysql-contracts/src/contracts.ts`, `index.ts`
- Modify: `kits/mysql/kit.json`
- Modify: `kits/mysql/plugins/mysql-core/package.json`
- Modify: `kits/mysql/plugins/mysql-core/main/src/protocol.ts`, `mysql-service.ts`, `index.ts`
- Modify: `kits/mysql/plugins/mysql-core/tests/protocol.test.ts`, `mysql-service.test.ts`, `plugin-main.test.ts`
- Modify: `kits/mysql/tests/kit-manifest.test.ts`

**Interfaces:**
- Consumes optional `runtime.credentials` and existing `MysqlService` lifecycle.
- Produces profile/capability types and connect/save/update/delete methods.

- [ ] **Step 1: Write failing contract, manifest, and core tests**

```ts
expect(kit.permissions).toEqual(['network', 'credentials']);
expect(corePackage['ce-editor'].capabilities).toEqual(['credentials']);
await core.connect(manualInput);
await core.saveCurrentConnection({ label: '本机开发库' });
expect(fakeVault.put).toHaveBeenCalledWith(expect.objectContaining({ secret: 'test-password' }));
expect(JSON.stringify(core.getConnectionState())).not.toContain('test-password');
```

Cover unavailable vault, save before success, failed connect, saved connect, missing secret, update rollback, active-delete ordering, stale IDs, and secret-free errors/broadcasts.

- [ ] **Step 2: Define exact browser-safe types and validators**

```ts
export type MysqlConnectionProfile = {
  id: string; label: string; host: string; port: number; user: string;
  database: string | null; tls: boolean; createdAt: string; updatedAt: string;
};
```

Add `profileId: string | null` to `ConnectionSnapshot`; validate exact metadata keys and bounded inputs. Keep mysql-contracts free of Node, DOM, keyring, and mysql2.

- [ ] **Step 3: Implement core operations without public secret state**

```ts
async function connectSaved(input: unknown) {
  const { profileId } = parseProfileIdInput(input);
  const { profile, secret } = await requireVault().get(profileId);
  const result = await callService('connect', connectionInputFromProfile(profile, secret));
  if (isErrorEnvelope(result)) return result;
  activeProfileId = profileId;
  return publishSuccessfulConnection(result);
}
```

Expose an internal active-input copy for post-success save only. Save after successful manual connect; update connects with a full new password before versioned vault update; delete disconnects first if active. Register the six new routes and declare `permissions: [network, credentials]` plus core capability.

Add these private helpers in `mysql-core/main/src/index.ts` so the names used above are fully defined:

```ts
function connectionInputFromProfile(profile: CredentialProfile, secret: string): ConnectionInput;
function publishSuccessfulConnection(result: ConnectionState, profileId: string | null): ConnectionSnapshot;
function requireVault(): PluginCredentialVault;
```

Define the structural `CredentialProfile` and `PluginCredentialVault` types inside mysql-core's local `Runtime` type from the shared contract shape; they are compile-time-only and must not add a runtime host-package dependency to the published Kit.

- [ ] **Step 4: Run tests and commit**

Run: `npm run test -w @itharbors/kit-mysql -- --run plugins/mysql-core/tests tests/kit-manifest.test.ts`

```bash
git add packages/mysql-contracts kits/mysql/kit.json kits/mysql/plugins/mysql-core kits/mysql/tests/kit-manifest.test.ts
git commit -m '[Feature] 支持 MySQL 保存连接凭据'
```

### Task 5: Build the manual/saved connection Panel

**Files:**
- Modify: `kits/mysql/plugins/mysql-explorer/panel.connection/src/index.ts`, `index.css`
- Modify: `kits/mysql/plugins/mysql-explorer/tests/connection-panel.test.ts`

**Interfaces:**
- Consumes Task 4 methods and `ConnectionSnapshot.profileId`.
- Produces manual/saved mode, selector, post-connect save, password update, confirmed delete, and unavailable fallback.

- [ ] **Step 1: Write failing DOM and interaction tests**

```ts
expect(document.querySelector('[data-connection-mode="manual"]')).not.toBeNull();
expect(document.querySelector('[data-connection-mode="saved"]')).not.toBeNull();
expect(document.querySelector('input[type="password"]')).toBeNull(); // saved mode
expect(document.body.textContent).not.toContain('test-password');
```

Test hydration, select-without-connect, explicit connect, manual save, save failure, update password, confirm/cancel delete, unavailable fallback, immediate clearing, and stale results.

- [ ] **Step 2: Add secret-free state and guarded hydration**

```ts
type SavedState = {
  capability: MysqlCredentialCapability | null;
  profiles: MysqlConnectionProfile[];
  selectedProfileId: string | null;
};
```

Hydrate connection/capability/profiles under the existing request-sequence and mount-generation guards. Never put saved passwords or placeholders into state, DOM, dataset, title, or accessible names.

- [ ] **Step 3: Render explicit accessible flows**

```html
<div class="connection-mode" role="tablist" aria-label="连接方式">
  <button data-connection-mode="manual" role="tab">手工连接</button>
  <button data-connection-mode="saved" role="tab">已保存连接</button>
</div>
```

Selection does not connect. Manual success exposes save+label. Update requires a complete new password. Delete confirms `将删除本机保存的连接和密码，是否继续？`. Unavailable mode keeps the manual form and hides save/profile controls. Add a single-column layout below 760px with visible focus.

- [ ] **Step 4: Run tests and commit**

Run: `npm run test -w @itharbors/kit-mysql -- --run plugins/mysql-explorer/tests/connection-panel.test.ts plugins/mysql-core/tests tests/kit-manifest.test.ts`

```bash
git add kits/mysql/plugins/mysql-explorer/panel.connection kits/mysql/plugins/mysql-explorer/tests/connection-panel.test.ts
git commit -m '[Feature] 增加 MySQL 已保存连接交互'
```

### Task 6: Package the native keyring in Electron

**Files:**
- Modify: `packages/desktop/package.json`
- Modify: `scripts/lib/desktop-build.mjs`, `desktop-build.test.mjs`
- Modify: `scripts/lib/desktop-package-build.mjs`, `desktop-package.test.mjs`
- Modify: `electron-builder.config.mjs`, `electron-builder.unsigned.config.mjs`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes exact `@napi-rs/keyring@1.3.0`.
- Produces Framework external import, packaged dependency closure, and unpacked `.node` files.

- [ ] **Step 1: Write failing packaging tests**

```js
assert.equal(desktopPackage.dependencies['@napi-rs/keyring'], '1.3.0');
assert.match(frameworkBundleConfig, /@napi-rs\/keyring/u);
assert.match(builderConfig, /node_modules\/@napi-rs\/.*\.node/u);
```

Fixture-build proof must show Darwin ARM64 keyring presence, external import, and unpacked native file; assert no shell helper/plaintext store.

- [ ] **Step 2: Add dependency, external, and unpack rules**

```json
"@napi-rs/keyring": "1.3.0"
```

Add `@napi-rs/keyring` to Framework esbuild externals and `node_modules/@napi-rs/**/*.node` to `asarUnpack`. Do not add it to Kit assets or electron-rebuild; retain the existing better-sqlite3 rebuild/restore cycle.

- [ ] **Step 3: Validate and commit**

Run: `npm run build:runtime && node --test scripts/lib/desktop-build.test.mjs scripts/lib/desktop-package.test.mjs && npm run desktop:prepare`

```bash
git add packages/desktop/package.json scripts/lib/desktop-build.mjs scripts/lib/desktop-build.test.mjs scripts/lib/desktop-package-build.mjs scripts/lib/desktop-package.test.mjs electron-builder.config.mjs electron-builder.unsigned.config.mjs package-lock.json
git commit -m '[Feature] 打包桌面系统凭据依赖'
```

### Task 7: Add leak regressions, docs, acceptance, and PR

**Files:**
- Create: `packages/server/tests/credentials/leak-regression.test.ts`
- Modify: `kits/mysql/tests/runtime-integration.test.ts`
- Modify: `kits/mysql/README.md`
- Modify: `docs/architecture/kit-and-session-model.md`
- Modify: `docs/guides/kit-artifacts.md`

**Interfaces:**
- Consumes Tasks 1-6.
- Produces repository-level security evidence and exact user/publisher documentation.

- [ ] **Step 1: Add end-to-end leak tests**

```ts
const secret = 'mysql-regression-secret-7d91';
const surfaces = await runCredentialScenario({ secret, databasePath, keyring: fakeKeyring, driver: fakeDriver });
expect(JSON.stringify(surfaces)).not.toContain(secret);
```

Define `runCredentialScenario(input): Promise<{ applicationBootstrap; sessionBootstrap; broadcasts; panelResponses; sqliteRows; capturedLogs }>` in the same test file. It must start a Server, create a MySQL Session, save, stop, restart with the same SQLite/keyring, reconnect, update, delete, and return every serializable surface. Add separate unavailable-backend and cross-Kit denial cases. Extend real integration only when `MYSQL_TEST_URL` exists.

- [ ] **Step 2: Run focused suites and document behavior**

Run: `npm run test -w @itharbors/host-security && npm run test -w @itharbors/kit-core && npm run test -w @itharbors/gateway && npm run test -w @itharbors/server && npm run test -w @itharbors/kit-mysql`

Document Web default-off, explicit local configuration, remote/multi-user disabled state, official-only permission/capability pairing, and non-exportable explicit saved connections.

- [ ] **Step 3: Perform browser acceptance**

```bash
npm run dev:web -- --kit ./kits/mysql
HARBORS_CREDENTIAL_MODE=local HARBORS_BIND_HOST=127.0.0.1 npm run dev:web -- --kit ./kits/mysql
HARBORS_CREDENTIAL_MODE=local HARBORS_BIND_HOST=0.0.0.0 npm run dev:web -- --kit ./kits/mysql
```

Verify manual-only default; local save/restart/reconnect/update/delete/unavailable/keyboard/narrow layout; invalid bind fails before listening.

- [ ] **Step 4: Perform mandatory Electron acceptance**

Run: `npm run dev -- --kit ./kits/mysql`

Verify the same flow, opaque OS credential entries, and absence of a unique secret from app data/logs. Electron is mandatory because native packaging changed.

- [ ] **Step 5: Run repository gate and commit tests/docs**

Run: `npm run check`; then inspect `git status --short`, `git diff --check`, `git diff`, and `git diff --cached`.

```bash
git add packages/server/tests/credentials/leak-regression.test.ts kits/mysql/tests/runtime-integration.test.ts kits/mysql/README.md docs/architecture/kit-and-session-model.md docs/guides/kit-artifacts.md
git commit -m '[Test] 完善 MySQL 凭据安全验收'
```

- [ ] **Step 6: Finish the feature branch**

Create a PR body outside the repository listing only checks that actually ran, then execute:

```bash
.agents/skills/change-workflow/scripts/finish-change.sh '增加 MySQL 本机安全凭据库' /tmp/harbors-mysql-credential-vault-pr.md
```

Before the command, use `apply_patch` to create `/tmp/harbors-mysql-credential-vault-pr.md` with `## Summary` and `## Testing`; list only checks evidenced by this execution.

Expected: clean worktree and verified `PR_URL=`. Report real MySQL as skipped unless `MYSQL_TEST_URL` output proves it ran.
