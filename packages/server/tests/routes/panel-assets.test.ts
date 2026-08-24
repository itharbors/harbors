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
  it('keeps same-named panel assets scoped to the requested Kit runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-runtime-scope-'));
    const defaultDir = path.join(root, 'default');
    const agentDir = path.join(root, 'agent');
    for (const [directory, marker] of [[defaultDir, 'default'], [agentDir, 'agent']] as const) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'index.html'), `<html><head><link rel="stylesheet" href="./index.css?theme=dark&sessionId=stale"></head><body><img src="image.png">${marker}</body></html>`);
      fs.writeFileSync(path.join(directory, 'index.css'), `@import "./theme.css?sessionId=stale"; @font-face { src: url('./font.woff2?v=1&sessionId=stale#font'); } body { background: url(image.png); } /* ${marker}-css */`);
      fs.writeFileSync(path.join(directory, 'theme.css'), `/* ${marker}-theme */`);
      fs.writeFileSync(path.join(directory, 'index.js'), `import 'react'; import { marker } from './chunk.js?v=1&sessionId=stale'; export default { marker };`);
      fs.writeFileSync(path.join(directory, 'chunk.js'), `export { nested } from "./nested.js?sessionId=stale"; export const marker = '${marker}-js';`);
      fs.writeFileSync(path.join(directory, 'nested.js'), `export const nested = '${marker}-nested';`);
      fs.writeFileSync(path.join(directory, 'font.woff2'), `${marker}-font`);
      fs.writeFileSync(path.join(directory, 'image.png'), `${marker}-image`);
    }

    const source = new Map();
    for (const [sessionId, directory] of [['client::default', defaultDir], ['client::harness', agentDir]] as const) {
      source.set(sessionId, {
        sessionId,
        panel: {
          getRegistration(name: string) {
            return name === 'plugin-list.list' ? {
              name,
              module: path.join(directory, 'index.html'),
              owner: 'plugin-list',
              constraints: {},
            } : undefined;
          },
        },
        plugin: { listLoaded: () => ['plugin-list'] },
        i18n: {
          getVisibleSnapshot() {
            return { locale: 'zh-CN', defaultLocale: 'zh-CN', version: 0, currentMessages: {}, defaultMessages: {} };
          },
        },
      });
    }

    const router = createPanelAssetRouter(source as never);
    const html = mockRes();
    router({ method: 'GET', url: '/api/assets/panel/plugin-list.list/index.html?sessionId=client%3A%3Adefault&sessionId=client%3A%3Aharness' } as never, html.res);
    expect(html.statusCode()).toBe(200);
    expect(html.body()).toContain('>agent</body>');
    expect(html.body()).not.toContain('>default</body>');
    expect(html.body()).toContain('const sessionId = "client::harness";');
    expect(html.body()).toContain('./index.css?theme=dark&sessionId=client%3A%3Aharness');
    expect(html.body()).toContain('src="image.png?sessionId=client%3A%3Aharness"');
    expect(html.body()).not.toContain('sessionId=stale');

    const script = mockRes();
    router({ method: 'GET', url: '/api/assets/panel/plugin-list.list/index.js?sessionId=client%3A%3Aharness' } as never, script.res);
    expect(script.statusCode()).toBe(200);
    expect(script.body()).toContain("import 'react'");
    expect(script.body()).not.toContain('react?sessionId=');
    expect(script.body()).toContain("./chunk.js?v=1&sessionId=client%3A%3Aharness");
    expect(script.body()).not.toContain('sessionId=stale');

    const chunk = mockRes();
    router({ method: 'GET', url: '/api/assets/panel/plugin-list.list/chunk.js?v=1&sessionId=client%3A%3Aharness' } as never, chunk.res);
    expect(chunk.statusCode()).toBe(200);
    expect(chunk.body()).toContain('agent-js');
    expect(chunk.body()).not.toContain('default-js');
    expect(chunk.body()).toContain('./nested.js?sessionId=client%3A%3Aharness');

    const nested = mockRes();
    router({ method: 'GET', url: '/api/assets/panel/plugin-list.list/nested.js?sessionId=client%3A%3Aharness' } as never, nested.res);
    expect(nested.statusCode()).toBe(200);
    expect(nested.body()).toContain('agent-nested');

    const css = mockRes();
    router({ method: 'GET', url: '/api/assets/panel/plugin-list.list/index.css?theme=dark&sessionId=client%3A%3Aharness' } as never, css.res);
    expect(css.statusCode()).toBe(200);
    expect(css.body()).toContain('./theme.css?sessionId=client%3A%3Aharness');
    expect(css.body()).toContain("./font.woff2?v=1&sessionId=client%3A%3Aharness#font");
    expect(css.body()).toContain('image.png?sessionId=client%3A%3Aharness');
    expect(css.body()).not.toContain('sessionId=stale');

    const font = mockRes();
    router({ method: 'GET', url: '/api/assets/panel/plugin-list.list/font.woff2?v=1&sessionId=client%3A%3Aharness' } as never, font.res);
    expect(font.statusCode()).toBe(200);
    expect(font.body()).toBe('agent-font');

    const image = mockRes();
    router({ method: 'GET', url: '/api/assets/panel/plugin-list.list/image.png?sessionId=client%3A%3Aharness' } as never, image.res);
    expect(image.statusCode()).toBe(200);
    expect(image.body()).toBe('agent-image');

    fs.rmSync(root, { recursive: true, force: true });
  });

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
            name: 'scene-viewport.viewport',
            module: path.join(pluginDir, 'panel.html'),
            owner: 'scene-viewport',
            constraints: {},
          };
        },
      },
      plugin: {
        listLoaded() {
          return ['scene-viewport'];
        },
        getInfo() {
          return {
            name: 'scene-viewport',
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
    router({ method: 'GET', url: '/api/assets/plugin/scene-viewport/icon.svg?sessionId=s1' } as never, ok.res);
    expect(ok.statusCode()).toBe(200);
    expect(ok.header('content-type')).toBe('image/svg+xml; charset=utf-8');
    expect(ok.body()).toContain('<svg');

    const nested = mockRes();
    router({ method: 'GET', url: '/api/assets/plugin/scene-viewport/icons/empty%20scene.svg?sessionId=s1' } as never, nested.res);
    expect(nested.statusCode()).toBe(200);
    expect(nested.body()).toContain('nested');

    const blocked = mockRes();
    router({ method: 'GET', url: '/api/assets/plugin/scene-viewport/..%2Fsecret.txt?sessionId=s1' } as never, blocked.res);
    expect(blocked.statusCode()).toBe(404);

    const symlink = mockRes();
    router({ method: 'GET', url: '/api/assets/plugin/scene-viewport/linked-secret.svg?sessionId=s1' } as never, symlink.res);
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
            name: 'scene-viewport.viewport',
            module: path.join(pluginDir, 'panel.html'),
            owner: 'scene-viewport',
            constraints: {},
          };
        },
      },
      plugin: {
        listLoaded() {
          return ['scene-viewport'];
        },
        getInfo() {
          return {
            name: 'scene-viewport',
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
    router({ method: 'GET', url: '/api/assets/plugin/scene-viewport/secret.svg?sessionId=s1' } as never, res.res);
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
            name: 'scene-viewport.viewport',
            module: path.join(pluginDir, 'panel.html'),
            owner: 'scene-viewport',
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
            name: 'scene-viewport',
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
    router({ method: 'GET', url: '/api/assets/plugin/scene-viewport/icon.svg?sessionId=s1' } as never, res.res);
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
            name: 'scene-viewport.viewport',
            module: path.join(panelDistDir, 'index.html'),
            owner: 'scene-viewport',
            constraints: {},
          };
        },
      },
      plugin: {
        listLoaded() {
          return ['scene-viewport'];
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
      { method: 'GET', url: '/api/assets/panel/scene-viewport.viewport/mesh.glb?sessionId=s1' } as never,
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
      name: 'scene-viewport',
      path: pluginDir,
      kind: 'builtin',
      assets: { public: './assets' },
    };
    source.set('s1', {
      sessionId: 's1',
      panel: {
        getRegistration() {
          return {
            name: 'scene-viewport.viewport',
            module: path.join(pluginDir, 'panel.html'),
            owner: 'scene-viewport',
            constraints: {},
          };
        },
      },
      plugin: {
        listLoaded() {
          return ['scene-viewport'];
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
    router({ method: 'GET', url: '/api/assets/plugin/scene-viewport/icon.svg?sessionId=s1' } as never, malformedRoot.res);
    expect(malformedRoot.statusCode()).toBe(404);

    pluginInfo.assets.public = [null, './assets'] as never;
    const mixedRoots = mockRes();
    router({ method: 'GET', url: '/api/assets/plugin/scene-viewport/icon.svg?sessionId=s1' } as never, mixedRoots.res);
    expect(mixedRoots.statusCode()).toBe(200);
    expect(mixedRoots.body()).toContain('<svg');

    fs.rmSync(root, { recursive: true, force: true });
  });
});
