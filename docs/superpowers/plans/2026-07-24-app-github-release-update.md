# Main Application GitHub Release and Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained macOS arm64 ITHARBORS application, publish it from immutable updater-compatible `v<semver>` GitHub Tags, and let installed signed builds update from GitHub Releases.

**Architecture:** Add `packages/desktop` as the authoritative application package and version source. A build script bundles the Electron main process and a separate production Framework process, stages only Framework resources plus the Default Kit, and hands the result to electron-builder. `electron-updater` owns the signed update transaction; a protected reusable GitHub workflow validates the Tag, signs and notarizes artifacts, publishes an atomic Release, and attests its provenance.

**Tech Stack:** Electron 31.7.7, Node.js 22.18.0, TypeScript, esbuild 0.28.0, electron-builder 26.15.3, electron-updater 6.8.9, better-sqlite3 11.10.0, GitHub Actions, Apple Developer ID, App Store Connect API, Node test runner, Vitest.

## Global Constraints

- Main application Tags are exactly `v<canonical-semver>`; build metadata is forbidden because electron-updater parses the complete GitHub prerelease Tag as SemVer.
- Plain SemVer is Stable; a prerelease component is Preview.
- The Tag version, desktop package version, Electron `app.getVersion()`, update metadata, and asset names must match.
- Initial production target is macOS arm64; Intel Mac, Windows, and Linux are not published in this change.
- Packaged execution must not invoke npm, npx, tsx, TypeScript, Vite, or a system Node.js binary.
- Packaged resources include Framework plugins, Client assets, the Default Kit, and notify-user resource only; SQLite, MySQL, and Notifications product Kits are excluded.
- Runtime state is written only below Electron `userData`; packaged resources are read-only.
- macOS publishing requires a `Developer ID Application: <team name> (<TEAM_ID>)` identity and notarization with an App Store Connect Team API Key.
- Missing or mismatched signing credentials fail closed; no unsigned Preview or Stable GitHub Release is allowed.
- `v*`, `app-publish-v1`, `kit/*/v*`, and `kit-publish-v2` remain independent protected Tag families.
- Use `VisualSJ <devhacker520@hotmail.com>` for every Commit and the repository `[Feature] 中文摘要` convention.

---

### Task 1: Desktop package, version identity, and builder contract

**Files:**
- Create: `packages/desktop/package.json`
- Create: `electron-builder.config.mjs`
- Create: `build/entitlements.mac.plist`
- Create: `scripts/lib/desktop-package.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `@itharbors/desktop` version `0.1.0-preview.1` as the only application version source.
- Produces: root commands `desktop:prepare`, `desktop:dir`, and `desktop:dist`.
- Produces: electron-builder output under `dist/desktop-release` and runtime input under `dist/desktop-runtime`.

- [ ] **Step 1: Write the failing package contract test**

```js
test('desktop package owns version, updater, and native runtime dependencies', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../packages/desktop/package.json', import.meta.url)));
  assert.equal(pkg.name, '@itharbors/desktop');
  assert.equal(pkg.version, '0.1.0-preview.1');
  assert.equal(pkg.main, 'dist/main.mjs');
  assert.equal(pkg.dependencies['electron-updater'], '6.8.9');
  assert.equal(pkg.dependencies['better-sqlite3'], '11.10.0');
});

test('builder ships only the staged runtime and unpacks native modules', async () => {
  const config = (await import('../../electron-builder.config.mjs')).default;
  assert.equal(config.appId, 'com.itharbors.desktop');
  assert.deepEqual(config.directories, {
    app: 'packages/desktop',
    output: 'dist/desktop-release',
  });
  assert.deepEqual(config.mac.target, [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }]);
  assert.match(JSON.stringify(config.extraResources), /dist\/desktop-runtime/);
  assert.match(JSON.stringify(config.asarUnpack), /\.node/);
});
```

- [ ] **Step 2: Run the test and verify the desktop package is missing**

Run: `node --test scripts/lib/desktop-package.test.mjs`

Expected: FAIL with `ENOENT` for `packages/desktop/package.json`.

- [ ] **Step 3: Add the desktop manifest and root scripts**

```json
{
  "name": "@itharbors/desktop",
  "version": "0.1.0-preview.1",
  "private": true,
  "type": "module",
  "main": "dist/main.mjs",
  "dependencies": {
    "better-sqlite3": "11.10.0",
    "electron-updater": "6.8.9"
  }
}
```

Add these root scripts:

```json
{
  "desktop:prepare": "npm run build && node scripts/build-desktop.mjs",
  "desktop:dir": "npm run desktop:prepare && electron-builder --config electron-builder.config.mjs --mac --arm64 --dir",
  "desktop:dist": "npm run desktop:prepare && electron-builder --config electron-builder.config.mjs --mac --arm64 --publish never",
  "test:desktop": "node --test scripts/lib/desktop-*.test.mjs scripts/lib/app-updater*.test.mjs scripts/lib/app-publish/*.test.mjs"
}
```

- [ ] **Step 4: Add the exact electron-builder configuration**

```js
export default {
  appId: 'com.itharbors.desktop',
  productName: 'ITHARBORS',
  electronVersion: '31.7.7',
  directories: { app: 'packages/desktop', output: 'dist/desktop-release' },
  files: ['package.json', 'dist/**/*'],
  extraResources: [{ from: 'dist/desktop-runtime', to: 'runtime' }],
  asar: true,
  asarUnpack: ['node_modules/better-sqlite3/**/*.node'],
  npmRebuild: true,
  electronUpdaterCompatibility: '>=2.16',
  generateUpdatesFilesForAllChannels: true,
  artifactName: '${productName}-${version}-${arch}.${ext}',
  mac: {
    category: 'public.app-category.developer-tools',
    target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: '../../build/entitlements.mac.plist',
    entitlementsInherit: '../../build/entitlements.mac.plist',
    notarize: true,
  },
  publish: [{ provider: 'github', owner: 'itharbors', repo: 'harbors' }],
};
```

The entitlements file grants JIT, unsigned executable memory, network client, and loopback server access required by Electron and the embedded Framework. It must not disable library validation unless the signed arm64 package proves the native module requires it.

Use this complete plist initially:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.network.server</key>
  <true/>
</dict>
</plist>
```

- [ ] **Step 5: Install and lock exact packaging dependencies**

Run:

```bash
npm install --save-dev --save-exact electron-builder@26.15.3
npm install --workspace packages/desktop --save-exact electron-updater@6.8.9 better-sqlite3@11.10.0
```

Expected: `package-lock.json` records the desktop workspace and public npm registry URLs only.

- [ ] **Step 6: Ignore generated desktop output and run the contract test**

Add `/dist/desktop-runtime/` and `/dist/desktop-release/` to `.gitignore` without changing `/harbors-kits/`.

Run: `node --test scripts/lib/desktop-package.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit the package boundary**

```bash
git add packages/desktop/package.json electron-builder.config.mjs build/entitlements.mac.plist scripts/lib/desktop-package.test.mjs package.json package-lock.json .gitignore
git commit -m '[Feature] 建立主程序打包边界'
```

### Task 2: Production Client asset server

**Files:**
- Create: `packages/server/src/routes/client-asset.ts`
- Create: `packages/server/tests/application/client-asset.test.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/client/vite.config.ts`

**Interfaces:**
- Produces: `createClientAssetRouter(root: string): (req, res) => Promise<boolean>`.
- Extends: `ServerOptions.clientAssetsRoot?: string` and `AppOptions.clientAssetsRoot?: string`.
- Guarantees: production `/assets/index.js` is stable, files remain inside the real Client root, and SPA fallback serves built `index.html`.

- [ ] **Step 1: Write traversal, MIME, HEAD, and SPA tests**

```ts
it('serves built assets and index without escaping the Client root', async () => {
  const root = await fixture({
    'index.html': '<script src="/assets/index.js"></script>',
    'assets/index.js': 'export const ready = true;',
  });
  const router = createClientAssetRouter(root);
  await expectResponse(router, 'GET', '/assets/index.js', 200, 'application/javascript');
  await expectResponse(router, 'HEAD', '/assets/index.js', 200, '');
  await expectResponse(router, 'GET', '/workspace/one', 200, 'text/html');
  await expectResponse(router, 'GET', '/assets/%2e%2e/index.html', 404, '');
  await expectResponse(router, 'POST', '/', 404, '');
});
```

- [ ] **Step 2: Run the focused test and verify the router is missing**

Run: `npm test -w packages/server -- --run tests/application/client-asset.test.ts`

Expected: FAIL because `client-asset` cannot be imported.

- [ ] **Step 3: Implement a fail-closed static router**

```ts
export function createClientAssetRouter(root: string) {
  const realRoot = realpathSync(root);
  const indexPath = realpathSync(path.join(realRoot, 'index.html'));
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const pathname = safeDecode(new URL(req.url || '/', 'http://localhost').pathname);
    if (pathname === null) return sendNotFound(res);
    const relative = pathname.startsWith('/assets/') ? pathname.slice(1) : 'index.html';
    const candidate = resolveExistingFile(realRoot, relative);
    if (!candidate || (pathname.startsWith('/assets/') && candidate === indexPath)) {
      return sendNotFound(res);
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType(candidate));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') res.end();
    else createReadStream(candidate).pipe(res);
    return true;
  };
}
```

`resolveExistingFile` must reject NUL, absolute paths, `..`, missing files, directories, symlinks whose real target leaves `realRoot`, and paths not prefixed by `realRoot + path.sep`.

- [ ] **Step 4: Wire production assets without changing development fallback**

Create the router only when `clientAssetsRoot` is set. In `dispatchRequest`, keep every API/SSE/panel route first, then call the Client router, then retain the current embedded development HTML fallback when no production root exists.

Configure Vite with:

```ts
output: {
  entryFileNames: 'assets/index.js',
  chunkFileNames: 'assets/[name]-[hash].js',
  assetFileNames: 'assets/[name]-[hash][extname]',
}
```

- [ ] **Step 5: Run Server and Client verification**

Run:

```bash
npm test -w packages/server -- --run tests/application/client-asset.test.ts
npm run build -w packages/client
test -f packages/client/dist/assets/index.js
```

Expected: tests pass and the stable entry exists.

- [ ] **Step 6: Commit the production asset server**

```bash
git add packages/server/src/routes/client-asset.ts packages/server/tests/application/client-asset.test.ts packages/server/src/app.ts packages/server/src/server.ts packages/client/vite.config.ts
git commit -m '[Feature] 提供主程序生产静态资源'
```

### Task 3: Self-contained Framework child process

**Files:**
- Create: `packages/desktop/src/framework.mjs`
- Create: `scripts/lib/desktop-framework.mjs`
- Create: `scripts/lib/desktop-framework.test.mjs`
- Modify: `packages/server/src/server.ts`

**Interfaces:**
- Produces: `parseDesktopFrameworkEnvironment(env)` returning absolute `runtimeRoot`, `clientAssetsRoot`, `dbPath`, installed Kit directories, notification port, and application token.
- Produces IPC messages `{ type: 'ready', port }` and `{ type: 'fatal', message }`.
- Consumes `createServer({ assembly, clientAssetsRoot, dbPath, host, ... })`.

- [ ] **Step 1: Write environment and lifecycle tests**

```js
test('requires absolute packaged paths and loopback configuration', () => {
  const parsed = parseDesktopFrameworkEnvironment(validEnvironment('/Applications/ITHARBORS.app'));
  assert.equal(parsed.host, '127.0.0.1');
  assert.equal(parsed.port, 0);
  assert.throws(() => parseDesktopFrameworkEnvironment({ ...valid, HARBORS_RUNTIME_ROOT: '../runtime' }), /absolute/);
});

test('emits one ready message and drains one shutdown', async () => {
  const messages = [];
  const processController = createFrameworkProcessController({
    send: (message) => messages.push(message),
    start: async () => 43123,
    stop: async () => {},
  });
  await processController.start();
  await Promise.all([processController.stop(), processController.stop()]);
  assert.deepEqual(messages, [{ type: 'ready', port: 43123 }]);
});
```

- [ ] **Step 2: Run and observe missing exports**

Run: `node --test scripts/lib/desktop-framework.test.mjs`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement strict environment parsing and single-flight lifecycle**

```js
export function createFrameworkProcessController({ send, start, stop }) {
  let startPromise;
  let stopPromise;
  return {
    start() {
      startPromise ??= Promise.resolve(start()).then((port) => {
        send?.({ type: 'ready', port });
        return port;
      });
      return startPromise;
    },
    stop() {
      stopPromise ??= Promise.resolve(startPromise).catch(() => undefined).then(() => stop());
      return stopPromise;
    },
  };
}
```

Validate each required path with `path.isAbsolute`, installed Kits as a JSON array of absolute paths, the token as a non-empty string, and the notification port as an integer from 1 through 65535.

- [ ] **Step 4: Add the Framework process entry**

The entry must construct `createDefaultAssemblyConfig(runtimeRoot, { installedKitDirs })`, call `createServer` with `host: '127.0.0.1'`, `port: 0`, the persistent DB path and production Client root, report only the selected port over IPC, and handle `SIGINT`, `SIGTERM`, and `{ type: 'shutdown' }` through the same idempotent stop promise. Fatal errors send only `error.message` and set exit code 1.

- [ ] **Step 5: Run lifecycle and Server tests**

Run:

```bash
node --test scripts/lib/desktop-framework.test.mjs
npm test -w packages/server
```

Expected: PASS.

- [ ] **Step 6: Commit the packaged Framework entry**

```bash
git add packages/desktop/src/framework.mjs scripts/lib/desktop-framework.mjs scripts/lib/desktop-framework.test.mjs packages/server/src/server.ts
git commit -m '[Feature] 建立主程序生产运行进程'
```

### Task 4: Deterministic desktop runtime staging

**Files:**
- Create: `scripts/build-desktop.mjs`
- Create: `scripts/lib/desktop-build.mjs`
- Create: `scripts/lib/desktop-build.test.mjs`
- Modify: `scripts/lib/codex-skill-resource.mjs`
- Modify: `scripts/lib/codex-skill-resource.test.mjs`

**Interfaces:**
- Produces: `buildDesktop({ repositoryRoot, outputRoot })`.
- Produces: `packages/desktop/dist/main.mjs`, `framework.mjs`, preload/manager assets, and `dist/desktop-runtime/{client,plugins,kits/default,resources/notify-user}`.
- Guarantees deterministic sorted file inventory and exclusion of product Kit directories.

- [ ] **Step 1: Write the staging inventory test**

```js
test('stages the minimum runtime and excludes product Kits', async () => {
  const output = await buildFixture();
  assert.deepEqual(await topLevel(path.join(output, 'kits')), ['default']);
  assert.ok(await exists(path.join(output, 'client/assets/index.js')));
  assert.ok(await exists(path.join(output, 'plugins/menu/package.json')));
  assert.ok(await exists(path.join(output, 'resources/notify-user/SKILL.md')));
  for (const forbidden of ['mysql', 'sqlite', 'notifications']) {
    assert.equal(await exists(path.join(output, 'kits', forbidden)), false);
  }
});
```

- [ ] **Step 2: Run and verify the builder is missing**

Run: `node --test scripts/lib/desktop-build.test.mjs`

Expected: FAIL because `desktop-build.mjs` does not exist.

- [ ] **Step 3: Implement bundle and copy manifests**

Use esbuild twice:

```js
await build({
  entryPoints: [path.join(root, 'scripts/electron.mjs')],
  outfile: path.join(root, 'packages/desktop/dist/main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['electron', 'electron-updater', 'better-sqlite3'],
});
await build({
  entryPoints: [path.join(root, 'packages/desktop/src/framework.mjs')],
  outfile: path.join(root, 'packages/desktop/dist/framework.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['better-sqlite3'],
});
```

Copy explicit file sets only. Reject symlinks, sockets, missing expected build outputs, paths outside the repository, duplicate destinations, and any source under `kits/mysql`, `kits/sqlite`, or `kits/notifications`.

- [ ] **Step 4: Move packaged notify-user resolution to the staged resource**

```js
return path.resolve(isPackaged
  ? path.join(resourcesPath, 'runtime', 'resources', 'notify-user')
  : path.join(rootDir, '.agents', 'skills', 'notify-user'));
```

Retain absolute-path and canonical Skill validation.

- [ ] **Step 5: Build and audit the staged runtime**

Run:

```bash
npm ci
npm run desktop:prepare
node --test scripts/lib/desktop-build.test.mjs scripts/lib/codex-skill-resource.test.mjs
find dist/desktop-runtime/kits -mindepth 1 -maxdepth 1 -type d -print
```

Expected: tests pass and `find` prints only `dist/desktop-runtime/kits/default`.

- [ ] **Step 6: Commit deterministic staging**

```bash
git add scripts/build-desktop.mjs scripts/lib/desktop-build.mjs scripts/lib/desktop-build.test.mjs scripts/lib/codex-skill-resource.mjs scripts/lib/codex-skill-resource.test.mjs
git commit -m '[Feature] 构建最小主程序运行资源'
```

### Task 5: Electron packaged-mode launcher and authoritative version

**Files:**
- Create: `scripts/lib/desktop-paths.mjs`
- Create: `scripts/lib/desktop-paths.test.mjs`
- Create: `scripts/lib/desktop-framework-process.mjs`
- Create: `scripts/lib/desktop-framework-process.test.mjs`
- Modify: `scripts/electron.mjs`
- Modify: `scripts/lib/framework-runtime.mjs`
- Modify: `scripts/lib/framework-runtime.test.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`

**Interfaces:**
- Produces: `resolveDesktopPaths({ isPackaged, repositoryRoot, resourcesPath, moduleDirectory, userData })`.
- Produces: `startDesktopFrameworkProcess(spec)` resolving `{ child, startUrl }` from the child ready message.
- Produces: `resolveCurrentProcessRuntime(processLike)` for packaged Electron ABI.

- [ ] **Step 1: Write tests for paths, commands, readiness, timeout, and version**

```js
test('packaged paths stay under resources and userData', () => {
  const result = resolveDesktopPaths({
    isPackaged: true,
    resourcesPath: '/Applications/ITHARBORS.app/Contents/Resources',
    userData: '/Users/me/Library/Application Support/ITHARBORS',
  });
  assert.equal(result.runtimeRoot, '/Applications/ITHARBORS.app/Contents/Resources/runtime');
  assert.equal(result.dbPath, '/Users/me/Library/Application Support/ITHARBORS/framework.db');
});

test('packaged Framework uses Electron run-as-node and IPC instead of npm', () => {
  const spec = createPackagedFrameworkSpec({ executable: '/Applications/ITHARBORS', frameworkEntry: '/r/framework.mjs', env: {} });
  assert.equal(spec.command, '/Applications/ITHARBORS');
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1');
  assert.deepEqual(spec.stdio, ['ignore', 'inherit', 'inherit', 'ipc']);
  assert.doesNotMatch(JSON.stringify(spec), /npm|vite|tsx/iu);
});
```

- [ ] **Step 2: Run focused tests and observe missing helpers**

Run: `node --test scripts/lib/desktop-paths.test.mjs scripts/lib/desktop-framework-process.test.mjs scripts/lib/framework-runtime.test.mjs scripts/lib/electron-launcher.test.mjs`

Expected: new tests FAIL; existing tests remain green.

- [ ] **Step 3: Implement packaged process supervision**

The supervisor accepts only `{ type: 'ready', port }` with an integer loopback port, rejects early exit, rejects `{ type: 'fatal' }`, kills on a 30-second timeout, and exposes idempotent `stop()` that sends `{ type: 'shutdown' }`, waits 10 seconds, then sends `SIGKILL` only if still alive.

- [ ] **Step 4: Integrate packaged mode into `electron.mjs`**

Move path and runtime initialization into `app.whenReady()`. Set:

```js
kitRuntime = Object.freeze({
  harborsVersion: app.getVersion(),
  kitApiVersion: '1.0.0',
  protocolVersion: 1,
  ...(app.isPackaged ? resolveCurrentProcessRuntime(process) : resolveFrameworkRuntime()),
});
```

Development keeps `createNpmSpawnSpec(createFrameworkArgs(...))` and fixed development ports. Packaged mode spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, passes absolute runtime/client/db/Kit Store values, waits for IPC ready, then assigns `startUrl = http://127.0.0.1:<port>/`. Both modes keep the same readiness/bootstrap and shutdown contracts.

- [ ] **Step 5: Run launcher and runtime suites**

Run: `node --test scripts/lib/desktop-*.test.mjs scripts/lib/framework-runtime.test.mjs scripts/lib/electron-launcher.test.mjs`

Expected: PASS with explicit assertions that packaged mode contains no npm, Vite, or system Node command.

- [ ] **Step 6: Commit packaged launching**

```bash
git add scripts/lib/desktop-paths.mjs scripts/lib/desktop-paths.test.mjs scripts/lib/desktop-framework-process.mjs scripts/lib/desktop-framework-process.test.mjs scripts/electron.mjs scripts/lib/framework-runtime.mjs scripts/lib/framework-runtime.test.mjs scripts/lib/electron-launcher.test.mjs
git commit -m '[Feature] 启动自包含主程序运行时'
```

### Task 6: Signed application update controller, IPC, and UI

**Files:**
- Create: `scripts/lib/app-updater.mjs`
- Create: `scripts/lib/app-updater.test.mjs`
- Create: `scripts/lib/app-updater-ipc.mjs`
- Create: `scripts/lib/app-updater-ipc.test.mjs`
- Modify: `scripts/electron.mjs`
- Modify: `scripts/electron-preload.cjs`
- Modify: `packages/client/src/electron/types.ts`
- Modify: `packages/client/src/electron/bridge.ts`
- Modify: `scripts/lib/electron-launcher.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`

**Interfaces:**
- Produces immutable snapshots `{ status, currentVersion, availableVersion, progress, error }`.
- Produces methods `check()`, `download()`, `install()`, `getSnapshot()`, `subscribe(listener)`, and `dispose()`.
- Produces IPC channels `harbors:update:get-state`, `harbors:update:check`, `harbors:update:download`, `harbors:update:install`, and event `harbors:update:state`.

- [ ] **Step 1: Write state-machine and channel tests**

```js
test('deduplicates checks and keeps Stable away from prereleases', async () => {
  const updater = new FakeUpdater();
  const controller = createAppUpdater({ updater, currentVersion: '1.2.3', isPackaged: true });
  const first = controller.check();
  const second = controller.check();
  assert.equal(first, second);
  assert.equal(updater.allowPrerelease, false);
  updater.emit('update-available', { version: '1.2.4' });
  assert.equal(controller.getSnapshot().status, 'available');
});

test('Preview enables prereleases and errors recover to idle on retry', async () => {
  const updater = new FakeUpdater();
  const controller = createAppUpdater({ updater, currentVersion: '1.2.4-preview.1', isPackaged: true });
  assert.equal(updater.allowPrerelease, true);
  updater.emit('error', new Error('secret /private/path'));
  assert.deepEqual(controller.getSnapshot().error, { code: 'UPDATE_FAILED', message: 'Unable to update ITHARBORS' });
  await controller.check();
  assert.equal(controller.getSnapshot().status, 'checking');
});
```

- [ ] **Step 2: Run focused tests and verify missing controller**

Run: `node --test scripts/lib/app-updater.test.mjs scripts/lib/app-updater-ipc.test.mjs`

Expected: FAIL because updater modules do not exist.

- [ ] **Step 3: Implement the updater transaction**

```js
export function createAppUpdater({ updater, currentVersion, isPackaged, onInstall }) {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = semver.prerelease(currentVersion) !== null;
}
```

Complete the function with this exact transition contract:

| Event/action | Allowed source | Destination | Side effect |
| --- | --- | --- | --- |
| `check()` | `idle`, `not-available`, `error` | `checking` | call `checkForUpdates()` once |
| second `check()` | `checking` | unchanged | return the same Promise object |
| `update-available` | `checking` | `available` | store validated SemVer only |
| `update-not-available` | `checking` | `not-available` | clear candidate and progress |
| `download()` | `available`, `error` with candidate | `downloading` | call `downloadUpdate()` once |
| `download-progress` | `downloading` | `downloading` | clamp percent to 0 through 100 |
| `update-downloaded` | `downloading` | `downloaded` | store validated SemVer only |
| `install()` | `downloaded` | `installing` | call `onInstall()` once |
| provider `error` | any non-installing state | `error` | retain candidate only if download may retry |
| `dispose()` | any | frozen final snapshot | remove every registered listener |

All other action/state pairs reject with `UPDATE_ACTION_INVALID`. Development returns status `disabled` and never registers provider listeners. Use fixed public error codes and messages; never expose feed URLs, local temporary paths, tokens, certificate values, or raw provider errors.

- [ ] **Step 4: Implement narrow IPC and preload APIs**

```js
contextBridge.exposeInMainWorld('harborsUpdates', {
  getState: () => ipcRenderer.invoke('harbors:update:get-state'),
  check: () => ipcRenderer.invoke('harbors:update:check'),
  download: () => ipcRenderer.invoke('harbors:update:download'),
  install: () => ipcRenderer.invoke('harbors:update:install'),
  onState(handler) {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on('harbors:update:state', listener);
    return () => ipcRenderer.removeListener('harbors:update:state', listener);
  },
});
```

IPC handlers accept zero arguments, validate the sender belongs to a live application window, and broadcast frozen public snapshots only.

- [ ] **Step 5: Integrate menu, prompts, delayed checks, and controlled restart**

Add “检查更新…” to the APP menu. Start one delayed check after Framework readiness. On availability, begin background download. On download completion, show “立即重启 / 稍后”. “立即重启” sets `installUpdateAfterShutdown`, runs the existing ordered shutdown, and calls `quitAndInstall()` only when all shutdown results fulfilled. If any shutdown step rejects, do not call `quitAndInstall()`; log a sanitized failure and complete an ordinary `app.quit()` so the still-installed old version is used on the next launch.

- [ ] **Step 6: Run updater, preload, menu, and shutdown tests**

Run:

```bash
node --test scripts/lib/app-updater.test.mjs scripts/lib/app-updater-ipc.test.mjs scripts/lib/electron-launcher.test.mjs
npm test -w packages/client
```

Expected: PASS.

- [ ] **Step 7: Commit the update mechanism**

```bash
git add scripts/lib/app-updater.mjs scripts/lib/app-updater.test.mjs scripts/lib/app-updater-ipc.mjs scripts/lib/app-updater-ipc.test.mjs scripts/electron.mjs scripts/electron-preload.cjs packages/client/src/electron/types.ts packages/client/src/electron/bridge.ts scripts/lib/electron-launcher.mjs scripts/lib/electron-launcher.test.mjs
git commit -m '[Feature] 实现主程序安全更新机制'
```

### Task 7: App Tag validation and local release skill

**Files:**
- Create: `scripts/lib/app-publish/metadata.mjs`
- Create: `scripts/lib/app-publish/metadata.test.mjs`
- Create: `.agents/skills/app-workflow/SKILL.md`
- Create: `.agents/skills/app-workflow/agents/openai.yaml`
- Create: `.agents/skills/app-workflow/scripts/release-app.sh`
- Create: `.agents/skills/app-workflow/tests/app-workflow.test.sh`
- Modify: `package.json`

**Interfaces:**
- Produces: `parseAppReleaseTag(ref)` and `validateAppReleaseIdentity({ ref, packageVersion })`.
- Produces local release command `.agents/skills/app-workflow/scripts/release-app.sh <version>`.
- Produces confirmation token `v<version>@<40-char-commit>`.

- [ ] **Step 1: Read required skill-authoring instructions before creating the skill**

Run: read `skill-creator/SKILL.md` and `superpowers:writing-skills/SKILL.md` completely.

Expected: authoring and verification requirements are known before any `.agents/skills/app-workflow` file is added.

- [ ] **Step 2: Write metadata and release-shell tests**

```js
test.each([
  ['refs/tags/v1.2.3', { version: '1.2.3', channel: 'stable', tag: 'v1.2.3' }],
  ['refs/tags/v1.2.3-preview.1', { version: '1.2.3-preview.1', channel: 'preview', tag: 'v1.2.3-preview.1' }],
])('parses canonical app releases', (ref, expected) => {
  assert.deepEqual(parseAppReleaseTag(ref), expected);
});
test.each(['v1.2.3', 'refs/tags/v01.2.3', 'refs/tags/v1.2.3+build.1', 'refs/tags/app/v1.2.3', 'refs/tags/kit/sqlite/v1.2.3'])(
  'rejects %s', (ref) => assert.throws(() => parseAppReleaseTag(ref)),
);
```

Shell fixtures must prove dirty tree, non-main, mismatched `origin/main`, mismatched desktop version, existing local/remote Tag, failed `ls-remote`, and missing exact confirmation all fail before `git tag` or `git push`.

- [ ] **Step 3: Run and observe missing metadata and skill**

Run:

```bash
node --test scripts/lib/app-publish/metadata.test.mjs
bash .agents/skills/app-workflow/tests/app-workflow.test.sh
```

Expected: FAIL because the files do not exist.

- [ ] **Step 4: Implement canonical Tag identity**

```js
export function parseAppReleaseTag(ref) {
  const match = /^refs\/tags\/v(.+)$/u.exec(ref);
  if (!match || semver.valid(match[1]) !== match[1] || match[1].includes('+')) {
    throw new Error('App release requires refs/tags/v<canonical-semver> without build metadata');
  }
  return {
    version: match[1],
    channel: semver.prerelease(match[1]) === null ? 'stable' : 'preview',
    tag: `v${match[1]}`,
  };
}
```

- [ ] **Step 5: Implement the release skill**

The script mirrors Kit release safety: resolve repository root, require clean local `main` exactly equal to fetched `origin/main`, validate the canonical origin and repository identity, require the remote `app-publish-v1` Tag while rejecting a same-named branch, compare requested version to `packages/desktop/package.json`, reject existing local or remote Tag, print all identity fields, require `HARBORS_APP_RELEASE_CONFIRM=v<version>@<commit>`, run `npm run check` and `npm run desktop:prepare`, then create and push exactly one annotated Tag. It must never create a branch, GitHub Release, or force push.

- [ ] **Step 6: Run the complete release contract**

Run:

```bash
node --test scripts/lib/app-publish/metadata.test.mjs
bash .agents/skills/app-workflow/tests/app-workflow.test.sh
```

Expected: PASS.

- [ ] **Step 7: Commit Tag and local workflow safety**

```bash
git add scripts/lib/app-publish/metadata.mjs scripts/lib/app-publish/metadata.test.mjs .agents/skills/app-workflow package.json
git commit -m '[Feature] 建立主程序标签发布流程'
```

### Task 8: Signed, notarized, attested GitHub Release workflow

**Files:**
- Create: `.github/workflows/publish-app.yml`
- Create: `.github/workflows/publish-app-reusable.yml`
- Create: `scripts/lib/app-publish/workflows.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Wrapper trigger: push Tags matching only updater-compatible `v*`.
- Reusable toolchain identity: `itharbors/harbors/.github/workflows/publish-app-reusable.yml@refs/tags/app-publish-v1`.
- Environment names: `app-preview` and `app-stable`.
- Required secrets: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`.

- [ ] **Step 1: Write workflow contract tests**

Tests must parse the files as text and assert exact Tag isolation, full-SHA action pins, exact `job.workflow_ref`, checkout of the exact Tag with full history, ancestor-of-main check, Node/npm pins, `npm ci`, full check, arm64 runner, required environment secrets, no signing fallback, Developer ID and Team ID verification, codesign/spctl/stapler verification, asset whitelist plus `latest-mac.yml` references, attestation, Release-ID-bound Draft publication, cleanup limited to the run-created Draft, Stable environment gate, Preview prerelease flag, and refusal to mutate an existing Release.

- [ ] **Step 2: Run and verify both workflows are absent**

Run: `node --test scripts/lib/app-publish/workflows.test.mjs`

Expected: FAIL with `ENOENT`.

- [ ] **Step 3: Add the minimal wrapper**

```yaml
name: Publish App
on:
  push:
    tags:
      - 'v*'
permissions:
  contents: write
  id-token: write
  attestations: write
jobs:
  publish:
    uses: itharbors/harbors/.github/workflows/publish-app-reusable.yml@app-publish-v1
```

- [ ] **Step 4: Implement reusable context validation**

The context job checks out `${{ github.ref }}`, fetches `main` without Tags, requires `$GITHUB_SHA` to be an ancestor of `origin/main`, calls `validateAppReleaseIdentity`, compares `packages/desktop/package.json`, and emits only sanitized `version`, `channel`, and `tag` outputs.

- [ ] **Step 5: Implement signing and package verification**

The macOS arm64 build job uses dynamic environment `app-${{ needs.context.outputs.channel }}`. Before building, assert all six secrets are non-empty. Build with `npm run desktop:dist`, then require:

```bash
identity=$(codesign -dv --verbose=4 "$APP_PATH" 2>&1)
printf '%s\n' "$identity" | grep 'Authority=Developer ID Application:'
printf '%s\n' "$identity" | grep "TeamIdentifier=$APPLE_TEAM_ID"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl --assess --type execute --verbose=4 "$APP_PATH"
xcrun stapler validate "$APP_PATH"
```

Verify the executable is `arm64`, launch it in isolated userData with update checks disabled, wait for the Framework health endpoint, then terminate cleanly. Generate `checksums.txt` and `sbom.spdx.json`; require exactly DMG, ZIP, ZIP blockmap, `latest-mac.yml`, checksums, and SBOM.

- [ ] **Step 6: Implement attestation and atomic Draft publication**

Attest DMG, ZIP, update metadata, checksums, and SBOM with `actions/attest@v4`. Refuse any existing Release. Create a Draft without exposing it to electron-updater, upload all assets, query the Draft through `gh api`, compare the exact sorted names and non-zero sizes, then publish once with `--prerelease` only for Preview. A trap may delete only the Draft ID created by the current run and only while `draft=true`.

- [ ] **Step 7: Run workflow contracts and root registration**

Add `test:app-publish` and include it in root `test`.

Run: `node --test scripts/lib/app-publish/workflows.test.mjs scripts/lib/ci-workflow.test.mjs`

Expected: PASS, with Kit workflow tests still proving no app publication behavior.

- [ ] **Step 8: Commit GitHub publication automation**

```bash
git add .github/workflows/publish-app.yml .github/workflows/publish-app-reusable.yml scripts/lib/app-publish/workflows.test.mjs package.json
git commit -m '[Feature] 自动发布签名主程序安装包'
```

### Task 9: Documentation, local package acceptance, and repository verification

**Files:**
- Create: `docs/guides/app-releases.md`
- Modify: `readme.md`
- Modify: `docs/README.md`
- Modify: `docs/architecture/system-overview.md`
- Modify: `docs/architecture/runtime-flows.md`
- Modify: `docs/guides/development-workflow.md`
- Modify: `scripts/lib/desktop-package.test.mjs`

**Interfaces:**
- Documents developer build, release confirmation, Apple credential ownership, GitHub environments, Tag protection, update channels, recovery, and verification commands.
- Produces a local unsigned/ad-hoc directory package for structural acceptance only; it is never uploaded as a Release.

- [ ] **Step 1: Add failing documentation assertions**

```js
for (const text of documents) {
  assert.match(text, /app\/v<semver>/);
  assert.match(text, /Developer ID Application/);
  assert.match(text, /app-publish-v1/);
}
assert.match(releaseGuide, /MAC_CSC_LINK/);
assert.match(releaseGuide, /App Store Connect Team API Key/);
assert.match(releaseGuide, /gh attestation verify/);
```

- [ ] **Step 2: Run and observe missing release guide**

Run: `node --test scripts/lib/desktop-package.test.mjs`

Expected: FAIL for missing documentation strings.

- [ ] **Step 3: Write operator documentation**

The guide must distinguish:

- `Developer ID Application` `.p12` from the App Store Connect Team API `.p8` key;
- DMG/ZIP distribution from PKG, explaining why `Developer ID Installer` is not required;
- implementation/merge approval from exact release confirmation;
- Preview and Stable environment gates;
- local unsigned structure testing from real signed update acceptance;
- immutable release recovery by publishing a higher version rather than replacing assets.

- [ ] **Step 4: Run the full repository check**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Build and inspect the local arm64 directory package**

Run:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:dir
test -d 'dist/desktop-release/mac-arm64/ITHARBORS.app'
file 'dist/desktop-release/mac-arm64/ITHARBORS.app/Contents/MacOS/ITHARBORS'
npx --no-install asar list 'dist/desktop-release/mac-arm64/ITHARBORS.app/Contents/Resources/app.asar'
```

Expected: arm64 Electron executable; app.asar contains desktop entry and no product Kit; `Contents/Resources/runtime/kits` contains only `default`; native `better-sqlite3` is unpacked.

- [ ] **Step 6: Launch the local package with isolated state**

Launch with update checks explicitly disabled and a temporary userData path, wait for a Framework ready log and Default Kit/Kit Manager availability, install a fixture Kit through the real local installer, restart, and verify its state survives. Terminate via the application quit path, not `kill -9`.

- [ ] **Step 7: Commit documentation and final test adjustments**

```bash
git add docs/guides/app-releases.md readme.md docs/README.md docs/architecture/system-overview.md docs/architecture/runtime-flows.md docs/guides/development-workflow.md scripts/lib/desktop-package.test.mjs
git commit -m '[Feature] 完善主程序发布与更新文档'
```

### Task 10: Review, PR, repository activation, and real update proof

**Files:**
- Modify only if review finds defects in files already listed.
- External: GitHub environments, repository secrets, Tag ruleset, `app-publish-v1`, Preview Releases.

**Interfaces:**
- Produces an open PR targeting `main` through `change-workflow`.
- After merge and separate confirmations, produces protected toolchain Tag `app-publish-v1` and two signed Preview Tags proving update N to N+1.

- [ ] **Step 1: Run verification-before-completion**

Read and follow `superpowers:verification-before-completion`. Run focused desktop/update/publish suites, `npm run check`, `npm run desktop:prepare`, local package inspection, `git diff --check`, and inspect every Commit author/committer.

- [ ] **Step 2: Request code review and resolve findings**

Read and follow `superpowers:requesting-code-review`. Apply review feedback with `superpowers:receiving-code-review`, rerun affected checks, and commit focused corrections using the branch label.

- [ ] **Step 3: Push and create the implementation PR**

Create a body file outside the repository with `## Summary` and `## Testing`, then run:

```bash
bash .agents/skills/change-workflow/scripts/finish-change.sh '实现主程序打包与标签更新' "$BODY_FILE"
```

Expected: `PR_URL=` for an open PR whose base is `main`, with green CI and Kit CI.

- [ ] **Step 4: Activate the immutable reusable workflow after merge**

From a clean local `main` exactly equal to `origin/main`, first print `app-publish-v1@<commit>` and obtain separate user confirmation. Then create and push the toolchain Tag before any application Tag, and prohibit an `app-publish-v1` branch. Configure a GitHub Tag ruleset preventing update/deletion of `app-publish-v1` and `v*` while allowing only the narrowly approved release actor required bypass.

- [ ] **Step 5: Configure protected environments and secrets**

Create `app-preview` and `app-stable`; require reviewer approval for `app-stable`. The user supplies the password-protected Developer ID Application `.p12` and App Store Connect Team API `.p8`. Store them only as the six named secrets. Run a credential audit that prints certificate subject, Team ID, and expiration but never certificate bytes, passwords, or API private key.

- [ ] **Step 6: Publish two signed Preview versions with separate confirmations**

Publish `v0.1.0-preview.1`, install it on a clean arm64 Mac, then merge the version increment to `0.1.0-preview.2` and separately confirm/publish the second Tag. Do not reuse Commit or assets between versions.

- [ ] **Step 7: Prove real update and supply-chain behavior**

From Preview 1, verify Preview 2 discovery, download, controlled shutdown, install, restart, `app.getVersion()`, preserved Workspace/Kit Store, codesign, Gatekeeper, stapled notarization ticket, exact Release asset list, and `gh attestation verify` for each attested asset. Install the Stable fixture and prove it does not discover either Preview.

- [ ] **Step 8: Perform the completion audit**

Map every goal and design acceptance item to current authoritative evidence. If Apple credentials or either real Preview update is missing, leave the goal active and report the exact remaining external prerequisite; do not claim the update mechanism complete based only on unit tests or an unsigned package.
