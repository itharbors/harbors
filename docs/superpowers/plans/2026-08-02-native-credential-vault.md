# Harbors 原生凭据适配器实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Harbors 自有的 macOS ARM64 Node-API 模块替换会吞掉系统错误并选择 fallback 的 `@napi-rs/keyring`，让 MySQL 凭据的读取、删除和能力探测具备可证明的失败语义。

**Architecture:** 新 workspace package `@itharbors/native-credential-vault` 用原始 Node-API 绑定 Security.framework Generic Password，并在 JavaScript loader 处对平台做白名单。Server 只消费三个窄函数并映射稳定机器错误；桌面构建只打包一个仓库自产 `.node` 文件，Linux CI 只走显式 unsupported 分支。

**Tech Stack:** Node.js 22.18+, Node-API, Objective-C++/C++, Security.framework, node-gyp 12.4.0, TypeScript, Vitest, Node test runner, Electron 43.2.0, npm workspaces.

## Global Constraints

- 首版唯一支持目标是 `darwin-arm64`；其他平台返回 `CREDENTIALS_UNAVAILABLE` 且不得加载本机后端。
- 原生边界只导出 `getPassword(service, account)`、`setPassword(service, account, secret)`、`deletePassword(service, account)`。
- 只有 Security.framework 的 item-not-found 能返回 `null` 或 `false`；其他 OSStatus 必须抛稳定机器代码。
- 不调用 shell 凭据命令，不提供 keyutils、文件、CLI、环境变量、固定密钥或 `basic_text` fallback。
- 不向 JavaScript、日志、HTTP、bootstrap 或 Panel 暴露原始 OSStatus、原生错误文本、secret、系统账户或路径。
- `off` 模式不得导入原生模块；手工 MySQL 连接在所有不支持或失败场景下保持可用。
- 每个行为变更先写测试并看到预期失败，再写最小实现。

---

### Task 1: 原生 workspace package 与 Keychain 合约

**Files:**
- Create: `packages/native-credential-vault/package.json`
- Create: `packages/native-credential-vault/index.cjs`
- Create: `packages/native-credential-vault/index.d.ts`
- Create: `packages/native-credential-vault/lib/loader.cjs`
- Create: `packages/native-credential-vault/binding.gyp`
- Create: `packages/native-credential-vault/src/status-code.h`
- Create: `packages/native-credential-vault/src/addon.mm`
- Create: `packages/native-credential-vault/tests/loader.test.cjs`
- Create: `packages/native-credential-vault/tests/status-code.test.mm`
- Create: `packages/native-credential-vault/tests/keychain-smoke.test.cjs`
- Create: `packages/native-credential-vault/scripts/test-status-code.cjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `getPassword(service: string, account: string): string | null`.
- Produces: `setPassword(service: string, account: string, secret: string): void`.
- Produces: `deletePassword(service: string, account: string): boolean`.
- Throws: `Error & { code: 'BACKEND_LOCKED' | 'BACKEND_UNAVAILABLE' | 'ACCESS_DENIED' | 'OPERATION_FAILED' }`.

- [x] **Step 1: Write failing loader and native contract tests**

`loader.test.cjs` must inject platform/arch/loadBinding and prove unsupported targets never invoke the binding loader, while `darwin-arm64` returns exactly the three functions. `status-code.test.mm` must assert these literal mappings:

```cpp
assert(classifySecurityStatus(errSecItemNotFound) == SecurityStatusClass::NotFound);
assert(classifySecurityStatus(errSecInteractionNotAllowed) == SecurityStatusClass::Locked);
assert(classifySecurityStatus(errSecNotAvailable) == SecurityStatusClass::Unavailable);
assert(classifySecurityStatus(errSecAuthFailed) == SecurityStatusClass::AccessDenied);
assert(classifySecurityStatus(-34018) == SecurityStatusClass::OperationFailed);
```

The smoke test must use a UUID account under `com.itharbors.credentials.test`, observe `null`, write a sentinel, read the same sentinel, delete with `true`, then observe `null` and delete with `false`; cleanup runs in `finally`.

- [x] **Step 2: Run tests and verify RED**

Run: `node --test packages/native-credential-vault/tests/loader.test.cjs packages/native-credential-vault/tests/keychain-smoke.test.cjs`

Expected: FAIL because the package loader and binding do not exist.

Run on macOS ARM64: `STATUS_TEST_DIR=$(mktemp -d) && c++ -std=c++20 -framework Security packages/native-credential-vault/tests/status-code.test.mm -o "$STATUS_TEST_DIR/status-code-test"`

Expected: FAIL because `src/status-code.h` does not exist.

- [x] **Step 3: Implement the platform loader and Node-API binding**

`createBindingLoader({ platform, arch, loadBinding })` must reject before `loadBinding` unless the target is exactly `darwin-arm64`. `addon.mm` must validate every argument as a JavaScript string, preserve embedded NUL bytes by using explicit UTF-8 lengths, release all Keychain/CF allocations, and implement:

```cpp
NAPI_MODULE_INIT() {
  napi_property_descriptor exports[] = {
    { "getPassword", nullptr, GetPassword, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setPassword", nullptr, SetPassword, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "deletePassword", nullptr, DeletePassword, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  napi_define_properties(env, exports, 3, exports);
  return exports;
}
```

Map Security.framework status without including numeric status or `SecCopyErrorMessageString` in the thrown error. `setPassword` must update an existing exact service/account item or add a new one. `deletePassword` returns `false` only when lookup reports `errSecItemNotFound`; deletion failure throws.

- [x] **Step 4: Add deterministic build/test scripts and dependencies**

Add exact `node-gyp@12.4.0` as a dev dependency of the native workspace. Its `build` script runs `node-gyp rebuild` only on `darwin-arm64`; unsupported platforms exit successfully without creating a binding. Its `test` script always runs loader tests and, on `darwin-arm64`, also builds, executes the C++ status test, and runs the real Keychain smoke test. Add the workspace test to the root `npm test` chain.

- [x] **Step 5: Verify GREEN**

Run: `npm test -w @itharbors/native-credential-vault`

Expected on macOS ARM64: loader, status mapping, and real Keychain smoke all PASS with the test entry removed.

- [x] **Step 6: Commit**

```bash
git add package.json package-lock.json packages/native-credential-vault
git commit -m "[Feature] 增加 macOS 系统凭据原生模块"
```

### Task 2: Server adapter replacement与事务语义

**Files:**
- Modify: `packages/server/package.json`
- Modify: `packages/server/src/credentials/keyring.ts`
- Modify: `packages/server/tests/credentials/keyring.test.ts`
- Modify: `packages/server/tests/credentials/vault.test.ts`
- Modify: `kits/mysql/tests/runtime-integration.test.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `@itharbors/native-credential-vault` three-function API from Task 1.
- Preserves: `KeyringAdapter.get/set/delete` used by `CredentialVault`.
- Produces: native machine-code mapping to public `CredentialErrorCode` without message inspection.

- [x] **Step 1: Write failing Server tests for production-shaped behavior**

Replace fake `Entry` classes with a complete fake module matching the three production exports. Assert:

```ts
await expect(adapter.get('missing')).resolves.toBeNull();
await expect(adapter.delete('missing')).resolves.toBeUndefined();
await expect(lockedAdapter.get('account')).rejects.toMatchObject({ code: 'CREDENTIALS_LOCKED' });
await expect(unavailableAdapter.set('account', 'secret')).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
await expect(deniedAdapter.delete('account')).rejects.toMatchObject({ code: 'CREDENTIAL_OPERATION_FAILED' });
```

Add a vault regression proving a thrown delete error leaves the record in `deleting` and therefore retryable; only native `false` (already absent) or `true` allows metadata removal. Update the opt-in real MySQL test to expect the full capability snapshot rather than `{ available: true }` only.

- [x] **Step 2: Run focused tests and verify RED**

Run: `npm test -w @itharbors/server -- --run tests/credentials/keyring.test.ts tests/credentials/vault.test.ts`

Expected: FAIL because Server still constructs `@napi-rs/keyring.Entry` and ignores the new function contract.

- [x] **Step 3: Implement the new adapter**

Change the default dynamic import to `@itharbors/native-credential-vault`. Delete message/name heuristics and accept only exact `error.code` values. Map `BACKEND_LOCKED` to `CREDENTIALS_LOCKED`, `BACKEND_UNAVAILABLE` to `CREDENTIALS_UNAVAILABLE`, and `ACCESS_DENIED`/`OPERATION_FAILED`/unknown to `CREDENTIAL_OPERATION_FAILED`. Treat only native `null`/`false` as absence.

- [x] **Step 4: Verify Server and MySQL suites GREEN**

Run: `npm test -w @itharbors/server`

Run: `npm test -w @itharbors/kit-mysql`

Expected: PASS; the real MySQL integration remains skipped unless `MYSQL_TEST_URL` is supplied.

- [x] **Step 5: Commit**

```bash
git add package-lock.json packages/server kits/mysql/tests/runtime-integration.test.ts
git commit -m "[Bug] 保留系统凭据失败语义"
```

### Task 3: 构建图与桌面制品信任根

**Files:**
- Modify: `package.json`
- Modify: `scripts/lib/build-tasks.mjs`
- Modify: `scripts/lib/build-tasks.test.mjs`
- Modify: `scripts/lib/desktop-build.mjs`
- Modify: `scripts/lib/desktop-build.test.mjs`
- Modify: `packages/desktop/package.json`
- Modify: `electron-builder.config.mjs`
- Modify: `scripts/lib/desktop-package-build.mjs`
- Modify: `scripts/lib/desktop-package.test.mjs`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: the native workspace package from Task 1.
- Produces: Framework external import `@itharbors/native-credential-vault`.
- Produces: exactly one unpacked artifact `node_modules/@itharbors/native-credential-vault/build/Release/harbors_native_credential_vault.node`.

- [x] **Step 1: Write failing build and package tests**

Update fixtures to model the internal package and a single native file. Assert the build graph makes Server depend on the native workspace package, macOS desktop preparation builds it before bundling, Framework externalizes the new package, and packaged verification rejects: old `@napi-rs/keyring` artifacts, extra `.node` files, symlinked package/binary paths, missing binary, malformed manifest, a packed rather than unpacked binary, and forbidden fallback markers.

- [x] **Step 2: Run focused tests and verify RED**

Run: `node --test scripts/lib/build-tasks.test.mjs scripts/lib/desktop-build.test.mjs scripts/lib/desktop-package.test.mjs`

Expected: FAIL because build and verifier still trust `@napi-rs/keyring` and its optional platform packages.

- [x] **Step 3: Replace dependencies and build wiring**

Remove every `@napi-rs/keyring*` runtime/lock entry. Add `@itharbors/native-credential-vault: 0.0.1` to Server and Desktop. Add the native workspace to the build universe and Server dependency graph. Its build command must always create its declared build directory; on unsupported targets it leaves an explicitly allowed empty native output, while on `darwin-arm64` the command itself verifies the expected `.node` file exists. Ensure `desktop:prepare` performs the macOS native build before `buildDesktop`; externalize the internal package in the Framework bundle.

- [x] **Step 4: Replace desktop verifier and asar rules**

Change `asarUnpack` and the verifier trust root from `node_modules/@napi-rs` to the exact internal package directory. Verify the manifest name/version/main, exact one-file native closure, regular non-symlink paths rooted under the controller-owned output, Framework external import, absence of old third-party keyring packages, and fallback-marker scans over application and wrapper JavaScript.

- [x] **Step 5: Verify focused build/package suites GREEN**

Run: `node --test scripts/lib/build-tasks.test.mjs scripts/lib/desktop-build.test.mjs scripts/lib/desktop-package.test.mjs`

Run: `npm run build`

Expected: PASS and Framework contains only the internal dynamic import.

- [x] **Step 6: Commit**

```bash
git add package.json package-lock.json packages/desktop electron-builder.config.mjs scripts/lib/build-tasks.mjs scripts/lib/build-tasks.test.mjs scripts/lib/desktop-build.mjs scripts/lib/desktop-build.test.mjs scripts/lib/desktop-package-build.mjs scripts/lib/desktop-package.test.mjs
git commit -m "[Bug] 固化自有凭据制品供应链"
```

### Task 4: 文档、泄露回归与完整验收

**Files:**
- Modify: `kits/mysql/README.md`
- Modify: `docs/superpowers/plans/2026-08-01-mysql-credential-vault.md`
- Modify: `packages/server/tests/credentials/leak-regression.test.ts`
- Modify: `.superpowers/sdd/2026-08-01-mysql-credential-vault/progress.md`

**Interfaces:**
- Consumes: Tasks 1-3 complete implementation.
- Produces: user-facing supported-platform documentation and final security evidence.

- [x] **Step 1: Extend leak regression before documentation edits**

Add assertions that repository runtime manifests, built Framework, packaged archive and unpacked tree contain no `@napi-rs/keyring`, raw OSStatus text, sentinel password, shell credential verbs, keyutils, fixed keys, or plaintext fallback. The test must inspect behavior/artifacts rather than merely grep a documentation string.

- [x] **Step 2: Run leak test and verify RED**

Run: `npm test -w @itharbors/server -- --run tests/credentials/leak-regression.test.ts`

Expected: FAIL while old dependency/build references remain. If Task 3 removal makes the test green immediately, add one fixture entry named `node_modules/@napi-rs/keyring/index.js`, run once to observe the exact forbidden-dependency failure, then remove that fixture entry and rerun green before committing.

- [x] **Step 3: Update user and implementation documentation**

Document macOS ARM64 support, explicit unsupported behavior elsewhere, no automatic fallback, and that both Electron and loopback Web use the same Node native adapter. Mark the superseded `@napi-rs/keyring` steps in the original implementation plan as replaced by this follow-up plan. Record the final review resolution in the ignored SDD ledger.

- [x] **Step 4: Run complete verification**

Run: `npm test -w @itharbors/native-credential-vault`

Run: `npm test -w @itharbors/server`

Run: `npm test -w @itharbors/kit-mysql`

Run: `node --test scripts/lib/build-tasks.test.mjs scripts/lib/desktop-build.test.mjs scripts/lib/desktop-package.test.mjs`

Run: `npm run check`

Run on macOS ARM64: `npm run desktop:dir`, then invoke the packaged module for a write/read/delete smoke and inspect Keychain/app SQLite/logs for sentinel absence.

Expected: all automated checks PASS; only the isolated Keychain entry contains the temporary secret during the smoke and it is deleted afterward.

- [x] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-08-01-mysql-credential-vault.md kits/mysql/README.md packages/server/tests/credentials/leak-regression.test.ts
git commit -m "[Test] 验证自有凭据适配器安全边界"
```
