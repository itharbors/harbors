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
import { createKitManagerView } from './kit-manager-view.mjs';
import { KIT_MANAGER_CHANNELS, registerKitManagerIpc } from './kit-manager-ipc.mjs';
import { createKitManagerWindowController } from './kit-manager-window.mjs';
import { KitArtifactInstaller } from './kit-store/installer.mjs';
import { InstalledKitStore } from './kit-store/state.mjs';
import { prepareInstalledKitsForStartup } from './kit-store/startup.mjs';
import { KitAuditLog } from './kit-registry/audit.mjs';
import { KitRegistryCache } from './kit-registry/cache.mjs';
import { KitRegistryClient } from './kit-registry/client.mjs';
import { KitArtifactDownloader } from './kit-registry/downloader.mjs';
import { KitRegistryManager } from './kit-registry/manager.mjs';
import { KitReleaseResolver } from './kit-registry/resolver.mjs';

const fixture = path.resolve('packages/kit-cli/tests/fixtures/minimal-kit');
const repositoryRoot = path.resolve('.');
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
  for (const fileName of ['kit.json', 'package.json']) {
    const file = path.join(directory, fileName);
    const value = JSON.parse(await readFile(file, 'utf8'));
    value.version = version;
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

test('acceptance: Kit Dock installs, restarts, reaches Server Catalog, and rolls back', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-manager-acceptance-'));
  let fixtureServer;
  let framework;
  let controller;
  let registration;
  try {
    const releases = new Map();
    for (const version of ['1.2.3', '1.2.4']) {
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
      service: manager,
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
    };
    const html = await readFile(new URL('../kit-manager.html', import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url: 'file:///kit-manager.html' });
    const view = createKitManagerView({ document: dom.window.document, api });
    await view.start();

    dom.window.document.querySelector('#refresh-button').click();
    await view.whenIdle();
    dom.window.document.querySelector('[data-channel="stable"] [data-action="install"]').click();
    await view.whenIdle();
    dom.window.document.querySelector('[data-channel="stable"] [data-action="activate"]').click();
    await view.whenIdle();
    let prepared = await prepareInstalledKitsForStartup({
      store,
      audit,
      validateCatalog: async (sources) => discoverKits({ rootDir: repositoryRoot, installedKits: sources }),
    });
    assert.equal(prepared.activeSources[0].version, '1.2.3');

    publishedVersion = '1.2.4';
    dom.window.document.querySelector('#refresh-button').click();
    await view.whenIdle();
    dom.window.document.querySelector('[data-channel="stable"] [data-action="install"]').click();
    await view.whenIdle();
    dom.window.document.querySelector('[data-channel="stable"] [data-action="activate"]').click();
    await view.whenIdle();
    prepared = await prepareInstalledKitsForStartup({
      store,
      audit,
      validateCatalog: async (sources) => discoverKits({ rootDir: repositoryRoot, installedKits: sources }),
    });
    assert.equal(prepared.activeSources[0].version, '1.2.4');

    const { createServer } = await tsImport('../../packages/server/src/server.ts', import.meta.url);
    framework = createServer({
      defaultKit: '@example/kit-demo',
      installedKitDirs: prepared.activeSources.map(({ directory }) => directory),
      host: '127.0.0.1',
    });
    const frameworkPort = await framework.start();
    const catalog = await (await fetch(`http://127.0.0.1:${frameworkPort}/api/kits`)).json();
    assert.equal(catalog.kits.some((kit) => kit.name === '@example/kit-demo'), true);
    await framework.stop();
    framework = undefined;

    view.render(await api.list());
    dom.window.document.querySelector('[data-channel="stable"] [data-action="rollback"]').click();
    await view.whenIdle();
    prepared = await prepareInstalledKitsForStartup({
      store,
      audit,
      validateCatalog: async (sources) => discoverKits({ rootDir: repositoryRoot, installedKits: sources }),
    });
    assert.equal(prepared.activeSources[0].version, '1.2.3');
    assert.equal((await store.snapshot()).kits['@example/kit-demo'].previous, '1.2.4');
  } finally {
    registration?.unregister();
    await registration?.drain();
    controller?.destroy();
    if (framework) await framework.stop();
    if (fixtureServer?.listening) await close(fixtureServer);
    await rm(root, { recursive: true, force: true });
  }
});
