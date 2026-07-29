import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import { tsImport } from 'tsx/esm/api';

import { packKit } from '../../packages/kit-cli/dist/index.js';
import { discoverKits } from './kit-catalog.mjs';
import { validateInstalledKitRuntime } from './application-runtime-client.mjs';
import { createKitManagerView } from './kit-manager-view.mjs';
import { KIT_MANAGER_CHANNELS, registerKitManagerIpc } from './kit-manager-ipc.mjs';
import { createKitManagerWindowController } from './kit-manager-window.mjs';
import { KitArtifactInstaller } from './kit-store/installer.mjs';
import { KitArtifactUninstaller } from './kit-store/uninstaller.mjs';
import { InstalledKitStore } from './kit-store/state.mjs';
import {
  finalizePendingKitActivations,
  prepareInstalledKitsForStartup,
} from './kit-store/startup.mjs';
import { KitAuditLog } from './kit-registry/audit.mjs';
import { KitRegistryCache } from './kit-registry/cache.mjs';
import { KitRegistryClient } from './kit-registry/client.mjs';
import { KitArtifactDownloader } from './kit-registry/downloader.mjs';
import { KitRegistryManager } from './kit-registry/manager.mjs';
import { KitReleaseResolver } from './kit-registry/resolver.mjs';
import { createKitRuntimeCoordinator } from './kit-runtime-coordinator.mjs';
import { createLiveKitDeactivation } from './kit-live-deactivation.mjs';
import { createLiveKitManager } from './live-kit-manager.mjs';

const fixture = path.resolve('packages/kit-cli/tests/fixtures/minimal-kit');
const repositoryRoot = path.resolve('.');
const defaultKitDirectory = path.join(repositoryRoot, 'kits/default');
const registryUrl = 'https://registry.fixture.test/index.v1.json';
const commit = '0123456789abcdef0123456789abcdef01234567';
const workflow = 'example/kit-demo/.github/workflows/publish-kit.yml@refs/tags/v1';
const signerWorkflow = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1';
const runtime = {
  harborsVersion: '1.0.0', kitApiVersion: '1.0.0', protocolVersion: 1,
  platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules,
};

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
  };
}

function createBrowserWindowFake() {
  const instances = [];
  return class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.events = new Map();
      this.webEvents = new Map();
      this.webContents = {
        id: instances.length + 100,
        setWindowOpenHandler: (handler) => { this.openHandler = handler; },
        on: (name, handler) => this.webEvents.set(name, handler),
      };
      instances.push(this);
    }
    on(name, handler) { this.events.set(name, handler); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    show() {}
    focus() {}
    async loadFile() {}
    destroy() { this.destroyed = true; this.events.get('closed')?.(); }
  };
}

async function createVersionFixture(root, version) {
  const directory = path.join(root, `kit-${version}`);
  await cp(fixture, directory, { recursive: true });
  await writeFile(path.join(directory, 'layout.json'), `${JSON.stringify({
    windows: [{
      id: 'demo-main',
      kind: 'main',
      type: 'panel-area',
      layout: { type: 'leaf', panel: '@example/demo.main' },
    }],
  }, null, 2)}\n`, 'utf8');
  await writeFile(
    path.join(directory, 'plugins/demo/main/dist/index.js'),
    'editor.plugin.define({});\n',
    'utf8',
  );
  for (const fileName of ['kit.json', 'package.json']) {
    const file = path.join(directory, fileName);
    const value = JSON.parse(await readFile(file, 'utf8'));
    value.version = version;
    if (fileName === 'package.json') {
      value['ce-editor'].kit.menuRoot.label = `Demo Kit ${version}`;
    }
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
  const packed = await packKit({ directory, output: path.join(root, `demo-${version}.hkit`) });
  const manifest = JSON.parse(await readFile(path.join(directory, 'kit.json'), 'utf8'));
  const releaseUrl = `https://github.com/example/kit-demo/releases/download/v${version}/release.json`;
  const assetUrl = `https://github.com/example/kit-demo/releases/download/v${version}/demo-${version}.hkit`;
  return {
    version,
    manifest,
    packed,
    bytes: await readFile(packed.output),
    releaseUrl,
    assetUrl,
    release: {
      schemaVersion: 1,
      id: manifest.id,
      version,
      channel: 'stable',
      publisher: manifest.publisher,
      source: {
        repository: 'example/kit-demo',
        commit,
        workflow,
        signerWorkflow,
        attestationUrl: `https://github.com/example/kit-demo/attestations/${version}`,
      },
      assets: [{
        name: `demo-${version}-any-any.hkit`,
        url: assetUrl,
        sha256: packed.sha256,
        size: packed.size,
        manifest,
      }],
    },
  };
}

test('acceptance: Kit Manager installs, deactivates, switches, and uninstalls through live Framework generations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-manager-acceptance-'));
  let fixtureServer;
  let framework;
  let controller;
  let registration;
  try {
    const releases = new Map();
    for (const version of ['1.2.3', '1.2.4', '1.10.0']) {
      const item = await createVersionFixture(root, version);
      releases.set(version, item);
    }
    let publishedVersion = '1.2.3';
    const currentIndex = () => {
      const item = releases.get(publishedVersion);
      return {
        schemaVersion: 1,
        generatedAt: publishedVersion === '1.2.3'
          ? '2026-07-23T10:00:00.000Z'
          : '2026-07-23T12:00:00.000Z',
        kits: [{
          id: item.manifest.id,
          label: 'Demo Kit',
          publisher: item.manifest.publisher,
          summary: 'Kit Manager acceptance fixture',
          channels: {
            stable: {
              version: item.version,
              releaseManifestUrl: item.releaseUrl,
              permissions: item.manifest.permissions,
            },
          },
        }],
        revocations: [],
      };
    };
    fixtureServer = createHttpServer((request, response) => {
      if (request.url === '/index.v1.json') {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('ETag', `"registry-${publishedVersion}"`);
        response.end(JSON.stringify(currentIndex()));
        return;
      }
      const releaseMatch = request.url?.match(
        /^\/example\/kit-demo\/releases\/download\/v([^/]+)\/release\.json$/u,
      );
      if (releaseMatch && releases.has(releaseMatch[1])) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(releases.get(releaseMatch[1]).release));
        return;
      }
      const assetMatch = request.url?.match(
        /^\/example\/kit-demo\/releases\/download\/v([^/]+)\/demo-[^/]+\.hkit$/u,
      );
      if (assetMatch && releases.has(assetMatch[1])) {
        const bytes = releases.get(assetMatch[1]).bytes;
        response.setHeader('Content-Length', String(bytes.length));
        response.end(bytes);
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const fixturePort = await listen(fixtureServer);
    const fixtureFetch = (url, options) => {
      const logical = new URL(url);
      return fetch(`http://127.0.0.1:${fixturePort}${logical.pathname}`, options);
    };

    const storeRoot = path.join(root, 'store');
    const store = new InstalledKitStore(storeRoot, { now: () => '2026-07-23T12:00:00.000Z' });
    const cache = new KitRegistryCache(storeRoot, { now: () => '2026-07-23T12:00:00.000Z' });
    const client = new KitRegistryClient({ registryUrl, cache, fetchImpl: fixtureFetch });
    const resolver = new KitReleaseResolver({
      snapshotProvider: client,
      fetchImpl: fixtureFetch,
      provenanceVerifier: {
        verify: async (expected) => ({ verified: true, ...expected }),
      },
      publisherPolicies: {
        example: {
          repositories: ['example/kit-demo'],
          workflows: ['example/kit-demo/.github/workflows/publish-kit.yml'],
          signerWorkflows: [signerWorkflow],
        },
      },
    });
    const audit = new KitAuditLog(storeRoot, { now: () => '2026-07-23T12:00:00.000Z' });
    const manager = new KitRegistryManager({
      client,
      resolver,
      downloader: new KitArtifactDownloader({ storeRoot, fetchImpl: fixtureFetch, maxAttempts: 1 }),
      installer: new KitArtifactInstaller({ storeRoot, store, runtime }),
      store,
      audit,
      runtime,
      autoUpdatePublishers: ['example'],
    });

    const { createServer } = await tsImport('../../packages/server/src/server.ts', import.meta.url);
    const uninstaller = new KitArtifactUninstaller({ storeRoot, store });
    let runtimeUrl;
    let runtimeGeneration = 0;

    async function startRuntimeGeneration() {
      if (framework) {
        await framework.stop();
        framework = undefined;
      }
      const prepared = await prepareInstalledKitsForStartup({
        store,
        audit,
        validateCatalog: async (sources) => discoverKits({
          rootDir: repositoryRoot,
          profile: 'stable',
          installedKits: sources,
        }),
      });
      const catalog = await discoverKits({
        rootDir: repositoryRoot,
        profile: 'stable',
        installedKits: prepared.activeSources,
      });
      framework = createServer({
        defaultKit: '@itharbors/kit-default',
        kitSources: [
          { directory: defaultKitDirectory, source: 'builtin' },
          ...prepared.activeSources.map(({ directory }) => ({ directory, source: 'installed' })),
        ],
        host: '127.0.0.1',
      });
      const frameworkPort = await framework.start();
      runtimeUrl = `http://127.0.0.1:${frameworkPort}`;
      const bootstrap = await (await fetch(`${runtimeUrl}/api/application/bootstrap`)).json();
      const activation = await finalizePendingKitActivations({
        store,
        selections: prepared.pendingActivations,
        catalog,
        validateRuntime: (selection) => validateInstalledKitRuntime(
          runtimeUrl,
          bootstrap,
          selection,
          { sessionId: `installed-kit-runtime-validation-${runtimeGeneration + 1}` },
        ),
        audit,
      });
      if (activation.restartRequired) {
        throw new Error('Acceptance Framework generation requested another restart');
      }
      runtimeGeneration += 1;
      return { prepared, catalog, activation };
    }

    async function assertRuntimeVersion(version) {
      const response = await fetch(`${runtimeUrl}/api/kits`);
      assert.equal(response.status, 200);
      const catalog = await response.json();
      const kit = catalog.kits.find((candidate) => candidate.name === '@example/kit-demo');
      assert.equal(kit?.label, version ? `Demo Kit ${version}` : undefined);
    }

    await startRuntimeGeneration();
    await assertRuntimeVersion(undefined);
    const applyDeactivation = createLiveKitDeactivation({
      store,
      closeWindow: () => false,
      replaceFramework: () => startRuntimeGeneration(),
      openWindow: async () => {},
      isQuitting: () => false,
    });
    const coordinator = createKitRuntimeCoordinator({
      async applyActivation(input) {
        const selection = input.rollback
          ? await manager.rollback(input.id)
          : await manager.activate(input);
        if (!selection.pending) return { ...selection, runtimeReloaded: false };
        const generation = await startRuntimeGeneration();
        const outcome = generation.activation.outcomes.find((candidate) => (
          candidate.id === selection.id && candidate.version === selection.version
        ));
        if (outcome?.status !== 'activated') {
          throw new Error('Acceptance Kit activation failed');
        }
        return { id: selection.id, version: selection.version, runtimeReloaded: true };
      },
      applyDeactivation,
      async applyUninstall(id) {
        await store.stageUninstall(id);
        try {
          await startRuntimeGeneration();
        } catch (error) {
          await store.cancelUninstall(id);
          throw error;
        }
        const removed = await uninstaller.removeStaged(id);
        await store.commitUninstall(id);
        return { ...removed, runtimeReloaded: true };
      },
    });
    const liveManager = createLiveKitManager({ manager, coordinator });

    const BrowserWindow = createBrowserWindowFake();
    controller = createKitManagerWindowController({
      BrowserWindow,
      preloadPath: '/app/kit-manager-preload.cjs',
      htmlPath: '/app/kit-manager.html',
    });
    const managerWindow = await controller.open();
    const ipcMain = createIpcMain();
    registration = registerKitManagerIpc({
      ipcMain,
      getManagerWindow: () => controller.getWindow(),
      service: liveManager,
    });
    const invoke = async (name, ...args) => {
      const response = await ipcMain.handlers.get(KIT_MANAGER_CHANNELS[name])(
        { sender: { id: managerWindow.webContents.id } },
        ...args,
      );
      if (response.ok) return response.value;
      throw Object.assign(new Error(response.error.message), { code: response.error.code });
    };
    const api = {
      list: () => invoke('list'),
      refresh: () => invoke('refresh'),
      install: (value) => invoke('install', value),
      activate: (value) => invoke('activate', value),
      rollback: (value) => invoke('rollback', value),
      deactivate: (value) => invoke('deactivate', value),
      uninstall: (value) => invoke('uninstall', value),
    };
    const html = await readFile(new URL('../kit-manager.html', import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url: 'file:///kit-manager.html' });
    const view = createKitManagerView({ document: dom.window.document, api });
    await view.start();

    dom.window.document.querySelector('#refresh-button').click();
    await view.whenIdle();
    dom.window.document.querySelector('[data-channel="stable"] [data-action="install"]').click();
    await view.whenIdle();
    assert.equal(runtimeGeneration, 2);
    assert.equal((await store.snapshot()).kits['@example/kit-demo'].active, '1.2.3');
    assert.equal((await store.snapshot()).kits['@example/kit-demo'].pending, undefined);
    await assertRuntimeVersion('1.2.3');

    publishedVersion = '1.2.4';
    dom.window.document.querySelector('#refresh-button').click();
    await view.whenIdle();
    dom.window.document.querySelector('[data-channel="stable"] [data-action="install"]').click();
    await view.whenIdle();
    assert.equal(runtimeGeneration, 3);
    assert.equal((await store.snapshot()).kits['@example/kit-demo'].active, '1.2.4');
    assert.equal((await store.snapshot()).kits['@example/kit-demo'].pending, undefined);
    await assertRuntimeVersion('1.2.4');

    publishedVersion = '1.10.0';
    dom.window.document.querySelector('#refresh-button').click();
    await view.whenIdle();
    dom.window.document.querySelector('[data-channel="stable"] [data-action="install"]').click();
    await view.whenIdle();
    assert.equal(runtimeGeneration, 4);
    assert.equal((await store.snapshot()).kits['@example/kit-demo'].active, '1.10.0');
    assert.equal((await store.snapshot()).kits['@example/kit-demo'].pending, undefined);
    await assertRuntimeVersion('1.10.0');

    dom.window.document.querySelector('[data-action="deactivate"]').click();
    await view.whenIdle();
    assert.equal(runtimeGeneration, 5);
    assert.equal((await store.snapshot()).kits['@example/kit-demo'].active, undefined);
    assert.equal((await store.snapshot()).kits['@example/kit-demo'].previous, '1.10.0');
    assert.deepEqual(
      Object.keys((await store.snapshot()).kits['@example/kit-demo'].versions).sort(),
      ['1.10.0', '1.2.3', '1.2.4'],
    );
    await assertRuntimeVersion(undefined);
    assert.equal(
      dom.window.document.querySelector('[data-action="switch-version"]').textContent,
      '启用此版本',
    );

    dom.window.document.querySelector('[data-action="switch-version"]').click();
    await view.whenIdle();
    assert.equal(runtimeGeneration, 6);
    assert.equal((await store.snapshot()).kits['@example/kit-demo'].active, '1.10.0');
    await assertRuntimeVersion('1.10.0');

    const managerIdentity = controller.getWindow();
    const managerWebContentsId = managerIdentity.webContents.id;
    const versionSelect = dom.window.document.querySelector('[data-role="installed-version"]');
    assert.deepEqual([...versionSelect.options].map((option) => option.value), [
      '1.10.0', '1.2.4', '1.2.3',
    ]);
    versionSelect.value = '1.2.3';
    versionSelect.dispatchEvent(new dom.window.Event('change'));
    dom.window.document.querySelector('[data-action="switch-version"]').click();
    await view.whenIdle();
    assert.equal(runtimeGeneration, 7);
    assert.equal((await store.snapshot()).kits['@example/kit-demo'].active, '1.2.3');
    assert.equal((await store.snapshot()).kits['@example/kit-demo'].previous, '1.10.0');
    await assertRuntimeVersion('1.2.3');
    assert.equal(controller.getWindow(), managerIdentity);
    assert.equal(controller.getWindow().webContents.id, managerWebContentsId);

    const installedFiles = Object.values(
      (await store.snapshot()).kits['@example/kit-demo'].versions,
    ).map(({ directory }) => path.join(directory, 'kit.json'));
    await Promise.all(installedFiles.map((file) => readFile(file, 'utf8')));
    dom.window.document.querySelector('[data-channel="stable"] [data-action="uninstall"]').click();
    await view.whenIdle();
    assert.equal(runtimeGeneration, 8);
    assert.equal((await store.snapshot()).kits['@example/kit-demo'], undefined);
    await assertRuntimeVersion(undefined);
    for (const file of installedFiles) {
      await assert.rejects(readFile(file), { code: 'ENOENT' });
    }
    assert.match(dom.window.document.querySelector('#operation-status').textContent, /已删除 Demo Kit/u);
  } finally {
    registration?.unregister();
    await registration?.drain();
    controller?.destroy();
    if (framework) await framework.stop();
    if (fixtureServer?.listening) await close(fixtureServer);
    await rm(root, { recursive: true, force: true });
  }
});
