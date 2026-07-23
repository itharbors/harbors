# Kit Marketplace Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the versioned Kit publication contract, deterministic `.hkit` tooling, compatibility filtering, transactional local Installed Kit Store, and installed-source Catalog integration required before a remote Registry or marketplace UI is added.

**Architecture:** Add a small `@itharbors/kit-core` package as the shared schema and compatibility authority. Add `@itharbors/kit-cli` to validate, pack, and inspect deterministic ZIP-based `.hkit` files. Electron owns a local Store and installer implemented in focused `.mjs` modules; Electron and Server receive the same active installed-source snapshot while independently revalidating each runtime manifest.

**Tech Stack:** Node.js 22.18, TypeScript 5.7, Vitest 2, Node test runner, `semver` 7.8.5, `yazl` 3.3.1, `yauzl` 3.4.0, npm workspaces.

## Global Constraints

- This plan implements only design phase 1; Registry networking, Kit Manager UI, GitHub Releases, `kit-workflow`, product branches, and built-in Kit removal remain incomplete after this plan.
- `schemaVersion` is exactly `1`; supported `kitApi` major is `1`; supported `protocolVersion` remains `1`.
- Runtime compatibility uses the Framework version, Kit API version, protocol version, `process.platform`, `process.arch`, and `process.versions.modules`.
- `.hkit` is a deterministic ZIP archive with no variable outer directory and a fixed entry timestamp of `1980-01-01T00:00:00.000Z`.
- Archive paths are POSIX relative paths. Absolute paths, `..`, empty segments, backslashes, NUL, symlinks, devices, duplicate entries, and case-folded duplicates are rejected.
- Archive limits are 10,000 entries, 512 MiB compressed input, 1 GiB total uncompressed data, and 256 MiB per entry.
- Installed versions are immutable. The key `(kit id, version)` may be reused only when its SHA-256 digest is identical.
- Install and activation are separate operations. Installing never changes `active`; activation preserves the old active version as `previous`.
- A failed pending version is recorded in `badVersions`; automatic retry is not part of phase 1.
- Built-in Kit package names and `menuRoot.id` values cannot be shadowed by installed Kits.
- Explicit `--kit <path>` remains a development-only source and is never written into the Installed Kit Store.
- No task removes the existing Default, SQLite, MySQL, or Notifications Kit from `main`.
- Every implementation task follows red-green-refactor, ends with focused verification, and uses a `[Feature]` Chinese commit title without a trailing period.

---

## File Structure

### New shared contract package

- `packages/kit-core/src/model.ts` — publication, release, runtime, installed-state, and source types.
- `packages/kit-core/src/schema.ts` — strict parsers for `kit.json`, `release.json`, and `installed.json`.
- `packages/kit-core/src/compatibility.ts` — reasoned compatibility checks and asset selection.
- `packages/kit-core/src/paths.ts` — archive path and encoded Kit ID rules.
- `packages/kit-core/src/index.ts` — public exports only.
- `packages/kit-core/tests/*.test.ts` — package contract tests.

### New CLI package

- `packages/kit-cli/src/cli.ts` — command parsing, exit codes, and stable user-facing output.
- `packages/kit-cli/src/kit-project.ts` — runtime Kit manifest validation and payload discovery.
- `packages/kit-cli/src/archive.ts` — deterministic ZIP write/read and archive safety limits.
- `packages/kit-cli/src/checksums.ts` — SHA-256 and canonical JSON helpers.
- `packages/kit-cli/src/sbom.ts` — deterministic minimal SPDX 2.3 document generation.
- `packages/kit-cli/src/index.ts` — programmatic `validateKit`, `packKit`, and `inspectKit` exports.
- `packages/kit-cli/tests/*.test.ts` and `packages/kit-cli/tests/fixtures/minimal-kit/**` — CLI and archive tests.

### New desktop Store modules

- `scripts/lib/kit-store/state.mjs` — atomic state persistence and state transitions.
- `scripts/lib/kit-store/archive.mjs` — bounded extraction and internal checksum verification.
- `scripts/lib/kit-store/installer.mjs` — local-file install transaction and compatibility gate.
- `scripts/lib/kit-store/*.test.mjs` — Node test coverage.

### Catalog integration

- `scripts/lib/kit-catalog.mjs` — merge built-in, installed, and explicit sources.
- `scripts/electron.mjs` — open the Store, resolve active sources, and pass the immutable snapshot to Server.
- `packages/server/src/assembly/config.ts` — add `installedKitDirs` to assembly.
- `packages/server/src/assembly/kit-catalog.ts` — catalog installed directories with source metadata.
- `packages/server/src/application/catalog.ts` — include installed Kit startup declarations.
- `packages/server/src/plugin/resolver.ts` — resolve Kit names against active installed directories.
- `packages/server/src/index.ts` and `scripts/electron.mjs` — serialize/parse `HARBORS_INSTALLED_KITS`.

---

### Task 1: Add strict Kit publication schemas

**Files:**
- Create: `packages/kit-core/package.json`
- Create: `packages/kit-core/tsconfig.json`
- Create: `packages/kit-core/vitest.config.ts`
- Create: `packages/kit-core/src/model.ts`
- Create: `packages/kit-core/src/schema.ts`
- Create: `packages/kit-core/src/paths.ts`
- Create: `packages/kit-core/src/index.ts`
- Create: `packages/kit-core/tests/schema.test.ts`
- Create: `packages/kit-core/tests/paths.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `parseKitPackageManifest(value)`, `parseReleaseManifest(value)`, `parseInstalledKitState(value)`, `normalizeArchivePath(value)`, and `encodeKitId(id)` from `@itharbors/kit-core`.
- Produces: exact publication model types consumed by all later tasks.

- [ ] **Step 1: Create package metadata and install exact dependencies**

Run:

```bash
npm install semver@7.8.5 -w packages/kit-core
npm install -D @types/semver@7.7.1 -w packages/kit-core
```

Create `packages/kit-core/package.json` with `build` and `test` scripts matching other TypeScript workspaces, and add `@itharbors/kit-core` before Server in root `build` and `test` scripts.

Expected: `package-lock.json` contains a workspace entry for `packages/kit-core`; `npm run build -w @itharbors/kit-core` initially fails because source files do not exist.

- [ ] **Step 2: Write failing schema tests**

Create tests covering a complete stable manifest, preview SemVer, malformed IDs, unsupported schema versions, unknown permission names, missing `nodeAbi` for native targets, release asset uniqueness, invalid SHA-256, and corrupt installed state. Use these canonical objects:

```ts
const kitManifest = {
  schemaVersion: 1,
  id: '@example/kit-demo',
  version: '1.2.3',
  channel: 'stable',
  publisher: 'example',
  requires: {
    harbors: '>=1.0.0 <2.0.0',
    kitApi: '>=1.0.0 <2.0.0',
    protocolVersion: 1,
  },
  target: { platform: 'any', arch: 'any' },
  permissions: ['network'],
  entry: 'package.json',
};

const releaseManifest = {
  schemaVersion: 1,
  id: kitManifest.id,
  version: kitManifest.version,
  channel: kitManifest.channel,
  publisher: kitManifest.publisher,
  source: {
    repository: 'itharbors/kit-demo',
    commit: '0123456789abcdef0123456789abcdef01234567',
    workflow: 'itharbors/workflows/.github/workflows/publish-kit.yml@refs/tags/kit-publish-v1',
  },
  assets: [{
    name: 'demo-1.2.3-any-any.hkit',
    url: 'https://example.test/demo-1.2.3-any-any.hkit',
    sha256: 'a'.repeat(64),
    size: 123,
    manifest: kitManifest,
  }],
};
```

Run:

```bash
npm run test -w @itharbors/kit-core
```

Expected: FAIL because `parseKitPackageManifest` and companion exports are missing.

- [ ] **Step 3: Implement the exact public models**

Define these exported discriminants and types in `model.ts`:

```ts
export const KIT_PACKAGE_SCHEMA_VERSION = 1 as const;
export const KIT_API_VERSION = '1.0.0' as const;
export const KIT_PERMISSIONS = [
  'network', 'filesystem', 'native-code', 'application-startup',
] as const;

export type KitChannel = 'stable' | 'preview';
export type KitPermission = typeof KIT_PERMISSIONS[number];
export type KitPlatform = 'any' | 'darwin' | 'linux' | 'win32';
export type KitArchitecture = 'any' | 'arm64' | 'x64';

export interface KitTarget {
  platform: KitPlatform;
  arch: KitArchitecture;
  nodeAbi?: string;
}

export interface KitRequirements {
  harbors: string;
  kitApi: string;
  protocolVersion: number;
}

export interface KitPackageManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  channel: KitChannel;
  publisher: string;
  requires: KitRequirements;
  target: KitTarget;
  permissions: KitPermission[];
  entry: 'package.json';
}

export interface ReleaseAsset {
  name: string;
  url: string;
  sha256: string;
  size: number;
  manifest: KitPackageManifest;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  channel: KitChannel;
  publisher: string;
  source: { repository: string; commit: string; workflow: string };
  assets: ReleaseAsset[];
}

export interface InstalledKitVersion {
  version: string;
  directory: string;
  digest: string;
  source: { publisher: string; repository: string; commit: string };
  installedAt: string;
}

export interface InstalledKitRecord {
  active?: string;
  previous?: string;
  pending?: string;
  channel: KitChannel;
  autoUpdate: boolean;
  versions: Record<string, InstalledKitVersion>;
  badVersions: string[];
}

export interface InstalledKitState {
  schemaVersion: 1;
  kits: Record<string, InstalledKitRecord>;
}
```

- [ ] **Step 4: Implement strict parsers and path rules**

In `schema.ts`, build parsers from small assertions (`record`, `string`, `enumValue`, `positiveInteger`, `sha256`, `semverValue`, `semverRange`) and reject unknown top-level fields. Enforce:

```ts
if (target.platform === 'any' || target.arch === 'any') {
  if (target.platform !== 'any' || target.arch !== 'any' || target.nodeAbi !== undefined) {
    throw new Error('any target must use platform=any, arch=any, and omit nodeAbi');
  }
} else if (permissions.includes('native-code') && !target.nodeAbi) {
  throw new Error('native-code target requires nodeAbi');
}
```

In `paths.ts`, use `path.posix.normalize` only after rejecting backslashes and NUL, then require the normalized value to equal the input and every segment to be non-empty, non-dot, and non-`..`. Encode Kit IDs with `Buffer.from(id, 'utf8').toString('base64url')`; reject an empty ID.

- [ ] **Step 5: Run package tests and build**

Run:

```bash
npm run test -w @itharbors/kit-core
npm run build -w @itharbors/kit-core
```

Expected: all Kit Core tests pass and `packages/kit-core/dist/index.js` plus declarations exist.

- [ ] **Step 6: Review and commit**

Run `git diff --check`, inspect status and staged diff, stage only Task 1 files, then commit:

```bash
git commit -m '[Feature] 定义 Kit 发布协议与状态模型'
```

---

### Task 2: Add compatibility reasoning and deterministic asset selection

**Files:**
- Create: `packages/kit-core/src/compatibility.ts`
- Create: `packages/kit-core/tests/compatibility.test.ts`
- Modify: `packages/kit-core/src/index.ts`

**Interfaces:**
- Consumes: `KitPackageManifest`, `ReleaseManifest`, and `ReleaseAsset` from Task 1.
- Produces: `checkKitCompatibility(manifest, runtime): CompatibilityResult` and `selectCompatibleAsset(release, runtime): ReleaseAsset`.

- [ ] **Step 1: Write failing reason-code tests**

Use this runtime fixture:

```ts
const runtime = {
  harborsVersion: '1.4.0',
  kitApiVersion: '1.2.0',
  protocolVersion: 1,
  platform: 'darwin',
  arch: 'arm64',
  nodeAbi: '127',
};
```

Cover exact reason codes `HARBORS_INCOMPATIBLE`, `KIT_API_INCOMPATIBLE`, `PROTOCOL_INCOMPATIBLE`, `PLATFORM_INCOMPATIBLE`, `ARCH_INCOMPATIBLE`, and `NODE_ABI_INCOMPATIBLE`. Unsupported schema versions are rejected by Task 1 before compatibility evaluation. Cover universal asset fallback, exact native target preference, no compatible asset, and ambiguous duplicate compatible assets.

Run `npm run test -w @itharbors/kit-core`; expect FAIL because compatibility exports are absent.

- [ ] **Step 2: Implement compatibility checks**

Define:

```ts
export interface KitRuntimeIdentity {
  harborsVersion: string;
  kitApiVersion: string;
  protocolVersion: number;
  platform: string;
  arch: string;
  nodeAbi: string;
}

export type CompatibilityReason =
  | 'HARBORS_INCOMPATIBLE'
  | 'KIT_API_INCOMPATIBLE'
  | 'PROTOCOL_INCOMPATIBLE'
  | 'PLATFORM_INCOMPATIBLE'
  | 'ARCH_INCOMPATIBLE'
  | 'NODE_ABI_INCOMPATIBLE';

export type CompatibilityResult =
  | { compatible: true }
  | { compatible: false; reason: CompatibilityReason; message: string };
```

Use `semver.satisfies(version, range, { includePrerelease: true })`. Evaluate checks in the reason-code order above. A universal target matches only when both platform and arch are `any`; an exact target must match platform and arch and, when present, `nodeAbi`.

- [ ] **Step 3: Implement asset selection**

Filter assets with `checkKitCompatibility`, prefer an exact target over `any-any`, and throw stable errors:

```ts
if (compatible.length === 0) {
  throw new Error(`No compatible asset for ${release.id}@${release.version}`);
}
if (best.length !== 1) {
  throw new Error(`Ambiguous compatible assets for ${release.id}@${release.version}`);
}
return best[0];
```

- [ ] **Step 4: Verify and commit**

Run package test/build, inspect diffs, and commit:

```bash
git commit -m '[Feature] 支持 Kit 运行环境兼容性选择'
```

---

### Task 3: Validate Kit projects and discover publishable payloads

**Files:**
- Create: `packages/kit-cli/package.json`
- Create: `packages/kit-cli/tsconfig.json`
- Create: `packages/kit-cli/vitest.config.ts`
- Create: `packages/kit-cli/src/kit-project.ts`
- Create: `packages/kit-cli/src/checksums.ts`
- Create: `packages/kit-cli/src/sbom.ts`
- Create: `packages/kit-cli/src/index.ts`
- Create: `packages/kit-cli/tests/kit-project.test.ts`
- Create: `packages/kit-cli/tests/fixtures/minimal-kit/kit.json`
- Create: `packages/kit-cli/tests/fixtures/minimal-kit/package.json`
- Create: `packages/kit-cli/tests/fixtures/minimal-kit/layout.json`
- Create: `packages/kit-cli/tests/fixtures/minimal-kit/main.html`
- Create: `packages/kit-cli/tests/fixtures/minimal-kit/secondary.html`
- Create: `packages/kit-cli/tests/fixtures/minimal-kit/plugins/demo/package.json`
- Create: `packages/kit-cli/tests/fixtures/minimal-kit/plugins/demo/main/dist/index.js`
- Create: `packages/kit-cli/tests/fixtures/minimal-kit/plugins/demo/panel.main/dist/index.html`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Task 1 parsers and path functions.
- Produces: `validateKit(directory): Promise<ValidatedKitProject>`, `canonicalJson(value)`, `sha256File(path)`, `buildSpdx(project)`.

- [ ] **Step 1: Create the CLI workspace**

Run:

```bash
npm install @itharbors/kit-core@0.0.1 -w packages/kit-cli
npm install yazl@3.3.1 yauzl@3.4.0 -w packages/kit-cli
npm install -D @types/yazl@3.3.1 @types/yauzl@3.4.0 -w packages/kit-cli
```

Create package scripts `build` and `test`, `bin: { "harbors-kit": "./dist/cli.js" }`, and add Kit CLI after Kit Core in root build/test scripts.

- [ ] **Step 2: Write failing project validation tests**

The valid fixture declares `@example/kit-demo` with plugin `@example/demo`. Tests must assert the returned payload contains only:

```text
kit.json
package.json
layout.json
main.html
secondary.html
plugins/demo/package.json
plugins/demo/main/dist/index.js
plugins/demo/panel.main/dist/index.html
```

Add failing cases for mismatched Kit ID/version, missing shell file, source-only main entry, undeclared plugin, duplicate plugin package name, plugin outside one-level `plugins/*`, public asset escape, source/test directory leakage, and a symbolic link anywhere in selected payload.

Run `npm run test -w @itharbors/kit-cli`; expect FAIL because `validateKit` is missing.

- [ ] **Step 3: Implement runtime manifest validation**

`validateKit` must:

1. Resolve and realpath the Kit directory.
2. Parse `kit.json` with `parseKitPackageManifest` and runtime `package.json` as an object.
3. Require package `name === kit.id` and package `version === kit.version`.
4. Reuse the current Kit shell rules: non-empty `menuRoot.id/label`, `layouts.default`, both window entries, unique plugin lists, and no startup/ordinary overlap.
5. Resolve each declared plugin by scanning only one-level `plugins/*/package.json` and matching package name.
6. Require every main and Panel entry to point into a `dist` directory and exist as a regular file.
7. Include declared public asset roots, rejecting any realpath outside the plugin directory.
8. Include root `node_modules` when present, but reject symlinks instead of following workspace links.

Return:

```ts
export interface PayloadFile {
  absolutePath: string;
  archivePath: string;
  size: number;
}

export interface ValidatedKitProject {
  directory: string;
  manifest: KitPackageManifest;
  runtimeManifest: Record<string, unknown>;
  payload: PayloadFile[];
  packageNames: string[];
}
```

Sort payload by `archivePath` and reject case-folded duplicate paths.

- [ ] **Step 4: Implement canonical metadata helpers**

`canonicalJson` recursively sorts object keys, preserves array order, serializes with two-space indentation, and appends one newline. `sha256File` streams the file. `buildSpdx` emits SPDX 2.3 JSON with stable namespace `https://itharbors.dev/spdx/<encoded-id>/<version>/<payload-digest>` and packages sorted by package name.

- [ ] **Step 5: Verify and commit**

Run Kit Core and Kit CLI tests/builds, inspect exact files, and commit:

```bash
git commit -m '[Feature] 校验并收集 Kit 发布内容'
```

---

### Task 4: Pack and inspect deterministic `.hkit` archives

**Files:**
- Create: `packages/kit-cli/src/archive.ts`
- Create: `packages/kit-cli/src/cli.ts`
- Create: `packages/kit-cli/tests/archive.test.ts`
- Create: `packages/kit-cli/tests/cli.test.ts`
- Modify: `packages/kit-cli/src/index.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `ValidatedKitProject`, canonical JSON, and SHA helpers from Task 3.
- Produces: `packKit({ directory, output }): Promise<PackedKit>`, `inspectKit({ archive }): Promise<InspectedKit>`, and CLI commands `validate`, `pack`, and `inspect`.

- [ ] **Step 1: Write failing deterministic archive tests**

Cover:

- Packing the same fixture twice produces identical SHA-256 bytes.
- Entries are lexicographically ordered and use fixed timestamp/mode.
- `checksums.json` lists every payload file plus `sbom.spdx.json`, excluding itself.
- `inspectKit` returns the parsed `kit.json`, file count, compressed size, uncompressed size, and archive SHA-256.
- Duplicate path, case-folded duplicate, absolute path, `../`, backslash, NUL, symlink Unix mode, oversized entry, too many entries, and uncompressed total overflow are rejected.
- A changed payload byte causes internal checksum verification to fail.

Run `npm run test -w @itharbors/kit-cli`; expect FAIL because archive functions are missing.

- [ ] **Step 2: Implement deterministic packing**

Use `yazl.ZipFile`; add payload files in sorted order with:

```ts
const ZIP_DATE = new Date('1980-01-01T00:00:00.000Z');
zip.addFile(file.absolutePath, file.archivePath, {
  mtime: ZIP_DATE,
  mode: 0o100644,
  compress: true,
});
```

Generate `sbom.spdx.json` first, calculate payload checksums, then add canonical `checksums.json`. Write to `<output>.tmp-<pid>-<sequence>`, wait for the output stream to close, calculate the archive digest, and atomically rename. On failure close streams and remove the temporary file.

Return:

```ts
export interface PackedKit {
  id: string;
  version: string;
  output: string;
  sha256: string;
  size: number;
  files: number;
}
```

- [ ] **Step 3: Implement bounded inspection**

Open with `yauzl.open(path, { lazyEntries: true, autoClose: true })`. Before reading entry data, apply all Global Constraint limits and reject Unix symlink/device mode from `externalFileAttributes >>> 16`. Buffer only metadata files (`kit.json`, `checksums.json`, `sbom.spdx.json`) and hash all other entries as streams. Require exactly one of each metadata file and compare every observed payload entry with `checksums.json`.

- [ ] **Step 4: Add CLI behavior**

Implement exact forms:

```text
harbors-kit validate <kit-directory>
harbors-kit pack <kit-directory> --output <file.hkit>
harbors-kit inspect <file.hkit> [--json]
```

Success output is stable `KEY=value` lines for `validate`/`pack`; `inspect --json` emits canonical JSON. Usage errors exit 2, validation/archive errors exit 1, and success exits 0. Add root scripts:

```json
"kit": "node packages/kit-cli/dist/cli.js",
"kits:validate": "npm run kit -- validate"
```

- [ ] **Step 5: Verify and commit**

Run package tests/build and two real commands against the fixture; inspect the archive twice and compare SHA-256. Commit:

```bash
git commit -m '[Feature] 支持确定性封装与检查 Kit 制品'
```

---

### Task 5: Install local artifacts transactionally and manage activation state

**Files:**
- Create: `scripts/lib/kit-store/state.mjs`
- Create: `scripts/lib/kit-store/archive.mjs`
- Create: `scripts/lib/kit-store/installer.mjs`
- Create: `scripts/lib/kit-store/state.test.mjs`
- Create: `scripts/lib/kit-store/archive.test.mjs`
- Create: `scripts/lib/kit-store/installer.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: built `@itharbors/kit-core`, `yauzl`, and `.hkit` files produced by Task 4.
- Produces: `InstalledKitStore` and `KitArtifactInstaller` for Electron integration.

- [ ] **Step 1: Declare the desktop runtime dependencies**

Run from the repository root:

```bash
npm install @itharbors/kit-core@0.0.1 yauzl@3.4.0
npm install -D @types/yauzl@3.4.0
```

Expected: root `package.json` declares the Store's direct runtime dependency instead of relying on workspace hoisting, and `package-lock.json` remains reproducible.

- [ ] **Step 2: Write failing state-machine tests**

Cover empty/corrupt state recovery, atomic file replacement, serialized concurrent mutations, immutable same-version digest, install without activation, first activation, update activation preserving previous, rollback swapping active/previous, pending state, `markBad` clearing matching pending, duplicate bad-version suppression, and missing-version rejection.

Use this public surface:

```js
const store = new InstalledKitStore(storeRoot, { now: () => '2026-07-23T00:00:00.000Z' });
await store.recordInstalled({ id, version, directory, digest, source, channel });
await store.setPending(id, version);
await store.activate(id, version);
await store.rollback(id);
await store.markBad(id, version);
await store.snapshot();
await store.listActiveSources();
```

Run the focused Node test; expect FAIL because the module is missing.

- [ ] **Step 3: Implement atomic Store persistence**

Use one promise mutation queue per Store instance. State file is `<storeRoot>/installed.json`; persist canonical JSON with mode `0o600`, open and `sync()` the temporary file, rename in the same directory, then open and sync the parent directory where supported. Never interpret a corrupt state as valid installed data: rename corrupt content to `installed.json.corrupt-<timestamp>` and start from an empty schema-1 state.

`listActiveSources()` returns only records whose active version exists:

```js
{
  id,
  version: active,
  directory: versionRecord.directory,
  digest: versionRecord.digest,
  source: 'installed',
}
```

- [ ] **Step 4: Write failing extraction and installer tests**

Create a valid artifact with Task 4, then cover outer size/digest mismatch, incompatible runtime, malicious archive paths/modes, internal checksum mismatch, interrupted staging, existing same digest idempotence, existing different digest rejection, successful install directory, and cleanup of downloads/staging after each outcome.

The installer input is not a URL:

```js
await installer.installFromFile({
  archivePath,
  expected: {
    id: '@example/kit-demo',
    version: '1.2.3',
    sha256,
    size,
    publisher: 'example',
    repository: 'example/kit-demo',
    commit: '0123456789abcdef0123456789abcdef01234567',
  },
});
```

- [ ] **Step 5: Implement safe extraction and installation**

`extractVerifiedArchive` repeats Task 4 archive checks while streaming each regular file into staging with exclusive creation and mode `0o600`. It creates directories itself, never trusts directory entries, and compares internal checksums before success.

`KitArtifactInstaller.installFromFile` performs:

```text
stat and whole-file SHA-256
-> inspect manifest
-> compare expected identity
-> checkKitCompatibility
-> extract to unique staging directory
-> revalidate runtime package.json name/version/ce-editor.kit
-> rename staging to kits/<encoded-id>/<version>
-> recordInstalled
```

If the destination exists, compare the recorded digest and return idempotent success only when identical. Any failure removes only the unique staging directory; it never recursively removes Store root, Kit ID root, or an active version.

- [ ] **Step 6: Add Store tests to the root suite and commit**

Append the three exact Node test files to the existing root `npm test` Node test command. Run them plus Kit CLI/Core tests, inspect diffs, and commit:

```bash
git commit -m '[Feature] 支持 Kit 本地事务安装与版本回滚'
```

---

### Task 6: Merge installed Kit sources into Electron and Server Catalogs

**Files:**
- Modify: `scripts/lib/kit-catalog.mjs`
- Modify: `scripts/lib/kit-catalog.test.mjs`
- Modify: `scripts/electron.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`
- Modify: `packages/server/src/assembly/config.ts`
- Modify: `packages/server/src/assembly/kit-catalog.ts`
- Modify: `packages/server/src/application/catalog.ts`
- Modify: `packages/server/src/plugin/resolver.ts`
- Modify: `packages/server/src/editor/index.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/tests/assembly/config.test.ts`
- Modify: `packages/server/tests/assembly/kit-catalog.test.ts`
- Modify: `packages/server/tests/application/catalog.test.ts`
- Modify: `packages/server/tests/plugin/resolver.test.ts`
- Modify: `packages/server/tests/integration/integration.test.ts`

**Interfaces:**
- Consumes: `InstalledKitStore.listActiveSources()` from Task 5.
- Produces: a deterministic Catalog containing built-in and active installed sources; passes the same installed directory snapshot to Server via `HARBORS_INSTALLED_KITS`.

- [ ] **Step 1: Write failing Electron Catalog tests**

Extend `discoverKits` input to:

```js
discoverKits({
  rootDir,
  requestedKit,
  installedKits: [{
    id: '@example/kit-installed',
    version: '1.0.0',
    directory: installedDirectory,
    digest: 'a'.repeat(64),
    source: 'installed',
  }],
});
```

Assert installed entries appear in label order with `source: 'installed'` and `version`; built-ins use `source: 'builtin'`. Assert package-name/menu-root collisions, mismatched installed source ID/version, missing directories, and installed attempts to shadow a built-in are rejected. Explicit external paths use `source: 'explicit'` and may not shadow either source.

Run `node --test scripts/lib/kit-catalog.test.mjs`; expect FAIL on the new cases.

- [ ] **Step 2: Implement Electron source merging**

Extract one shared `readKitEntry(directory, source)` path in `kit-catalog.mjs`. Validate installed `kit.json` with `parseKitPackageManifest`, require the source ID/version/digest to match, then parse runtime `package.json`. Built-ins keep the runtime package version; explicit paths use their runtime version. Run uniqueness checks after all sources are combined; no precedence-based overwrite.

- [ ] **Step 3: Write failing Server assembly tests**

Add `installedKitDirs: string[]` to expected assembly values. Cover installed discovery, resolver by package name, installed startup plugin discovery, duplicate rejection against built-ins, and an integration session created with an installed package name.

Run focused Server tests; expect TypeScript or assertion failures because assembly does not yet accept installed directories.

- [ ] **Step 4: Implement Server installed-source snapshot**

Change `AssemblyConfig` to include:

```ts
installedKitDirs: string[];
```

Default it to `[]` and clone arrays during normalization. Update every Kit directory enumeration and `resolveKit` context to include only these explicit active directories. Never scan the Store root or version directories. `discoverKitCatalog` returns `source: 'builtin' | 'installed' | 'explicit'` internally while `/api/kits` continues to project only `id`, `name`, and `label`.

In `packages/server/src/index.ts`, parse `HARBORS_INSTALLED_KITS` as a JSON array of non-empty absolute paths; invalid JSON or relative paths must fail startup with a stable message.

- [ ] **Step 5: Wire Electron to Store and Server**

After `app.whenReady`, create:

```js
kitStore = new InstalledKitStore(path.join(app.getPath('userData'), 'kit-store'));
const installedKits = await kitStore.listActiveSources();
```

Pass `installedKits` into `discoverKits` and add this framework environment variable:

```js
HARBORS_INSTALLED_KITS: JSON.stringify(installedKits.map((kit) => kit.directory)),
```

Do not add download or mutation IPC in phase 1. Installed changes become visible on the next desktop start.

- [ ] **Step 6: Verify Catalog parity and commit**

Run Electron Catalog/launcher tests, focused Server assembly/application/resolver/integration tests, and TypeScript checks. Commit:

```bash
git commit -m '[Feature] 将已安装 Kit 接入统一运行目录'
```

---

### Task 7: Document the phase-1 operator flow and verify the whole repository

**Files:**
- Modify: `readme.md`
- Modify: `docs/architecture/kit-and-session-model.md`
- Modify: `docs/guides/developing-plugins-and-kits.md`
- Create: `docs/guides/kit-artifacts.md`
- Modify: `docs/README.md`

**Interfaces:**
- Consumes: all phase-1 commands and runtime behavior.
- Produces: accurate operator commands and explicit phase-1 limitations.

- [ ] **Step 1: Add documentation contract tests where existing tests assert commands**

Extend `scripts/lib/ci-workflow.test.mjs` or add `scripts/lib/kit-docs.test.mjs` to assert root scripts expose `kit`, Kit artifacts docs mention `validate`, `pack`, and `inspect`, and no phase-1 document claims Registry download/UI/GitHub publication is already available.

Run the focused test; expect FAIL until docs are updated.

- [ ] **Step 2: Write exact operator documentation**

Document:

```bash
npm run build -w @itharbors/kit-core
npm run build -w @itharbors/kit-cli
npm run kit -- validate ./path/to/kit
npm run kit -- pack ./path/to/kit --output ./dist/example.hkit
npm run kit -- inspect ./dist/example.hkit --json
```

Explain `kit.json`, deterministic archives, target/ABI rules, local Store layout, activation/rollback state, and `HARBORS_INSTALLED_KITS`. State prominently that Registry networking, marketplace UI, automated GitHub Release, `kit-workflow`, and product-branch migration are later phases.

- [ ] **Step 3: Run focused and full verification**

Run in this order:

```bash
npm run test -w @itharbors/kit-core
npm run test -w @itharbors/kit-cli
node --test scripts/lib/kit-store/state.test.mjs scripts/lib/kit-store/archive.test.mjs scripts/lib/kit-store/installer.test.mjs scripts/lib/kit-catalog.test.mjs scripts/lib/electron-launcher.test.mjs
npm run test -w packages/server
npm run check
```

Expected: every command exits 0. Inspect `git status --short`, `git diff`, `git diff --cached`, and `git diff --check`; confirm only phase-1 files changed.

- [ ] **Step 4: Commit documentation**

```bash
git commit -m '[Feature] 补充 Kit 制品与本地安装文档'
```

- [ ] **Step 5: Perform phase-1 acceptance audit**

Create a fresh temporary directory, pack the minimal fixture twice, prove identical archive SHA-256, install it through `KitArtifactInstaller`, activate it, start a Server with the resulting active directory snapshot, and prove `/api/kits` includes the installed Kit without exposing its directory. Corrupt the second archive, prove installation fails, and prove the active version remains unchanged.

Record exact commands and outputs for the PR `## Testing` section. Do not claim Registry, GitHub Release, marketplace UI, `kit-workflow`, or business-Kit migration as complete.

---

## Phase-1 Completion Boundary

Phase 1 is complete only when all seven tasks are committed, `npm run check` passes, and the acceptance audit proves deterministic pack, verified local install, activation/rollback state, and Electron/Server installed-source Catalog parity.

The parent Kit Marketplace goal remains active after phase 1. The next separate plan must implement Registry refresh/download, provenance verification, Electron Kit Manager IPC/UI, and GitHub Preview/Stable publication before the marketplace can be described as usable by end users.
