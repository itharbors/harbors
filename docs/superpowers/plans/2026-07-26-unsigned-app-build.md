# Unsigned App Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual GitHub Actions workflow that builds and uploads a clearly marked, runnable, unsigned macOS ARM64 ITHARBORS test package without entering any formal release or updater path.

**Architecture:** Keep the signed `electron-builder.config.mjs` and `app-publish-v1` workflow unchanged. Add a derived unsigned builder config and an explicit `desktop:unsigned` packaging mode, then call it from a read-only, `workflow_dispatch`-only workflow that validates, smoke-tests, labels, checksums, and uploads a seven-day Actions Artifact.

**Tech Stack:** GitHub Actions, macOS 15 ARM64 runner, Node.js 22.18.0, npm 10.9.3, Electron 43.2.0, electron-builder 26.15.3, Node test runner, Bash.

## Global Constraints

- The unsigned build targets only macOS ARM64 and runs only from `refs/heads/main` by manual `workflow_dispatch`.
- The workflow has only `contents: read`, references no Environment or Secret, and performs no Tag, Release, attestation, deployment, package publication, or remote write.
- The build has no Apple Developer ID signing and no notarization.
- The existing `electron-builder.config.mjs`, `publish-app.yml`, `publish-app-reusable.yml`, `app-publish-v1`, `app-preview`, `app-stable`, and six Apple Secret requirements retain their current formal release semantics.
- The Actions Artifact contains exactly a renamed unsigned DMG, renamed unsigned ZIP, `checksums.txt`, and `UNSIGNED-BUILD.txt`, and is retained for 7 days.
- The Artifact does not contain `latest-mac.yml`, blockmap, SBOM, or provenance attestation and is not an automatic update source.
- All new production behavior follows red-green-refactor: the relevant test must fail for the missing behavior before implementation is written.

---

### Task 1: Explicit unsigned desktop packaging mode

**Files:**
- Create: `electron-builder.unsigned.config.mjs`
- Modify: `scripts/desktop-package.mjs`
- Modify: `scripts/lib/desktop-package-build.mjs`
- Modify: `scripts/lib/desktop-package.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing `electron-builder.config.mjs`, `createDesktopPackageSteps({ cwd, mode, ... })`, and `runDesktopPackage({ cwd, mode, ... })`.
- Produces: `mode: 'unsigned'`, `electron-builder.unsigned.config.mjs`, and `npm run desktop:unsigned` for Task 2.

- [ ] **Step 1: Extend the desktop package tests with the missing unsigned contract**

Change the import and add focused tests in `scripts/lib/desktop-package.test.mjs`:

```js
import {
  DESKTOP_ELECTRON_VERSION,
  createDesktopPackageSteps,
  runDesktopPackage,
} from './desktop-package-build.mjs';

test('unsigned packaging uses a dedicated non-publishing builder config', () => {
  const steps = createDesktopPackageSteps({
    cwd: '/workspace/harbors',
    mode: 'unsigned',
    electronBuilderCli: '/workspace/harbors/node_modules/electron-builder/cli.js',
  });

  assert.deepEqual(steps.map((step) => step.name), [
    'prepare',
    'electron-rebuild',
    'electron-builder',
    'restore-node-addon',
  ]);
  assert.deepEqual(steps[2].args, [
    '/workspace/harbors/node_modules/electron-builder/cli.js',
    '--config',
    'electron-builder.unsigned.config.mjs',
    '--mac',
    '--arm64',
    '--publish',
    'never',
  ]);
});

test('unsigned config preserves packaging inputs while disabling signing and notarization', async () => {
  const signed = (await import('../../electron-builder.config.mjs')).default;
  const unsigned = (await import('../../electron-builder.unsigned.config.mjs')).default;

  assert.equal(signed.mac.notarize, true);
  assert.equal(unsigned.mac.identity, null);
  assert.equal(unsigned.mac.notarize, false);
  assert.equal(unsigned.appId, signed.appId);
  assert.equal(unsigned.electronVersion, signed.electronVersion);
  assert.deepEqual(unsigned.directories, signed.directories);
  assert.deepEqual(unsigned.files, signed.files);
  assert.deepEqual(unsigned.extraResources, signed.extraResources);
  assert.deepEqual(unsigned.mac.target, signed.mac.target);
});
```

In the existing `desktop package owns version...` test, add:

```js
assert.equal(rootPackage.scripts['desktop:unsigned'], 'node scripts/desktop-package.mjs unsigned');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test scripts/lib/desktop-package.test.mjs
```

Expected: FAIL because `unsigned` is rejected, `electron-builder.unsigned.config.mjs` is missing, and `desktop:unsigned` is undefined.

- [ ] **Step 3: Implement the minimal unsigned mode**

Create `electron-builder.unsigned.config.mjs`:

```js
import signedConfig from './electron-builder.config.mjs';

export default {
  ...signedConfig,
  mac: {
    ...signedConfig.mac,
    identity: null,
    notarize: false,
  },
};
```

In `scripts/desktop-package.mjs`, accept the new mode without accepting arbitrary trailing arguments:

```js
const modes = ['dir', 'dist', 'unsigned'];

if (extra.length > 0 || !modes.includes(mode)) {
  throw new Error('Usage: node scripts/desktop-package.mjs <dir|dist|unsigned>');
}
```

In `scripts/lib/desktop-package-build.mjs`, validate the new mode and select the dedicated config:

```js
const modes = ['dir', 'dist', 'unsigned'];
if (!modes.includes(mode)) throw new TypeError('mode must be dir, dist, or unsigned');

const builderConfig = mode === 'unsigned'
  ? 'electron-builder.unsigned.config.mjs'
  : 'electron-builder.config.mjs';
const builderArgs = [
  electronBuilderCli,
  '--config',
  builderConfig,
  '--mac',
  '--arm64',
  ...(mode === 'dir' ? ['--dir'] : ['--publish', 'never']),
];
```

Add the root package script immediately after `desktop:dist`:

```json
"desktop:unsigned": "node scripts/desktop-package.mjs unsigned"
```

- [ ] **Step 4: Run focused and existing publication tests and verify GREEN**

Run:

```bash
node --test scripts/lib/desktop-package.test.mjs scripts/lib/app-publish/*.test.mjs
```

Expected: PASS, including proof that the signed config still has `mac.notarize: true`.

- [ ] **Step 5: Inspect and commit Task 1**

Run:

```bash
git status --short
git diff -- electron-builder.unsigned.config.mjs scripts/desktop-package.mjs scripts/lib/desktop-package-build.mjs scripts/lib/desktop-package.test.mjs package.json
git diff --cached
git add electron-builder.unsigned.config.mjs scripts/desktop-package.mjs scripts/lib/desktop-package-build.mjs scripts/lib/desktop-package.test.mjs package.json
git diff --cached --check
git commit -m '[Feature] 增加未签名主程序打包模式'
```

Expected: one focused commit containing only the explicit unsigned packaging path.

---

### Task 2: Manual read-only GitHub Actions Artifact workflow

**Files:**
- Create: `.github/workflows/build-unsigned-app.yml`
- Create: `scripts/lib/app-publish/unsigned-workflow.test.mjs`

**Interfaces:**
- Consumes: `npm run desktop:unsigned`, desktop version from `packages/desktop/package.json`, and exact outputs under `dist/desktop-release`.
- Produces: manual `Build Unsigned App` workflow and an Artifact named `ITHARBORS-<version>-unsigned-<run_id>` retained for 7 days.

- [ ] **Step 1: Write the failing workflow contract tests**

Create `scripts/lib/app-publish/unsigned-workflow.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootUrl = new URL('../../../', import.meta.url);
const workflowUrl = new URL('.github/workflows/build-unsigned-app.yml', rootUrl);

test('unsigned app build is manual, main-only, read-only, and isolated from releases', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /^on:\s*\n\s+workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /\b(push|pull_request|schedule):/u);
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/mu);
  assert.doesNotMatch(workflow, /contents:\s*write|id-token:\s*write|attestations:\s*write|packages:\s*write|deployments:\s*write/u);
  assert.match(workflow, /GITHUB_REF[\s\S]*refs\/heads\/main/u);
  assert.match(workflow, /ref:\s*\$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /git rev-parse HEAD[\s\S]*GITHUB_SHA/u);
  assert.doesNotMatch(workflow, /^\s+environment:|secrets\.|GH_TOKEN|github\.token|gh release|git tag|actions\/attest/mu);
});

test('unsigned app build pins arm64 tooling and runs checks before the explicit build', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gmu)]
    .map((match) => match[1]);

  assert.deepEqual(actions, [
    'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
    'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  ]);
  assert.match(workflow, /runs-on:\s*macos-15/u);
  assert.match(workflow, /uname -m[\s\S]*arm64/u);
  assert.match(workflow, /node-version:\s*22\.18\.0/u);
  assert.match(workflow, /npm install --global npm@10\.9\.3/u);
  const installIndex = workflow.indexOf('run: npm ci');
  const checkIndex = workflow.indexOf('run: npm run check');
  const buildIndex = workflow.indexOf('run: npm run desktop:unsigned');
  assert.ok(installIndex !== -1 && checkIndex > installIndex && buildIndex > checkIndex);
  assert.doesNotMatch(workflow, /npm run desktop:dist|--publish/u);
});

test('unsigned app build verifies startup and uploads the exact short-lived warning bundle', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /codesign -dv --verbose=4[\s\S]*Authority=Developer ID Application:/u);
  assert.match(workflow, /file "\$EXECUTABLE"[\s\S]*arm64/u);
  assert.match(workflow, /mktemp -d[\s\S]*HARBORS_DISABLE_UPDATE_CHECKS=1[\s\S]*--user-data-dir[\s\S]*\/api\/health/u);
  assert.match(workflow, /ITHARBORS-\$DESKTOP_VERSION-unsigned-arm64\.dmg/u);
  assert.match(workflow, /ITHARBORS-\$DESKTOP_VERSION-unsigned-arm64-mac\.zip/u);
  assert.match(workflow, /UNSIGNED-BUILD\.txt/u);
  assert.match(workflow, /checksums\.txt/u);
  assert.match(workflow, /shasum -a 256/u);
  assert.match(workflow, /\$\{#STAGED_FILES\[@\]\}.*-ne 4/u);
  assert.match(workflow, /name:\s*ITHARBORS-\$\{\{ steps\.metadata\.outputs\.version \}\}-unsigned-\$\{\{ github\.run_id \}\}/u);
  assert.match(workflow, /retention-days:\s*7/u);
  assert.match(workflow, /if-no-files-found:\s*error/u);
  assert.doesNotMatch(workflow, /latest-mac\.yml|\.blockmap|sbom|provenance|attestation/u);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
node --test scripts/lib/app-publish/unsigned-workflow.test.mjs
```

Expected: FAIL with `ENOENT` because `.github/workflows/build-unsigned-app.yml` does not exist.

- [ ] **Step 3: Create the minimal manual unsigned workflow**

Create `.github/workflows/build-unsigned-app.yml` with this complete content:

```yaml
name: Build Unsigned App

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: macos-15
    steps:
      - name: Require a manual main build
        env:
          EXPECTED_REF: refs/heads/main
        run: |
          set -euo pipefail
          [[ "$GITHUB_REF" == "$EXPECTED_REF" ]]
      - name: Check out the exact requested commit
        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with:
          ref: ${{ github.sha }}
          fetch-depth: 1
          persist-credentials: false
      - name: Set up Node.js
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: 22.18.0
          cache: npm
      - name: Verify commit and runner architecture
        run: |
          set -euo pipefail
          [[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]]
          [[ "$(uname -m)" == "arm64" ]]
      - name: Pin npm
        run: npm install --global npm@10.9.3
      - name: Install locked dependencies
        run: npm ci
      - name: Run the complete repository check
        run: npm run check
      - name: Build the explicit unsigned ARM64 package
        run: npm run desktop:unsigned
      - name: Read and validate the desktop version
        id: metadata
        run: |
          node --input-type=module <<'NODE'
          import { appendFileSync, readFileSync } from 'node:fs';
          import semver from 'semver';

          const desktop = JSON.parse(readFileSync('packages/desktop/package.json', 'utf8'));
          if (semver.valid(desktop.version) !== desktop.version || desktop.version.includes('+')) {
            throw new Error('Desktop version must be canonical SemVer without build metadata');
          }
          appendFileSync(process.env.GITHUB_OUTPUT, `version=${desktop.version}\n`, 'utf8');
          NODE
      - name: Smoke test the unsigned packaged Framework
        run: |
          set -euo pipefail
          APP_PATH="dist/desktop-release/mac-arm64/ITHARBORS.app"
          EXECUTABLE="$APP_PATH/Contents/MacOS/ITHARBORS"
          SMOKE_USER_DATA=$(mktemp -d "$RUNNER_TEMP/harbors-unsigned-smoke.XXXXXX")
          APP_LOG="$RUNNER_TEMP/harbors-unsigned-smoke.log"
          APP_PID=""
          cleanup_smoke() {
            if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
              kill "$APP_PID"
              wait "$APP_PID" 2>/dev/null || true
            fi
            rm -rf "$SMOKE_USER_DATA"
          }
          trap cleanup_smoke EXIT
          HARBORS_DISABLE_UPDATE_CHECKS=1 "$EXECUTABLE" \
            --user-data-dir="$SMOKE_USER_DATA" >"$APP_LOG" 2>&1 &
          APP_PID=$!
          healthy=false
          for attempt in {1..60}; do
            if ! kill -0 "$APP_PID" 2>/dev/null; then
              echo '::error::Unsigned packaged app exited before Framework health became ready'
              exit 1
            fi
            framework_pid=$(pgrep -P "$APP_PID" -f 'framework\.mjs' | head -1 || true)
            if [[ -n "$framework_pid" ]]; then
              port=$(lsof -nP -a -p "$framework_pid" -iTCP -sTCP:LISTEN 2>/dev/null \
                | awk 'NR > 1 { print $9 }' \
                | sed -nE 's#.*127\.0\.0\.1:([0-9]+).*#\1#p' \
                | head -1)
              if [[ -n "${port:-}" ]] && curl --fail --silent --max-time 2 \
                "http://127.0.0.1:$port/api/health" >/dev/null; then
                healthy=true
                break
              fi
            fi
            sleep 1
          done
          if [[ "$healthy" != true ]]; then
            echo '::error::Timed out waiting for unsigned packaged Framework health'
            exit 1
          fi
          kill "$APP_PID"
          wait "$APP_PID" 2>/dev/null || true
          APP_PID=""
      - name: Validate and stage the unsigned test bundle
        env:
          DESKTOP_VERSION: ${{ steps.metadata.outputs.version }}
        run: |
          set -euo pipefail
          APP_PATH="dist/desktop-release/mac-arm64/ITHARBORS.app"
          EXECUTABLE="$APP_PATH/Contents/MacOS/ITHARBORS"
          [[ -d "$APP_PATH" && -x "$EXECUTABLE" ]]
          file "$EXECUTABLE" | grep 'arm64'
          SIGNATURE=$(codesign -dv --verbose=4 "$APP_PATH" 2>&1 || true)
          if printf '%s\n' "$SIGNATURE" | grep -q 'Authority=Developer ID Application:'; then
            echo '::error::Unsigned build unexpectedly has a Developer ID Application identity'
            exit 1
          fi
          UPLOAD_DIR="$RUNNER_TEMP/unsigned-app"
          mkdir -p "$UPLOAD_DIR"
          cp "dist/desktop-release/ITHARBORS-$DESKTOP_VERSION-arm64.dmg" \
            "$UPLOAD_DIR/ITHARBORS-$DESKTOP_VERSION-unsigned-arm64.dmg"
          cp "dist/desktop-release/ITHARBORS-$DESKTOP_VERSION-arm64-mac.zip" \
            "$UPLOAD_DIR/ITHARBORS-$DESKTOP_VERSION-unsigned-arm64-mac.zip"
          UPLOAD_DIR="$UPLOAD_DIR" \
            RUN_URL="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
            node --input-type=module <<'NODE'
          import { writeFileSync } from 'node:fs';
          import path from 'node:path';

          const warning = [
            'UNSIGNED INTERNAL TEST BUILD',
            `Version: ${process.env.DESKTOP_VERSION}`,
            `Commit: ${process.env.GITHUB_SHA}`,
            `Run: ${process.env.RUN_URL}`,
            '',
            'This build has no Apple Developer ID signature or notarization.',
            'Gatekeeper may warn about or block this application.',
            'Use only for internal testing, demonstrations, and functional validation.',
            'This is not a formal GitHub Release or an automatic update source.',
            '',
          ].join('\n');
          writeFileSync(path.join(process.env.UPLOAD_DIR, 'UNSIGNED-BUILD.txt'), warning, 'utf8');
          NODE
          (
            cd "$UPLOAD_DIR"
            shasum -a 256 \
              "ITHARBORS-$DESKTOP_VERSION-unsigned-arm64.dmg" \
              "ITHARBORS-$DESKTOP_VERSION-unsigned-arm64-mac.zip" \
              UNSIGNED-BUILD.txt > checksums.txt
          )
          STAGED_FILES=("$UPLOAD_DIR"/*)
          if [[ ${#STAGED_FILES[@]} -ne 4 ]]; then
            echo '::error::Unsigned Artifact must contain exactly four files'
            exit 1
          fi
          for staged_file in "${STAGED_FILES[@]}"; do
            [[ -f "$staged_file" && -s "$staged_file" ]]
          done
      - name: Upload the short-lived unsigned test bundle
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
        with:
          name: ITHARBORS-${{ steps.metadata.outputs.version }}-unsigned-${{ github.run_id }}
          path: ${{ runner.temp }}/unsigned-app/
          if-no-files-found: error
          retention-days: 7
```

- [ ] **Step 4: Run focused workflow and desktop tests and verify GREEN**

Run:

```bash
node --test scripts/lib/app-publish/unsigned-workflow.test.mjs scripts/lib/app-publish/workflows.test.mjs scripts/lib/desktop-package.test.mjs
```

Expected: PASS with no skipped tests or warnings.

- [ ] **Step 5: Inspect and commit Task 2**

Run:

```bash
git status --short
git diff -- .github/workflows/build-unsigned-app.yml scripts/lib/app-publish/unsigned-workflow.test.mjs
git diff --cached
git add .github/workflows/build-unsigned-app.yml scripts/lib/app-publish/unsigned-workflow.test.mjs
git diff --cached --check
git commit -m '[Feature] 增加未签名主程序线上构建'
```

Expected: one focused commit containing only the manual workflow and its contract tests.

---

### Task 3: Operator documentation and end-to-end verification

**Files:**
- Modify: `docs/guides/app-releases.md`
- Modify: `scripts/lib/desktop-package.test.mjs`

**Interfaces:**
- Consumes: `Build Unsigned App`, the four-file Artifact contract, and the existing signed release guide.
- Produces: operator instructions that clearly separate local unsigned directories, online unsigned test Artifacts, and signed Releases.

- [ ] **Step 1: Add failing documentation contract assertions**

In `desktop release documentation preserves operational safety boundaries`, add:

```js
assert.match(releaseGuide, /Build Unsigned App/u);
assert.match(releaseGuide, /workflow_dispatch/u);
assert.match(releaseGuide, /ITHARBORS-<version>-unsigned-arm64\.dmg/u);
assert.match(releaseGuide, /UNSIGNED-BUILD\.txt/u);
assert.match(releaseGuide, /7 days|7 天/u);
assert.match(releaseGuide, /unsigned[\s\S]*not.*Release|未签名[\s\S]*不是.*Release/u);
assert.match(releaseGuide, /unsigned[\s\S]*not.*automatic update|未签名[\s\S]*不.*自动更新/u);
```

- [ ] **Step 2: Run the documentation test and verify RED**

Run:

```bash
node --test --test-name-pattern='desktop release documentation' scripts/lib/desktop-package.test.mjs
```

Expected: FAIL because the release guide does not yet describe the online manual unsigned Artifact.

- [ ] **Step 3: Document the unsigned online build without weakening release guidance**

Add this exact section after `本地开发与结构验收` in `docs/guides/app-releases.md`:

```markdown
## 线上未签名测试包

没有 Apple Developer Program 凭据时，可以在 GitHub Actions 选择 `Build Unsigned App`，选择 `main`，
再通过 **Run workflow** 手动发起 `workflow_dispatch`。成功后从该 Run 下载
`ITHARBORS-<version>-unsigned-<run-id>`，并在内部测试前核对 `checksums.txt`。

Artifact 保留 7 天，只包含 `ITHARBORS-<version>-unsigned-arm64.dmg`、
`ITHARBORS-<version>-unsigned-arm64-mac.zip`、`checksums.txt` 和 `UNSIGNED-BUILD.txt`。
它没有 Apple Developer ID 签名或 notarization，Gatekeeper 可能警告或阻止启动，只能用于内部体验、
演示和功能验证。

未签名 Artifact 不是 GitHub Release，不使用版本 Tag，也不进入自动更新通道。它不能作为签名、
Gatekeeper、stapling、更新或正式 Release 验收依据。获得 Apple 凭据后，`app-publish-v1` 仍是唯一的
正式发布链路。
```

- [ ] **Step 4: Run focused tests, full desktop tests, and repository checks**

Run in order:

```bash
node --test --test-name-pattern='desktop release documentation' scripts/lib/desktop-package.test.mjs
npm run test:desktop
npm run test:app-workflow
npm run check
```

Expected: every command exits 0 with no failed or skipped tests.

- [ ] **Step 5: Perform a real local unsigned package verification**

Run:

```bash
npm run desktop:unsigned
test -s dist/desktop-release/ITHARBORS-0.1.0-preview.1-arm64.dmg
test -s dist/desktop-release/ITHARBORS-0.1.0-preview.1-arm64-mac.zip
file dist/desktop-release/mac-arm64/ITHARBORS.app/Contents/MacOS/ITHARBORS
! codesign -dv --verbose=4 dist/desktop-release/mac-arm64/ITHARBORS.app 2>&1 \
  | rg 'Authority=Developer ID Application:'
```

Expected: the DMG and ZIP are nonempty, the executable reports `arm64`, and the application has no `Developer ID Application` authority.

- [ ] **Step 6: Inspect and commit Task 3**

Run:

```bash
git status --short
git diff -- docs/guides/app-releases.md scripts/lib/desktop-package.test.mjs
git diff --cached
git add docs/guides/app-releases.md scripts/lib/desktop-package.test.mjs
git diff --cached --check
git commit -m '[Feature] 补充未签名主程序构建指南'
```

Expected: one focused documentation commit, with generated `dist/` output left untracked or ignored and not staged.

- [ ] **Step 7: Audit the full objective before finishing the branch**

Run:

```bash
git status --short --branch
git log --oneline --decorate origin/main..HEAD
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
rg -n "workflow_dispatch|contents: read|desktop:unsigned|unsigned-arm64|UNSIGNED-BUILD|retention-days: 7" \
  .github/workflows/build-unsigned-app.yml package.json docs/guides/app-releases.md
rg -n "environment:|secrets\.|contents: write|id-token: write|attestations: write|gh release|git tag" \
  .github/workflows/build-unsigned-app.yml
```

Expected: the branch is clean; all planned commits are present; diff checks pass; required unsigned markers are present; the final forbidden-capability search returns no matches.
