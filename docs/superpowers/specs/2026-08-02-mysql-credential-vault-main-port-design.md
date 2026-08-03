# MySQL Credential Vault Current-Main Port Design

## Context

PR #44 implements an approved local MySQL credential vault but forked before the Kit self-contained architecture landed on `main`. The replacement branch must preserve the reviewed security behavior while adopting current Framework and Kit ownership boundaries. It must not restore root-owned product-Kit contracts, dependencies, build tasks, or CI assumptions.

## Architecture

The host owns credential policy, metadata, native secret storage, and the privileged plugin facade. `mysql-core` receives only its owner-bound facade and continues to own every MySQL connection. Browser Panels receive capability state, opaque profile identifiers, and non-secret connection metadata only.

The native backend is `@itharbors/native-credential-vault`, a Harbors-owned macOS ARM64 Node-API module backed directly by Security.framework. Windows, Linux, and macOS x64 fail closed before loading a native binding. There is no file, shell, fixed-key, plaintext, environment-key, or third-party keyring fallback.

Current Framework application runtime construction owns the vault lifecycle. Current Kit boundaries own MySQL contracts, relationship-graph code, dependencies, and lockfile under `kits/mysql`; root build and package metadata contain only Framework/native-host dependencies.

## Data and security boundaries

- Web defaults to credential mode `off`.
- Mode `local` requires an explicit `127.0.0.1` or `::1` bind before listeners start.
- `multi-user` remains unsupported and fails before listen.
- SQLite stores labels and connection metadata but never passwords.
- Keychain accounts use opaque scope/profile/version identifiers and secrets never cross the Server-to-Panel boundary.
- Saved profiles never auto-connect; selection and connection remain explicit user actions.
- Backend locked, unavailable, denied, and operation-failed states map only to stable public codes and fixed Chinese messages.
- The desktop archive contains one controller-owned unpacked native binary and regular non-symlink wrapper entries.

## Migration strategy

1. Port host security and the native package unchanged where current-main ownership did not change.
2. Port Server vault/store/error code as independent units, then adapt lifecycle and plugin injection to current application runtime interfaces.
3. Apply MySQL contracts and behavior inside the self-contained Kit and regenerate `kits/mysql/package-lock.json` without adding Kit dependencies to the root lockfile.
4. Adapt root build, desktop staging, and package verification to the current Framework-only build graph.
5. Re-run unit, integration, browser, native Keychain, desktop directory package, and repository boundary checks.

## Acceptance

- Current-main `npm run check` passes.
- `npm run kits:boundary -- mysql` and MySQL Kit tests pass.
- Real macOS ARM64 Keychain write/read/delete covers non-empty and empty secrets with cleanup.
- Explicit loopback Web displays manual and saved connection modes; default Web remains manual-only.
- `npm run desktop:dir` passes the exact native closure and symlink verifier.
- No password sentinel appears in SQLite, browser surfaces, snapshots, broadcasts, logs, or packaged JavaScript.
- The replacement PR is open against `main`, has no merge conflicts, and supersedes PR #44.
