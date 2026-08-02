# MySQL Credential Vault Current-Main Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the reviewed MySQL local credential vault onto the current self-contained Kit architecture without weakening its security model.

**Architecture:** Keep credential policy, native storage, metadata, and privileged facade host-owned. Adapt their lifecycle to the current application runtime while moving every MySQL-specific contract and dependency into `kits/mysql` and preserving the exact desktop native trust root.

**Tech Stack:** Node.js 22.18+, TypeScript, Vitest, Node-API, Objective-C++/Security.framework, node-gyp 12.4.0, SQLite, Electron 43.2.0, npm workspaces and self-contained Kit lockfiles.

## Global Constraints

- Never merge, rebase, force-push, or replay the conflicting branch history.
- Every commit on `feature/mysql-credential-vault-main` uses `[Feature]`.
- Web `local` requires explicit `127.0.0.1` or `::1`; request headers and remote addresses never enable it.
- Passwords never enter SQLite, browser storage, URLs, snapshots, broadcasts, logs, fixtures, or packaged JavaScript.
- No fallback credential backend is permitted.
- Root metadata owns Framework/native-host dependencies; `kits/mysql` owns MySQL contracts, dependencies, and lockfile.

### Task 1: Host policy and native credential backend

**Files:** `packages/host-security/**`, `packages/native-credential-vault/**`, `packages/plugin-types/src/credentials.ts`, root package/build metadata.

- [x] Port host-mode and native contract tests and verify they fail because the current-main packages do not exist.
- [x] Port the minimal implementations and exact machine-code error mapping.
- [x] Integrate the native workspace into the Framework build/test graph without adding product Kit workspaces.
- [x] Run host-security and real native Keychain tests green.

### Task 2: Server vault and current application lifecycle

**Files:** `packages/server/src/credentials/**`, current application/runtime/editor/plugin interfaces, Server tests.

- [x] Port store, scope, keyring, and vault tests before implementation.
- [x] Port independent credential units and observe focused tests green.
- [x] Add failing current-runtime tests for application-owned vault construction, owner-bound facade injection, unload draining, and stable recovery state.
- [x] Adapt current application/editor/plugin lifecycle minimally and run the complete Server suite.

### Task 3: Self-contained MySQL Kit

**Files:** `kits/mysql/packages/contracts/**`, MySQL core/explorer/panels/tests, `kits/mysql/package.json`, `kits/mysql/package-lock.json`, Kit manifest and README.

- [x] Port contract, core, and Panel tests into the current Kit paths and verify the saved-profile behavior is missing.
- [x] Port protocol/core/UI behavior while retaining current-main Kit package conventions.
- [x] Regenerate only the MySQL Kit lockfile and prove root metadata has no MySQL product dependency.
- [x] Run MySQL tests and Kit architecture/boundary checks.

### Task 4: Gateway and desktop artifact trust root

**Files:** Gateway security, Electron launcher, builder config, desktop staging/verifier and tests.

- [x] Port loopback and package-verifier regression tests and verify their intended failures.
- [x] Adapt listener routing, desktop native build ordering, externalization, exact unpack closure, and ASAR non-link checks.
- [x] Run focused Gateway and desktop suites, then `npm run desktop:dir`.
- [x] Invoke the packaged native module for isolated write/read/delete smoke with cleanup.

### Task 5: Full acceptance and replacement PR

**Files:** user/security docs and this plan.

- [x] Complete browser acceptance for default-off and explicit-loopback local modes.
- [x] Run `npm run check`, MySQL boundary checks, leak regression, and `git diff --check`.
- [x] Mark this plan complete and commit the final reviewed tree.
- [ ] Push, create a conflict-free replacement PR against `main`, link it to #44, and close #44 only after the replacement PR is verified open.
