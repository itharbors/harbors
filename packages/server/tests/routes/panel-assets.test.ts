import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { createPanelAssetRouter } from '../../src/routes/panel-asset';

function mockRes(): {
  res: ServerResponse;
  body: () => string;
  statusCode: () => number;
  header: (name: string) => string | undefined;
} {
  const chunks: Buffer[] = [];
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
    },
    end: (data?: string | Buffer) => {
      if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    },
  } as unknown as ServerResponse;

  return {
    res,
    body: () => Buffer.concat(chunks).toString(),
    statusCode: () => res.statusCode,
    header: (name: string) => headers.get(name.toLowerCase()),
  };
}

describe('panel assets', () => {
  it('serves only manifest-declared public asset directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-assets-'));
    const pluginDir = path.join(root, 'plugin');
    const outsideDir = path.join(root, 'outside');
    fs.mkdirSync(path.join(pluginDir, 'assets', 'icons'), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'assets', 'icon.svg'), '<svg />');
    fs.writeFileSync(path.join(pluginDir, 'assets', 'icons', 'empty scene.svg'), '<svg id="nested" />');
    fs.writeFileSync(path.join(pluginDir, 'secret.txt'), 'nope');
    fs.writeFileSync(path.join(outsideDir, 'secret.svg'), '<svg id="secret" />');
    fs.symlinkSync(path.join(outsideDir, 'secret.svg'), path.join(pluginDir, 'assets', 'linked-secret.svg'));

    const source = new Map();
    source.set('s1', {
      sessionId: 's1',
      panel: {
        getRegistration() {
          return {
            name: '@itharbors/scene-viewport.viewport',
            module: path.join(pluginDir, 'panel.html'),
            owner: '@itharbors/scene-viewport',
            constraints: {},
          };
        },
      },
      plugin: {
        listLoaded() {
          return ['@itharbors/scene-viewport'];
        },
        getInfo() {
          return {
            name: '@itharbors/scene-viewport',
            path: pluginDir,
            kind: 'builtin',
            assets: { public: ['./assets'] },
          };
        },
      },
      i18n: {
        getVisibleSnapshot() {
          return { locale: 'zh-CN', defaultLocale: 'zh-CN', version: 0, currentMessages: {}, defaultMessages: {} };
        },
      },
    });

    const router = createPanelAssetRouter(source as never);
    const ok = mockRes();
    router({ method: 'GET', url: '/api/assets/plugin/%40itharbors%2Fscene-viewport/icon.svg?sessionId=s1' } as never, ok.res);
    expect(ok.statusCode()).toBe(200);
    expect(ok.header('content-type')).toBe('image/svg+xml; charset=utf-8');
    expect(ok.body()).toContain('<svg');

    const nested = mockRes();
    router({ method: 'GET', url: '/api/assets/plugin/%40itharbors%2Fscene-viewport/icons/empty%20scene.svg?sessionId=s1' } as never, nested.res);
    expect(nested.statusCode()).toBe(200);
    expect(nested.body()).toContain('nested');

    const blocked = mockRes();
    router({ method: 'GET', url: '/api/assets/plugin/%40itharbors%2Fscene-viewport/..%2Fsecret.txt?sessionId=s1' } as never, blocked.res);
    expect(blocked.statusCode()).toBe(404);

    const symlink = mockRes();
    router({ method: 'GET', url: '/api/assets/plugin/%40itharbors%2Fscene-viewport/linked-secret.svg?sessionId=s1' } as never, symlink.res);
    expect(symlink.statusCode()).toBe(404);

    const malformed = mockRes();
    router({ method: 'GET', url: '/api/assets/plugin/%E0%A4%A/icon.svg?sessionId=s1' } as never, malformed.res);
    expect(malformed.statusCode()).toBe(404);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('blocks public asset directories that resolve outside the plugin root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-assets-'));
    const pluginDir = path.join(root, 'plugin');
    const outsideDir = path.join(root, 'outside-assets');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.svg'), '<svg id="outside-root" />');
    fs.symlinkSync(outsideDir, path.join(pluginDir, 'assets'));

    const source = new Map();
    source.set('s1', {
      sessionId: 's1',
      panel: {
        getRegistration() {
          return {
            name: '@itharbors/scene-viewport.viewport',
            module: path.join(pluginDir, 'panel.html'),
            owner: '@itharbors/scene-viewport',
            constraints: {},
          };
        },
      },
      plugin: {
        listLoaded() {
          return ['@itharbors/scene-viewport'];
        },
        getInfo() {
          return {
            name: '@itharbors/scene-viewport',
            path: pluginDir,
            kind: 'builtin',
            assets: { public: ['./assets'] },
          };
        },
      },
      i18n: {
        getVisibleSnapshot() {
          return { locale: 'zh-CN', defaultLocale: 'zh-CN', version: 0, currentMessages: {}, defaultMessages: {} };
        },
      },
    });

    const router = createPanelAssetRouter(source as never);
    const res = mockRes();
    router({ method: 'GET', url: '/api/assets/plugin/%40itharbors%2Fscene-viewport/secret.svg?sessionId=s1' } as never, res.res);
    expect(res.statusCode()).toBe(404);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('serves plugin assets only for loaded plugins', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-assets-'));
    const pluginDir = path.join(root, 'plugin');
    fs.mkdirSync(path.join(pluginDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'assets', 'icon.svg'), '<svg />');

    const source = new Map();
    source.set('s1', {
      sessionId: 's1',
      panel: {
        getRegistration() {
          return {
            name: '@itharbors/scene-viewport.viewport',
            module: path.join(pluginDir, 'panel.html'),
            owner: '@itharbors/scene-viewport',
            constraints: {},
          };
        },
      },
      plugin: {
        listLoaded() {
          return [];
        },
        getInfo() {
          return {
            name: '@itharbors/scene-viewport',
            path: pluginDir,
            kind: 'builtin',
            assets: { public: ['./assets'] },
          };
        },
      },
      i18n: {
        getVisibleSnapshot() {
          return { locale: 'zh-CN', defaultLocale: 'zh-CN', version: 0, currentMessages: {}, defaultMessages: {} };
        },
      },
    });

    const router = createPanelAssetRouter(source as never);
    const res = mockRes();
    router({ method: 'GET', url: '/api/assets/plugin/%40itharbors%2Fscene-viewport/icon.svg?sessionId=s1' } as never, res.res);
    expect(res.statusCode()).toBe(404);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('serves panel-local dist assets from the panel directory URL', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-assets-'));
    const pluginDir = path.join(root, 'scene-viewport');
    const panelDistDir = path.join(pluginDir, 'panel.viewport', 'dist');
    fs.mkdirSync(panelDistDir, { recursive: true });
    fs.writeFileSync(path.join(panelDistDir, 'index.html'), '<!DOCTYPE html><html><body></body></html>');
    fs.writeFileSync(path.join(panelDistDir, 'mesh.glb'), 'glb-data');

    const source = new Map();
    source.set('s1', {
      sessionId: 's1',
      panel: {
        getRegistration() {
          return {
            name: '@itharbors/scene-viewport.viewport',
            module: path.join(panelDistDir, 'index.html'),
            owner: '@itharbors/scene-viewport',
            constraints: {},
          };
        },
      },
      plugin: {
        listLoaded() {
          return ['@itharbors/scene-viewport'];
        },
      },
      i18n: {
        getVisibleSnapshot() {
          return { locale: 'zh-CN', defaultLocale: 'zh-CN', version: 0, currentMessages: {}, defaultMessages: {} };
        },
      },
    });

    const router = createPanelAssetRouter(source as never);
    const ok = mockRes();
    router(
      { method: 'GET', url: '/api/assets/panel/%40itharbors%2Fscene-viewport.viewport/mesh.glb?sessionId=s1' } as never,
      ok.res,
    );

    expect(ok.statusCode()).toBe(200);
    expect(ok.header('content-type')).toBe('model/gltf-binary');
    expect(ok.body()).toBe('glb-data');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects malformed public asset manifests without throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-assets-'));
    const pluginDir = path.join(root, 'plugin');
    fs.mkdirSync(path.join(pluginDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'assets', 'icon.svg'), '<svg />');

    const source = new Map();
    const pluginInfo = {
      name: '@itharbors/scene-viewport',
      path: pluginDir,
      kind: 'builtin',
      assets: { public: './assets' },
    };
    source.set('s1', {
      sessionId: 's1',
      panel: {
        getRegistration() {
          return {
            name: '@itharbors/scene-viewport.viewport',
            module: path.join(pluginDir, 'panel.html'),
            owner: '@itharbors/scene-viewport',
            constraints: {},
          };
        },
      },
      plugin: {
        listLoaded() {
          return ['@itharbors/scene-viewport'];
        },
        getInfo() {
          return pluginInfo;
        },
      },
      i18n: {
        getVisibleSnapshot() {
          return { locale: 'zh-CN', defaultLocale: 'zh-CN', version: 0, currentMessages: {}, defaultMessages: {} };
        },
      },
    });

    const router = createPanelAssetRouter(source as never);
    const malformedRoot = mockRes();
    router({ method: 'GET', url: '/api/assets/plugin/%40itharbors%2Fscene-viewport/icon.svg?sessionId=s1' } as never, malformedRoot.res);
    expect(malformedRoot.statusCode()).toBe(404);

    pluginInfo.assets.public = [null, './assets'] as never;
    const mixedRoots = mockRes();
    router({ method: 'GET', url: '/api/assets/plugin/%40itharbors%2Fscene-viewport/icon.svg?sessionId=s1' } as never, mixedRoots.res);
    expect(mixedRoots.statusCode()).toBe(200);
    expect(mixedRoots.body()).toContain('<svg');

    fs.rmSync(root, { recursive: true, force: true });
  });
});
