import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../src/server';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('Framework Integration', () => {
  let port: number;
  let stop: () => Promise<void>;
  let baseURL: string;
  let editorMap: Map<string, ReturnType<typeof createServer>['editorMap'] extends Map<string, infer E> ? E : never>;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    const server = createServer();
    stop = server.stop;
    editorMap = server.editorMap;
    port = await server.start(0);
    baseURL = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await stop();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createSession(sessionId: string): Promise<void> {
    await fetch(`${baseURL}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  }

  function createMenuPlugin(pluginName: string, topLabel: string, leafLabel: string): string {
    const pluginDir = mkdtempSync(path.join(tmpdir(), `${pluginName}-`));
    const distDir = path.join(pluginDir, 'dist');
    tempDirs.push(pluginDir);
    writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
      name: pluginName,
      type: 'module',
      main: 'dist/index.js',
      'ce-editor': {
        contribute: {
          menu: [
            { type: 'menu', id: topLabel, label: topLabel },
            { type: 'menu', id: `${topLabel}/${pluginName}.menu`, label: leafLabel },
          ],
        },
      },
    }));
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, 'index.js'), 'editor.plugin.define({ methods: {} });');
    return pluginDir;
  }

  it('GET /api/bootstrap/:sessionId returns bootstrap data', async () => {
    await createSession('boot-test');
    const editor = editorMap.get('boot-test');
    expect(editor).toBeDefined();
    editor!.panel.register('test.editor', '/test/module', { width: 300 });

    const resp = await fetch(`${baseURL}/api/bootstrap/boot-test`);
    const data = await resp.json();
    expect(resp.status).toBe(200);
    expect(data.sessionId).toBe('boot-test');
    expect(data.kitName).toBe('@itharbors/kit-default');
    expect(data.panels.some((panel: { name: string }) => panel.name === 'test.editor')).toBe(true);
  });

  it('GET /api/bootstrap/:sessionId returns session-specific menuTree without leaking menu state across sessions', async () => {
    await createSession('menu-a');
    await createSession('menu-b');

    const editorA = editorMap.get('menu-a');
    const editorB = editorMap.get('menu-b');
    expect(editorA).toBeDefined();
    expect(editorB).toBeDefined();

    const pluginAPath = createMenuPlugin('plugin-a', 'File', 'Action A');
    const pluginBPath = createMenuPlugin('plugin-b', 'Edit', 'Action B');

    await editorA!.plugin.register(pluginAPath);
    await editorB!.plugin.register(pluginBPath);
    await editorA!.plugin.load(pluginAPath);
    await editorB!.plugin.load(pluginBPath);

    const [respA, respB] = await Promise.all([
      fetch(`${baseURL}/api/bootstrap/menu-a`),
      fetch(`${baseURL}/api/bootstrap/menu-b`),
    ]);
    const [dataA, dataB] = await Promise.all([respA.json(), respB.json()]);

    expect(respA.status).toBe(200);
    expect(respB.status).toBe(200);
    expect(dataA.menuTree).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'menu',
        id: 'File',
        label: 'File',
        children: [
          {
            type: 'menu',
            id: 'File/plugin-a.menu',
            label: 'Action A',
            children: [],
          },
        ],
      }),
    ]));
    expect(dataB.menuTree).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'menu',
        id: 'Edit',
        label: 'Edit',
        children: [
          {
            type: 'menu',
            id: 'Edit/plugin-b.menu',
            label: 'Action B',
            children: [],
          },
        ],
      }),
    ]));
    expect(JSON.stringify(dataA.menuTree)).not.toContain('plugin-b.menu');
    expect(JSON.stringify(dataA.menuTree)).not.toContain('Action B');
    expect(JSON.stringify(dataB.menuTree)).not.toContain('plugin-a.menu');
    expect(JSON.stringify(dataB.menuTree)).not.toContain('Action A');
  });

  it('POST /api/session uses the server default kit when one is configured', async () => {
    const server = createServer({ defaultKit: '@itharbors/kit-default' });
    const customPort = await server.start(0);
    const customBaseURL = `http://localhost:${customPort}`;

    try {
      const sessionResp = await fetch(`${customBaseURL}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'configured-default-kit-test' }),
      });
      expect(sessionResp.status).toBe(201);

      const resp = await fetch(`${customBaseURL}/api/bootstrap/configured-default-kit-test`);
      const data = await resp.json();

      expect(resp.status).toBe(200);
      expect(data.kitName).toBe('@itharbors/kit-default');
      expect(data.panels.map((panel: { name: string }) => panel.name)).toEqual(
        expect.arrayContaining(['@itharbors/status-bar.status', '@itharbors/log.log']),
      );
    } finally {
      await server.stop();
    }
  });

  it('GET /api/bootstrap/:sessionId includes the default kit menu contribution', async () => {
    await createSession('default-kit-menu');

    const resp = await fetch(`${baseURL}/api/bootstrap/default-kit-menu`);
    const data = await resp.json();

    expect(resp.status).toBe(200);
    expect(data.kitName).toBe('@itharbors/kit-default');
    expect(data.menuTree).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'file',
        children: expect.arrayContaining([
          expect.objectContaining({
            id: 'file/new-session',
          }),
        ]),
      }),
      expect.objectContaining({
        id: 'edit',
        children: expect.arrayContaining([
          expect.objectContaining({ id: 'edit/undo', role: 'undo' }),
          expect.objectContaining({ id: 'edit/redo', role: 'redo' }),
        ]),
      }),
    ]));
  });

  it('POST /api/menu/trigger executes the built-in menu action handler', async () => {
    await createSession('default-kit-menu-action');

    const resp = await fetch(`${baseURL}/api/menu/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'default-kit-menu-action', menuId: 'file/new-session' }),
    });
    const data = await resp.json();
    expect(resp.status).toBe(200);
    expect(data.result).toEqual({ ok: true, action: 'newSession' });
  });

  it('POST /api/message/request executes server-side handler', async () => {
    await createSession('msg-test');
    const editor = editorMap.get('msg-test')!;
    editor.message.registerRequest('math', 'square', (n) => (n as number) * (n as number));

    const resp = await fetch(`${baseURL}/api/message/request?sessionId=msg-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plugin: 'math', name: 'square', args: [5] }),
    });
    const data = await resp.json();
    expect(resp.status).toBe(200);
    expect(data.result).toBe(25);
  });

  it('POST /api/message/broadcast fires matching handlers', async () => {
    await createSession('bcast-test');
    const editor = editorMap.get('bcast-test')!;
    const calls: string[] = [];
    editor.message.registerBroadcast('p1', 'notify', () => { calls.push('p1'); });
    editor.message.registerBroadcast('p2', 'notify', () => { calls.push('p2'); });

    const resp = await fetch(`${baseURL}/api/message/broadcast?sessionId=bcast-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'notify' }),
    });
    expect(resp.status).toBe(200);
    expect(calls).toEqual(['p1', 'p2']);
  });

  it('GET /api/assets/panel/:name/index.html returns HTML shell with default export bootstrap', async () => {
    await createSession('panel-asset-test');
    const panelDir = mkdtempSync(path.join(tmpdir(), 'integration-panel-'));
    tempDirs.push(panelDir);
    const panelEntry = path.join(panelDir, 'index.html');
    writeFileSync(panelEntry, '<!doctype html><html><body><div id="app"></div></body></html>');
    writeFileSync(path.join(panelDir, 'index.js'), 'export default { mount() {} };');
    editorMap.get('panel-asset-test')!.panel.register('my-plugin.editor', panelEntry);

    const resp = await fetch(`${baseURL}/api/assets/panel/my-plugin.editor/index.html`);
    const html = await resp.text();
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('panel-ready');
    expect(html).toContain('my-plugin.editor');
    expect(html).toContain("await import('./index.js')");
    expect(html).not.toContain('editor.panel.define');
  });
});
