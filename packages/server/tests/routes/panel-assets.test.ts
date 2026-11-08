import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
  it('announces panel-mounted only after an asynchronous mount succeeds', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-mounted-'));
    try {
      fs.writeFileSync(path.join(root, 'index.html'), '<html><body></body></html>');
      const editor = {
        kit: { getCurrent: () => ({ name: 'kit' }), getCurrentDirectory: () => root },
        panel: { getRegistration: (name: string) => ({ name, module: path.join(root, 'index.html'), owner: 'owner' }) },
        i18n: { getVisibleSnapshot: () => ({ locale: 'zh-CN', defaultLocale: 'zh-CN', version: 0, currentMessages: {}, defaultMessages: {} }) },
      };
      const router = createPanelAssetRouter(new Map([['s', editor]]) as never, { assertSessionAccess: () => {} });
      const response = mockRes();
      router({ method: 'GET', url: '/api/assets/panel/owner.main/index.html?sessionId=s&panelUi=1' } as never, response.res);
      const html = response.body();
      const start = html.indexOf('    const definition = panelModule.default;');
      const end = html.indexOf('  </script>', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const execute = new Function('window', 'panelModule', `return (async () => { const panelName = 'owner.main'; ${html.slice(start, end)} })();`) as (...args: any[]) => Promise<void>;
      const messages: unknown[] = [];
      const target = { parent: { postMessage: (message: unknown) => messages.push(message) }, editor: {} };
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      const mounted = execute(target, { default: { mount: () => pending } });
      await Promise.resolve();
      expect(messages).toEqual([]);
      finish();
      await mounted;
      expect(messages).toEqual([{ type: 'panel-mounted', panel: 'owner.main' }]);

      messages.length = 0;
      await expect(execute(target, { default: { mount: async () => { throw new Error('mount failed'); } } })).rejects.toThrow('mount failed');
      expect(messages).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for scripts and inline events in UI-enabled direct Panel HTML but preserves other panels', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-ui-html-'));
    try {
      fs.writeFileSync(path.join(root, 'ui.js'), '');
      const htmlPath = path.join(root, 'index.html');
      const kit: { name: string; panelUi?: string } = { name: 'kit', panelUi: 'ui.js' };
      const editor = {
        kit: { getCurrent: () => kit, getCurrentDirectory: () => root },
        panel: { getRegistration: (name: string) => ({ name, module: htmlPath, owner: 'owner' }) },
        i18n: { getVisibleSnapshot: () => ({ locale: 'zh-CN', defaultLocale: 'zh-CN', version: 0, currentMessages: {}, defaultMessages: {} }) },
      };
      const router = createPanelAssetRouter(new Map([['s', editor]]) as never, { assertSessionAccess: () => {} });
      expect(() => router({ method: 'GET', url: '/api/assets/panel/owner.main/index.html?panelUi=1' } as never, mockRes().res)).toThrow(/Session/);
      for (const script of [
        '<SCRIPT>window.originalScriptRan = true</SCRIPT>',
        '<script type="module" src="./index.js"></script>',
        '<img src="image.png" onload="window.originalScriptRan = true">',
        '<a href="javascript:window.originalScriptRan=true">link</a>',
        '<a href="java&#x73;cript:window.originalScriptRan=true">link</a>',
        '<a href="java&#x0a;script:window.originalScriptRan=true">link</a>',
        '<iframe srcdoc="&lt;script&gt;window.originalScriptRan = true&lt;/script&gt;"></iframe>',
        '<meta HTTP-EQUIV=" \tReFrEsH " content="0;url=/elsewhere">',
      ]) {
        fs.writeFileSync(htmlPath, `<html><body><p>ORIGINAL-PLUGIN-CONTENT</p>${script}</body></html>`);
        const blocked = mockRes();
        router({ method: 'GET', url: '/api/assets/panel/owner.main/index.html?sessionId=s&panelUi=1' } as never, blocked.res);
        expect(blocked.statusCode()).toBe(422);
        expect(blocked.header('cache-control')).toBe('no-store');
        expect(blocked.body()).toContain('面板无法启动');
        expect(blocked.body()).toContain('不允许包含脚本、内联事件或嵌套 srcdoc');
        expect(blocked.body()).not.toContain('ORIGINAL-PLUGIN-CONTENT');
        expect(blocked.body()).not.toMatch(/<script/i);
        expect(blocked.body()).not.toContain('panelModule');
        const nested = mockRes();
        router({ method: 'GET', url: '/api/assets/panel/owner.main/index.html?sessionId=s' } as never, nested.res);
        expect(nested.statusCode()).toBe(200);
        expect(nested.body()).toContain('ORIGINAL-PLUGIN-CONTENT');
      }
      kit.panelUi = undefined;
      const noUi = mockRes();
      router({ method: 'GET', url: '/api/assets/panel/owner.main/index.html?sessionId=s&panelUi=1' } as never, noUi.res);
      expect(noUi.statusCode()).toBe(200);
      expect(noUi.body()).toContain('ORIGINAL-PLUGIN-CONTENT');
      kit.panelUi = 'ui.js';
      fs.writeFileSync(htmlPath, '<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"></head><body><div id="panel-root"></div></body></html>');
      const valid = mockRes();
      router({ method: 'GET', url: '/api/assets/panel/owner.main/index.html?sessionId=s&panelUi=1' } as never, valid.res);
      expect(valid.statusCode()).toBe(200);
      expect(valid.body()).toContain('await import(panelUiUrl)');
      expect(valid.body().indexOf('await import(panelUiUrl)')).toBeLessThan(valid.body().indexOf('const panelModule ='));
      fs.writeFileSync(htmlPath, '<html><body><!-- <script>example</script> --><textarea><script>example</script> onload=example javascript:example</textarea><p>javascript: example</p></body></html>');
      const examples = mockRes();
      router({ method: 'GET', url: '/api/assets/panel/owner.main/index.html?sessionId=s&panelUi=1' } as never, examples.res);
      expect(examples.statusCode()).toBe(200);
      expect(examples.body()).toContain('await import(panelUiUrl)');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('waits for Kit UI before panel startup and shows a failure without mounting', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-ui-order-'));
    try {
      fs.writeFileSync(path.join(root, 'ui.js'), '');
      fs.writeFileSync(path.join(root, 'index.html'), '<html><body></body></html>');
      const editor = {
        kit: { getCurrent: () => ({ name: 'kit', panelUi: 'ui.js' }), getCurrentDirectory: () => root },
        panel: { getRegistration: (name: string) => ({ name, module: path.join(root, 'index.html'), owner: 'owner' }) },
        i18n: { getVisibleSnapshot: () => ({ locale: 'zh-CN', defaultLocale: 'zh-CN', version: 0, currentMessages: {}, defaultMessages: {} }) },
      };
      const router = createPanelAssetRouter(new Map([['s', editor]]) as never, { assertSessionAccess: () => {} });
      const response = mockRes();
      router({ method: 'GET', url: '/api/assets/panel/owner.main/index.html?sessionId=s&panelUi=1' } as never, response.res);
      const html = response.body();
      const start = html.indexOf('    if (panelUiUrl) {');
      const end = html.indexOf('    const panelModule = sessionId', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const uiBlock = html.slice(start, end).replace('await import(panelUiUrl)', 'await loadUi(panelUiUrl)');
      const execute = new Function('window', 'document', 'console', 'loadUi', 'loadPanel', `
        return (async () => {
          const panelUiUrl = 'kit-ui'; const panelName = 'owner.main';
          ${uiBlock}
          const panelModule = await loadPanel();
          await panelModule.default.mount();
        })();
      `) as (...args: any[]) => Promise<void>;
      const events: string[] = [];
      const fakeWindow = { parent: { postMessage: () => events.push('ready') } };
      const messages: string[] = [];
      const document = { createElement: () => ({ setAttribute() {}, set textContent(value: string) { messages.push(value); } }), body: { appendChild() {} } };
      await execute(fakeWindow, document, console, async () => { events.push('ui'); }, async () => { events.push('panel'); return { default: { mount: () => events.push('mount') } }; });
      expect(events).toEqual(['ui', 'ready', 'panel', 'mount']);
      events.length = 0;
      await expect(execute(fakeWindow, document, { error() {} }, async () => { throw new Error('bad UI'); }, async () => { events.push('panel'); })).rejects.toThrow('bad UI');
      expect(events).toEqual([]);
      expect(messages).toContain('Kit UI 加载失败，面板未启动。');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads only the authorized Session current Kit UI for direct panels', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-kit-ui-'));
    try {
      const ui = 'customElements.define("test-item", class extends HTMLElement {});';
      fs.writeFileSync(path.join(root, 'ui.js'), ui);
      fs.writeFileSync(path.join(root, 'index.html'), '<html><body></body></html>');
      const kit = { name: 'kit-a', panelUi: 'ui.js' };
      const editor = {
        kit: { getCurrent: () => kit, getCurrentDirectory: () => root },
        panel: { getRegistration: (name: string) => ({ name, module: path.join(root, 'index.html'), owner: 'owner' }) },
        i18n: { getVisibleSnapshot: () => ({ locale: 'zh-CN', defaultLocale: 'zh-CN', version: 0, currentMessages: {}, defaultMessages: {} }) },
      };
      const sessions = new Map([['session-a', editor]]);
      const router = createPanelAssetRouter(sessions as never, {
        assertSessionAccess: (_request, session) => { if (session !== 'session-a') throw new Error('denied'); },
      });
      const fingerprint = createHash('sha256').update(ui).digest('hex');
      const asset = `/api/assets/kit-ui.js?sessionId=session-a&kit=kit-a&v=${fingerprint}`;
      const direct = mockRes();
      router({ method: 'GET', url: '/api/assets/panel/owner.main/index.html?sessionId=session-a&panelUi=1' } as never, direct.res);
      expect(direct.body()).toContain(`const panelUiUrl = "${asset}";`);
      expect(direct.body().indexOf('await import(panelUiUrl)')).toBeLessThan(direct.body().indexOf('const panelModule ='));
      expect(direct.body()).toContain('Kit UI 加载失败，面板未启动。');
      const nested = mockRes();
      router({ method: 'GET', url: '/api/assets/panel/owner.main/index.html?sessionId=session-a' } as never, nested.res);
      expect(nested.body()).toContain('const panelUiUrl = undefined;');
      const result = mockRes();
      router({ method: 'GET', url: asset } as never, result.res);
      expect(result.body()).toBe(ui);
      expect(result.header('content-type')).toMatch(/javascript/);
      expect(result.header('cache-control')).toBe('no-store');
      expect(() => router({ method: 'GET', url: '/api/assets/kit-ui.js' } as never, mockRes().res)).toThrow(/Session/);
      expect(() => router({ method: 'GET', url: asset.replace('session-a', 'other') } as never, mockRes().res)).toThrow('denied');
      expect(() => router({ method: 'GET', url: `${asset}&path=../secret` } as never, mockRes().res)).toThrow(/Kit UI not found/);
      kit.name = 'kit-b';
      expect(() => router({ method: 'GET', url: asset } as never, mockRes().res)).toThrow(/Kit UI not found/);
      kit.name = 'kit-a';
      fs.writeFileSync(path.join(root, 'ui.js'), 'changed');
      expect(() => router({ method: 'GET', url: asset } as never, mockRes().res)).toThrow(/Kit UI not found/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
