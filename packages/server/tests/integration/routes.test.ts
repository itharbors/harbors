import { describe, it, expect } from 'vitest';
import { createEditor } from '../../src/editor/index';
import { BrowserRequestBroker } from '../../src/framework/browser-request-broker';
import { createBootstrapRouter } from '../../src/routes/bootstrap';
import { createMessageBroadcastRouter } from '../../src/routes/message-broadcast';
import { createMessageRequestRouter } from '../../src/routes/message-request';
import { createMessageResultRouter } from '../../src/routes/message-result';
import { createMenuTriggerRouter } from '../../src/routes/menu-trigger';
import { createPanelAssetRouter } from '../../src/routes/panel-asset';
import { createPanelInstanceRouter } from '../../src/routes/panel-instance';
import { createPanelOpenRouter } from '../../src/routes/panel-open';
import { createWindowEntryRouter } from '../../src/routes/window-entry';
import { createWindowGroupRouter } from '../../src/routes/window-group';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testAssembly } from '../helpers/assembly';
import { HttpError } from '../../src/http/errors';
import { sendHttpError } from '../../src/http/json';

function mockReq(method: string, url: string, body?: object | string): IncomingMessage {
  const readable = new Readable({
    read() {
      if (body) this.push(typeof body === 'string' ? body : JSON.stringify(body));
      this.push(null);
    },
  });
  return Object.assign(readable, { method, url, headers: {} }) as unknown as IncomingMessage;
}

function mockRes(): { res: ServerResponse; body: () => Promise<string>; statusCode: () => number } {
  const chunks: Buffer[] = [];
  const res = {
    statusCode: 200,
    setHeader: () => {},
    end: (data?: string) => { if (data) chunks.push(Buffer.from(data)); },
    writeHead: (code: number) => { res.statusCode = code; },
  } as unknown as ServerResponse;
  return { res, body: async () => Buffer.concat(chunks).toString(), statusCode: () => res.statusCode };
}

async function invokeRoute(
  router: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await router(req, res);
  } catch (error) {
    sendHttpError(
      res,
      error instanceof HttpError
        ? error
        : new HttpError(500, 'INTERNAL_ERROR', 'Internal server error'),
    );
  }
}

describe('framework routes', () => {
  it('bootstrap returns normalized menuTree from the editor menu state', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    const kitDir = mkdtempSync(path.join(tmpdir(), 'routes-menu-kit-'));
    const pluginDir = path.join(kitDir, 'plugins', 'p');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(kitDir, 'layout.json'), JSON.stringify({
      windows: [{ id: 'w1', type: 'panel-area', layout: { type: 'leaf', panel: 'p.editor' } }],
    }));
    writeFileSync(path.join(kitDir, 'package.json'), JSON.stringify({
      name: 'routes-menu-kit',
      'ce-editor': {
        kit: {
          layouts: { default: 'layout.json' },
          windowEntries: { main: 'main.html', secondary: 'secondary.html' },
          plugin: ['p'],
        },
      },
    }));
    writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
      name: 'p',
      main: './main/dist/index.js',
      'ce-editor': {
        contribute: {
          panel: {
            editor: { entry: './panel.editor/dist/index.html', width: 400 },
          },
          menu: [
            { type: 'menu', id: 'File', label: 'File' },
            { type: 'menu', id: 'File/plugin.file', label: 'Plugin Action' },
          ],
        },
      },
    }));
    mkdirSync(path.join(pluginDir, 'main', 'dist'), { recursive: true });
    mkdirSync(path.join(pluginDir, 'panel.editor', 'dist'), { recursive: true });
    writeFileSync(path.join(pluginDir, 'main', 'dist', 'index.js'), 'editor.plugin.define({ methods: {} });');
    writeFileSync(path.join(pluginDir, 'panel.editor', 'dist', 'index.html'), '<!doctype html><html><body><div></div></body></html>');

    try {
      await editor.kit.load(kitDir);

      const router = createBootstrapRouter(new Map([['s1', editor]]));
      const { res, body, statusCode } = mockRes();
      await router(mockReq('GET', '/api/bootstrap/s1'), res);
      const data = JSON.parse(await body());
      expect(statusCode()).toBe(200);
      expect(data.protocolVersion).toBe(1);
      expect(data.sessionId).toBe('s1');
      expect(data.kitName).toBe('routes-menu-kit');
      expect(data.windowEntries).toEqual({ main: 'main.html', secondary: 'secondary.html' });
      expect(data.panels).toHaveLength(1);
      expect(data.windows).toEqual([
        {
          id: 'w1',
          kind: 'main',
          type: 'panel-area',
          entry: 'main.html',
          state: 'open',
          layout: { type: 'leaf', panel: 'p.editor' },
          panelInstanceIds: [],
        },
      ]);
      expect(data.panelInstances).toEqual([]);
      expect(data.menuTree).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'menu',
          id: 'File',
          label: 'File',
          children: [
            {
              type: 'menu',
              id: 'File/plugin.file',
              label: 'Plugin Action',
              children: [],
            },
          ],
        }),
      ]));
    } finally {
      rmSync(kitDir, { recursive: true, force: true });
    }
  });

  it('bootstrap returns current window snapshot and kit window entries', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    await editor.kit.load('@itharbors/kit-default');

    const router = createBootstrapRouter(new Map([['s1', editor]]));
    const { res, body, statusCode } = mockRes();
    await router(mockReq('GET', '/api/bootstrap/s1'), res);

    const data = JSON.parse(await body());
    expect(statusCode()).toBe(200);
    expect(data.windowEntries).toEqual({
      main: 'main.html',
      secondary: 'secondary.html',
    });
    expect(data.windows).toEqual([
      expect.objectContaining({ kind: 'main', entry: 'main.html' }),
    ]);
    expect(data.panelInstances).toEqual([]);
  });

  it('bootstrap keeps every default window loaded from a kit layout', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    const kitDir = mkdtempSync(path.join(tmpdir(), 'routes-multi-window-kit-'));
    writeFileSync(path.join(kitDir, 'layout.json'), JSON.stringify({
      windows: [
        { id: 'main', type: 'panel-area', layout: { type: 'leaf', panel: '@itharbors/log.log' } },
        { id: 'secondary-default', type: 'panel-area', layout: { type: 'leaf', panel: '@itharbors/message-debug.debug' } },
      ],
    }));
    writeFileSync(path.join(kitDir, 'package.json'), JSON.stringify({
      name: 'routes-multi-window-kit',
      'ce-editor': {
        kit: {
          layouts: { default: 'layout.json' },
          windowEntries: { main: 'main.html', secondary: 'secondary.html' },
          plugin: [],
        },
      },
    }));

    try {
      await editor.kit.load(kitDir);

      const router = createBootstrapRouter(new Map([['s1', editor]]));
      const { res, body, statusCode } = mockRes();
      await router(mockReq('GET', '/api/bootstrap/s1'), res);
      const data = JSON.parse(await body());

      expect(statusCode()).toBe(200);
      expect(data.windows.map((windowGroup: { id: string }) => windowGroup.id)).toEqual(['main', 'secondary-default']);
      expect(data.windows[1]).toMatchObject({
        id: 'secondary-default',
        kind: 'secondary',
        entry: 'secondary.html',
      });
    } finally {
      rmSync(kitDir, { recursive: true, force: true });
    }
  });

  it('window entry route serves the current kit secondary html', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    await editor.kit.load('@itharbors/kit-default');

    const router = createWindowEntryRouter(new Map([['s1', editor]]));
    const { res, body, statusCode } = mockRes();
    await router(mockReq('GET', '/api/window-entry/secondary?sessionId=s1'), res);

    expect(statusCode()).toBe(200);
    const html = await body();
    expect(html).toContain('<window-group-app></window-group-app>');
    expect(html).toContain('data-ce-window-entry-style');
    expect(html).toContain('<script type="module" src="/src/index.ts"></script>');
  });

  it('window entry route accepts session query alias for secondary html', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    await editor.kit.load('@itharbors/kit-default');

    const router = createWindowEntryRouter(new Map([['s1', editor]]));
    const { res, body, statusCode } = mockRes();
    await router(mockReq('GET', '/api/window-entry/secondary?session=s1&windowGroupId=secondary-1'), res);

    expect(statusCode()).toBe(200);
    expect(await body()).toContain('<window-group-app></window-group-app>');
  });

  it('window entry route acknowledges the loaded secondary window-group', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    await editor.kit.load('@itharbors/kit-default');
    const opened = editor.window.openPanel('@itharbors/log.log');
    if (!opened.windowGroupId) throw new Error('expected openPanel to create a window-group');

    expect(editor.window.getSnapshot().windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: opened.windowGroupId, state: 'opening' }),
    ]));
    expect(editor.window.getSnapshot().panelInstances).toEqual([
      expect.objectContaining({ id: opened.panelInstanceId, state: 'opening' }),
    ]);

    const router = createWindowEntryRouter(new Map([['s1', editor]]));
    const { res, statusCode } = mockRes();
    await router(mockReq(
      'GET',
      `/api/window-entry/secondary?sessionId=s1&windowGroupId=${encodeURIComponent(opened.windowGroupId)}`,
    ), res);

    expect(statusCode()).toBe(200);
    expect(editor.window.getSnapshot().windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: opened.windowGroupId, state: 'open' }),
    ]));
    expect(editor.window.getSnapshot().panelInstances).toEqual([
      expect.objectContaining({ id: opened.panelInstanceId, state: 'open' }),
    ]);
  });

  it('panel open returns a secondary window-group target', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    await editor.kit.load('@itharbors/kit-default');

    const router = createPanelOpenRouter(new Map([['s1', editor]]));
    const { res, body, statusCode } = mockRes();
    await router(mockReq('POST', '/api/panel/open', {
      sessionId: 's1',
      panelName: '@itharbors/log.log',
    }), res);

    const data = JSON.parse(await body());
    expect(statusCode()).toBe(200);
    expect(data).toMatchObject({
      disposition: 'open-window-group',
      carrier: 'window-group',
      panelName: '@itharbors/log.log',
    });
    expect(data.url).toContain('/api/window-entry/secondary?sessionId=s1');
    expect(data.url).toContain(`windowGroupId=${encodeURIComponent(data.windowGroupId)}`);
  });

  it('panel open accepts session body alias', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    await editor.kit.load('@itharbors/kit-default');

    const router = createPanelOpenRouter(new Map([['s1', editor]]));
    const { res, body, statusCode } = mockRes();
    await router(mockReq('POST', '/api/panel/open', {
      session: 's1',
      panelName: '@itharbors/log.log',
    }), res);

    expect(statusCode()).toBe(200);
    expect(JSON.parse(await body())).toMatchObject({
      disposition: 'open-window-group',
      panelName: '@itharbors/log.log',
    });
  });

  it('panel instance fallback marks an opening instance as floating', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    await editor.kit.load('@itharbors/kit-default');

    const opened = editor.window.openPanel('@itharbors/log.log');
    const router = createPanelInstanceRouter(new Map([['s1', editor]]));
    const { res, body, statusCode } = mockRes();
    await router(mockReq('POST', '/api/panel-instance/fallback', {
      sessionId: 's1',
      panelInstanceId: opened.panelInstanceId,
    }), res);

    expect(statusCode()).toBe(200);
    expect(JSON.parse(await body())).toMatchObject({
      id: opened.panelInstanceId,
      carrier: 'floating',
    });
  });

  it('panel instance state route persists minimized/open floating state', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    await editor.kit.load('@itharbors/kit-default');

    const opened = editor.window.openPanel('@itharbors/log.log');
    editor.window.markPanelInstanceFloating(opened.panelInstanceId);
    const router = createPanelInstanceRouter(new Map([['s1', editor]]));
    const minimized = mockRes();
    await router(mockReq('POST', '/api/panel-instance/state', {
      sessionId: 's1',
      panelInstanceId: opened.panelInstanceId,
      state: 'minimized',
    }), minimized.res);

    expect(minimized.statusCode()).toBe(200);
    expect(JSON.parse(await minimized.body())).toMatchObject({
      id: opened.panelInstanceId,
      state: 'minimized',
    });

    const restored = mockRes();
    await router(mockReq('POST', '/api/panel-instance/state', {
      sessionId: 's1',
      panelInstanceId: opened.panelInstanceId,
      state: 'open',
    }), restored.res);

    expect(restored.statusCode()).toBe(200);
    expect(JSON.parse(await restored.body())).toMatchObject({
      id: opened.panelInstanceId,
      state: 'open',
    });
  });

  it('window group close route removes the secondary group and avoids ghost reuse', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    await editor.kit.load('@itharbors/kit-default');
    const first = editor.window.openPanel('@itharbors/log.log');
    if (!first.windowGroupId) throw new Error('expected openPanel to create a window-group');

    const router = createWindowGroupRouter(new Map([['s1', editor]]));
    const { res, statusCode } = mockRes();
    await router(mockReq('POST', '/api/window-group/close', {
      sessionId: 's1',
      windowGroupId: first.windowGroupId,
    }), res);

    expect(statusCode()).toBe(200);
    expect(editor.window.getSnapshot().windows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.windowGroupId }),
    ]));
    expect(editor.window.getSnapshot().panelInstances).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.panelInstanceId }),
    ]));

    const second = editor.window.openPanel('@itharbors/log.log');
    expect(second.disposition).toBe('open-window-group');
    expect(second.panelInstanceId).not.toBe(first.panelInstanceId);
  });

  it('panel asset runtime exposes editor.openPanel', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    await editor.kit.load('@itharbors/kit-default');

    const router = createPanelAssetRouter(new Map([['s1', editor]]));
    const { res, body, statusCode } = mockRes();
    router(mockReq('GET', '/api/assets/panel/%40itharbors%2Flog.log/index.html?sessionId=s1'), res);

    const html = await body();
    expect(statusCode()).toBe(200);
    expect(html).toContain('async openPanel(panelName)');
    expect(html).toContain("fetch('/api/panel/open'");
    expect(html).toContain("fetch('/api/panel-instance/fallback'");
  });

  it('message request returns handler result', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    editor.message.registerRequest('calc', 'double', (n) => (n as number) * 2);
    const router = createMessageRequestRouter(new Map([['s1', editor]]));
    const { res, body, statusCode } = mockRes();
    await router(mockReq('POST', '/api/message/request?sessionId=s1', { plugin: 'calc', name: 'double', args: [21] }), res);
    expect(statusCode()).toBe(200);
    expect(JSON.parse(await body()).result).toBe(42);
  });

  it('message broadcast fires all matching handlers', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    const calls: string[] = [];
    editor.message.registerBroadcast('p1', 'evt', () => { calls.push('p1'); });
    editor.message.registerBroadcast('p2', 'evt', () => { calls.push('p2'); });
    const router = createMessageBroadcastRouter(new Map([['s1', editor]]));
    const { res, body, statusCode } = mockRes();
    await router(mockReq('POST', '/api/message/broadcast?sessionId=s1', { topic: 'evt' }), res);
    expect(statusCode()).toBe(200);
    expect(JSON.parse(await body()).ok).toBe(true);
    expect(calls).toEqual(['p1', 'p2']);
  });

  it('message result resolves pending request', async () => {
    const broker = new BrowserRequestBroker();
    let requestId = '';
    const pending = broker.request('s1', (event) => { requestId = event.requestId; }, {
      panel: 'panel', method: 'run', args: [],
    });
    const router = createMessageResultRouter(broker);
    const { res, statusCode } = mockRes();
    await router(mockReq('POST', '/api/message/result', {
      sessionId: 's1', requestId, result: { ok: true, value: 'done' },
    }), res);
    expect(statusCode()).toBe(204);
    await expect(pending).resolves.toBe('done');
  });

  it('bootstrap returns darwin default menu baseline from builtin defaults', async () => {
    const editor = createEditor('s1', { assembly: testAssembly, platform: 'darwin' });
    await editor.plugin.register(path.join(testAssembly.builtinPluginsDir, 'menu'));
    await editor.plugin.load(path.join(testAssembly.builtinPluginsDir, 'menu'));

    const router = createBootstrapRouter(new Map([['s1', editor]]));
    const { res, body, statusCode } = mockRes();
    await router(mockReq('GET', '/api/bootstrap/s1'), res);
    const data = JSON.parse(await body());

    expect(statusCode()).toBe(200);
    expect(data.menuTree.map((item: { id: string }) => item.id)).toEqual(['app', 'file', 'edit', 'view', 'window', 'help']);
  });

  it('menu trigger returns builtin documentation action result', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    await editor.plugin.register(path.join(testAssembly.builtinPluginsDir, 'menu'));
    await editor.plugin.load(path.join(testAssembly.builtinPluginsDir, 'menu'));
    const router = createMenuTriggerRouter(new Map([['s1', editor]]));

    const { res, body, statusCode } = mockRes();
    await router(mockReq('POST', '/api/menu/trigger', { sessionId: 's1', menuId: 'help/documentation' }), res);

    expect(statusCode()).toBe(200);
    expect(JSON.parse(await body()).result).toEqual({ ok: true, action: 'openDocumentation' });
  });

  it('menu trigger decorates openPanel action results with a secondary entry url', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    await editor.kit.load();
    const router = createMenuTriggerRouter(new Map([['s1', editor]]));

    const { res, body, statusCode } = mockRes();
    await router(mockReq('POST', '/api/menu/trigger', { sessionId: 's1', menuId: 'view/panels/ce-log-log' }), res);
    const data = JSON.parse(await body());

    expect(statusCode()).toBe(200);
    expect(data.result).toEqual(expect.objectContaining({
      disposition: 'open-window-group',
      panelName: '@itharbors/log.log',
      carrier: 'window-group',
    }));
    expect(data.result.url).toContain('/api/window-entry/secondary?sessionId=s1&windowGroupId=');
  });

  it('menu trigger rejects invalid request bodies with 400', async () => {
    const router = createMenuTriggerRouter(new Map());

    const invalidJson = mockRes();
    await invokeRoute(router, mockReq('POST', '/api/menu/trigger', '{'), invalidJson.res);
    expect(invalidJson.statusCode()).toBe(400);
    expect(JSON.parse(await invalidJson.body())).toMatchObject({ error: { code: 'INVALID_JSON' } });

    const missingFields = mockRes();
    await invokeRoute(router, mockReq('POST', '/api/menu/trigger', { sessionId: 's1' }), missingFields.res);
    expect(missingFields.statusCode()).toBe(400);
    expect(JSON.parse(await missingFields.body())).toMatchObject({ error: { code: 'INVALID_REQUEST' } });

    const emptyFields = mockRes();
    await invokeRoute(router, mockReq('POST', '/api/menu/trigger', { sessionId: '', menuId: '   ' }), emptyFields.res);
    expect(emptyFields.statusCode()).toBe(400);
    expect(JSON.parse(await emptyFields.body())).toMatchObject({ error: { code: 'INVALID_REQUEST' } });

    const nonStringFields = mockRes();
    await invokeRoute(router, mockReq('POST', '/api/menu/trigger', { sessionId: 123, menuId: ['file/new-session'] }), nonStringFields.res);
    expect(nonStringFields.statusCode()).toBe(400);
    expect(JSON.parse(await nonStringFields.body())).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('menu trigger returns 404 for missing sessions and menu items', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    const router = createMenuTriggerRouter(new Map([['s1', editor]]));

    const missingSession = mockRes();
    await invokeRoute(router, mockReq('POST', '/api/menu/trigger', { sessionId: 'missing', menuId: 'file/new-session' }), missingSession.res);
    expect(missingSession.statusCode()).toBe(404);
    expect(JSON.parse(await missingSession.body())).toMatchObject({ error: { code: 'SESSION_NOT_FOUND' } });

    const missingMenu = mockRes();
    await invokeRoute(router, mockReq('POST', '/api/menu/trigger', { sessionId: 's1', menuId: 'missing' }), missingMenu.res);
    expect(missingMenu.statusCode()).toBe(404);
    expect(JSON.parse(await missingMenu.body())).toMatchObject({ error: { code: 'MENU_ITEM_NOT_FOUND' } });
  });

  it('menu trigger catches internal failures without leaking details', async () => {
    const editor = createEditor('s1', { assembly: testAssembly });
    const router = createMenuTriggerRouter(new Map([['s1', editor]]));
    editor.menu.trigger = async () => {
      throw new Error('database password leaked');
    };

    const { res, body, statusCode } = mockRes();
    await invokeRoute(router, mockReq('POST', '/api/menu/trigger', { sessionId: 's1', menuId: 'missing' }), res);

    expect(statusCode()).toBe(500);
    expect(JSON.parse(await body())).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: null },
    });
  });
});
