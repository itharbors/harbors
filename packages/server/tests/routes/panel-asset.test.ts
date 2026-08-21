import { describe, expect, it } from 'vitest';
import { createPanelAssetRouter } from '../../src/routes/panel-asset';
import { PanelModule } from '../../src/framework/panel';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function mockReq(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as IncomingMessage;
}

function mockRes(): { res: ServerResponse; body: () => string; statusCode: () => number; header: (name: string) => string | undefined } {
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

describe('createPanelAssetRouter', () => {
  it('serves HTML that injects runtime and imports the sibling index module', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-js-test-'));
    const panelPath = path.join(tmpDir, 'index.js');
    fs.writeFileSync(panelPath, 'export default { methods: {} };');
    const panel = new PanelModule();
    panel.register('@scope/demo.preview', panelPath);
    const router = createPanelAssetRouter(panel);
    const { res, body, statusCode, header } = mockRes();

    router(mockReq('GET', '/api/assets/panel/%40scope%2Fdemo.preview/index.html'), res);

    const html = body();
    expect(statusCode()).toBe(200);
    expect(header('Cache-Control')).toBe('no-store');
    expect(html).toContain("await import('./index.js')");
    expect(html).toContain('const definition = panelModule.default;');
    expect(html).toContain('Panel module must default-export a PanelDefinition object');
    expect(html).toContain('window.__panelDefinition = definition;');
    expect(html).toContain('window.editor = {');
    expect(html).toContain("const prefix = panelPluginName + '.';");
    expect(html).toContain("if (typeof topic !== 'string')");
    expect(html).toContain("if (topic === '*')");
    expect(html).toContain('if (!topic.startsWith(prefix))');
    expect(html).toContain("'Panel \"' + panelPluginName");
    expect(html).toContain("' + prefix + '\"'");
    expect(html).toContain('function createPanelMessageRequestError(payload)');
    expect(html).toContain('async function refreshPanelCapability()');
    expect(html).toContain("fetch(window.location.href, { cache: 'no-store' })");
    expect(html).toContain('(?:const|let) panelCapability');
    expect(html).toContain('let panelCapabilityRefreshPromise = null;');
    expect(html).toContain('let capabilityRetryAttempted = false;');
    expect(html).toContain('panelCapabilityRefreshPromise = null;');
    expect(html).toContain("errorCode === 'PANEL_CAPABILITY_INVALID'");
    expect(html).toContain('throw createPanelMessageRequestError(payload);');
    expect(html).toContain('requestError.code = errorBody.code;');
    expect(html).not.toContain("new Error(payload.error || 'Panel message request failed')");
    const errorFactoryStart = html.indexOf('function createPanelMessageRequestError(payload)');
    const errorFactoryEnd = html.indexOf('function encodePanelAssetPath', errorFactoryStart);
    expect(errorFactoryStart).toBeGreaterThan(-1);
    expect(errorFactoryEnd).toBeGreaterThan(errorFactoryStart);
    const errorFactorySource = html.slice(errorFactoryStart, errorFactoryEnd);
    const createPanelMessageRequestError = new Function(
      `${errorFactorySource}; return createPanelMessageRequestError;`,
    )() as (payload: unknown) => Error & { code?: string; details?: unknown };
    const panelError = createPanelMessageRequestError({
      error: { code: 'RELAY_AUTH_FAILED', message: 'Relay 认证失败', details: { token: 'must-not-leak' } },
    });
    expect(panelError.message).toBe('Relay 认证失败');
    expect(panelError.code).toBe('RELAY_AUTH_FAILED');
    expect(panelError).not.toHaveProperty('details');
    expect(String(panelError)).not.toContain('[object Object]');
    expect(html).toContain('const panelFileRuntime = (');
    expect(html).toContain('file: panelFileRuntime,');
    expect(html).not.toContain('editor.panel.define');
    expect(html).not.toContain('/api/assets/panel-module/');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refreshes the injected capability from a no-store HTML response', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-refresh-test-'));
    const panelPath = path.join(tmpDir, 'index.js');
    fs.writeFileSync(panelPath, 'export default { methods: {} };');
    const panel = new PanelModule();
    panel.register('@scope/demo.preview', panelPath);
    const router = createPanelAssetRouter(panel);
    const { res, body } = mockRes();

    router(mockReq('GET', '/api/assets/panel/%40scope%2Fdemo.preview/index.html'), res);
    const html = body();
    const refreshStart = html.indexOf('async function refreshPanelCapability()');
    const refreshEnd = html.indexOf('function encodePanelAssetPath', refreshStart);
    expect(refreshStart).toBeGreaterThan(-1);
    expect(refreshEnd).toBeGreaterThan(refreshStart);
    const refreshSource = html.slice(refreshStart, refreshEnd);
    let fetchCalls = 0;
    const runtime = new Function('fetch', 'window', `
      let panelCapability = 'stale';
      let panelCapabilityRefreshPromise = null;
      ${refreshSource}
      return { refreshPanelCapability, getCapability: () => panelCapability };
    `)(
      async () => {
        fetchCalls += 1;
        return {
          ok: true,
          text: async () => '<script>let panelCapability = "fresh";</script>',
        };
      },
      { location: { href: '/api/assets/panel/%40scope%2Fdemo.preview/index.html' } },
    ) as { refreshPanelCapability(): Promise<boolean>; getCapability(): string };

    await expect(runtime.refreshPanelCapability()).resolves.toBe(true);
    expect(runtime.getCapability()).toBe('fresh');
    expect(fetchCalls).toBe(1);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refreshes once in the generated request runtime and does not loop on a second 403', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-request-refresh-test-'));
    const panelPath = path.join(tmpDir, 'index.js');
    fs.writeFileSync(panelPath, 'export default { methods: {} };');
    const panel = new PanelModule();
    panel.register('@scope/demo.preview', panelPath);
    const router = createPanelAssetRouter(panel);
    const { res, body } = mockRes();

    router(mockReq('GET', '/api/assets/panel/%40scope%2Fdemo.preview/index.html'), res);
    const html = body();
    const refreshStart = html.indexOf('async function refreshPanelCapability()');
    const refreshEnd = html.indexOf('function encodePanelAssetPath', refreshStart);
    const requestStart = html.indexOf('async request(plugin, name, ...args) {');
    const requestEnd = html.indexOf('\n        },\n        broadcast', requestStart);
    expect(refreshStart).toBeGreaterThan(-1);
    expect(refreshEnd).toBeGreaterThan(refreshStart);
    expect(requestStart).toBeGreaterThan(-1);
    expect(requestEnd).toBeGreaterThan(requestStart);
    const refreshSource = html.slice(refreshStart, refreshEnd);
    const requestSource = `${html.slice(requestStart, requestEnd).trim()} }`;
    const errorStart = html.indexOf('function createPanelMessageRequestError(payload)');
    const errorEnd = html.indexOf('\n\n    async function refreshPanelCapability', errorStart);
    expect(errorStart).toBeGreaterThan(-1);
    expect(errorEnd).toBeGreaterThan(errorStart);
    const errorSource = html.slice(errorStart, errorEnd);

    const makeRequest = (fetchImpl: (url: string, options?: RequestInit) => Promise<unknown>) => new Function(
      'fetch',
      'window',
      `
        const sessionId = 'test-session';
        let panelCapability = 'stale';
        let panelCapabilityRefreshPromise = null;
        ${errorSource}
        ${refreshSource}
        return ({ ${requestSource} }).request;
      `,
    )(fetchImpl, { location: { href: '/api/assets/panel/%40scope%2Fdemo.preview/index.html' } }) as (
      plugin: string,
      name: string,
      ...args: unknown[]
    ) => Promise<unknown>;
    const response = (status: number, payload: unknown) => ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => payload,
    });

    const successfulCalls: Array<{ url: string; options?: RequestInit }> = [];
    const successfulRequest = makeRequest(async (url, options) => {
      successfulCalls.push({ url, options });
      if (successfulCalls.length === 1) {
        return response(403, { error: { code: 'PANEL_CAPABILITY_INVALID', message: 'expired' } });
      }
      if (successfulCalls.length === 2) {
        return {
          ok: true,
          text: async () => '<script>let panelCapability = "fresh";</script>',
        };
      }
      return response(200, { result: 'ok' });
    });
    await expect(successfulRequest('owner', 'read')).resolves.toBe('ok');
    expect(successfulCalls).toHaveLength(3);
    expect(JSON.parse(String(successfulCalls[0].options?.body)).panelCapability).toBe('stale');
    expect(JSON.parse(String(successfulCalls[2].options?.body)).panelCapability).toBe('fresh');

    const loopingCalls: Array<{ url: string; options?: RequestInit }> = [];
    const loopingRequest = makeRequest(async (url, options) => {
      loopingCalls.push({ url, options });
      if (loopingCalls.length === 2) {
        return {
          ok: true,
          text: async () => '<script>let panelCapability = "fresh";</script>',
        };
      }
      return response(403, { error: { code: 'PANEL_CAPABILITY_INVALID', message: 'still expired' } });
    });
    await expect(loopingRequest('owner', 'read')).rejects.toMatchObject({
      code: 'PANEL_CAPABILITY_INVALID',
    });
    expect(loopingCalls).toHaveLength(3);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('injects a safe panel host fallback when BroadcastChannel is unavailable', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-fallback-test-'));
    const panelPath = path.join(tmpDir, 'index.js');
    fs.writeFileSync(panelPath, 'export default { methods: {} };');
    const panel = new PanelModule();
    panel.register('@scope/demo.preview', panelPath);
    const router = createPanelAssetRouter(panel);
    const { res, body, statusCode } = mockRes();

    router(mockReq('GET', '/api/assets/panel/%40scope%2Fdemo.preview/index.html'), res);

    const html = body();
    expect(statusCode()).toBe(200);
    expect(html).toContain('window.__panelChannel = createSessionChannel(channelName);');
    expect(html).toContain('function createSessionChannel(name)');
    expect(html).toContain('catch {\n        return null;');
    expect(html).toContain('function notifyPanelHost(message)');
    expect(html).toContain('const targets = [window.parent, window.opener];');
    expect(html).toContain("notifyPanelHost({ type: 'ce-open-panel-result', payload });");
    expect(html).toContain("notifyPanelHost({ type: 'ce-open-panel-floating', payload: fallback });");
    expect(html).not.toContain("window.__panelChannel?.postMessage({ type: 'ce-open-panel-result', payload });");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('injects a boolean-validated API for requesting full-workspace panel modality', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-modal-test-'));
    const panelPath = path.join(tmpDir, 'index.js');
    fs.writeFileSync(panelPath, 'export default { methods: {} };');
    const panel = new PanelModule();
    panel.register('@scope/demo.preview', panelPath);
    const router = createPanelAssetRouter(panel);
    const { res, body, statusCode } = mockRes();

    router(mockReq('GET', '/api/assets/panel/%40scope%2Fdemo.preview/index.html'), res);

    const html = body();
    expect(statusCode()).toBe(200);
    expect(html).toContain('panel: {');
    expect(html).toContain('setModalOpen(open) {');
    expect(html).toContain("if (typeof open !== 'boolean') return;");
    expect(html).toContain("notifyPanelHost({ type: 'ce-panel-modal-state', open });");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves contributed panel HTML files with injected runtime and default export bootstrap', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-html-test-'));
    const panelPath = path.join(tmpDir, 'index.html');
    fs.writeFileSync(panelPath, '<!DOCTYPE html><html><body><div id="panel-root"></div></body></html>');
    const panel = new PanelModule();
    panel.register('@scope/html.preview', panelPath);
    const router = createPanelAssetRouter(panel);
    const { res, body, statusCode } = mockRes();

    router(mockReq('GET', '/api/assets/panel/%40scope%2Fhtml.preview/index.html'), res);

    const html = body();
    expect(statusCode()).toBe(200);
    expect(html).toContain('window.editor = {');
    expect(html).toContain("await import('./index.js')");
    expect(html).toContain('Panel module must default-export a PanelDefinition object');
    expect(html).toContain('window.__panelDefinition = definition;');
    expect(html).not.toContain('DOMContentLoaded');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves sibling files from the contributed panel directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-file-test-'));
    const panelPath = path.join(tmpDir, 'index.html');
    const filePath = path.join(tmpDir, 'mesh.glb');
    fs.writeFileSync(panelPath, '<!DOCTYPE html><html><body></body></html>');
    fs.writeFileSync(filePath, 'glb-data');
    const panel = new PanelModule();
    panel.register('@scope/html.preview', panelPath);
    const router = createPanelAssetRouter(panel);
    const { res, body, statusCode, header } = mockRes();

    router(mockReq('GET', '/api/assets/panel/%40scope%2Fhtml.preview/mesh.glb'), res);

    expect(statusCode()).toBe(200);
    expect(header('content-type')).toBe('model/gltf-binary');
    expect(body()).toBe('glb-data');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    ['index.js', 'text/javascript; charset=utf-8'],
    ['module.mjs', 'text/javascript; charset=utf-8'],
    ['style.css', 'text/css; charset=utf-8'],
    ['partial.html', 'text/html; charset=utf-8'],
  ])('serves sibling %s assets with the correct content type', (filename, contentType) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-mime-test-'));
    const panelPath = path.join(tmpDir, 'index.html');
    fs.writeFileSync(panelPath, '<!DOCTYPE html><html><body></body></html>');
    fs.writeFileSync(path.join(tmpDir, filename), 'asset-data');
    const panel = new PanelModule();
    panel.register('@scope/html.preview', panelPath);
    const router = createPanelAssetRouter(panel);
    const { res, body, statusCode, header } = mockRes();

    router(mockReq('GET', `/api/assets/panel/%40scope%2Fhtml.preview/${filename}`), res);

    expect(statusCode()).toBe(200);
    expect(header('content-type')).toBe(contentType);
    expect(body()).toBe('asset-data');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects sibling asset path traversal outside the panel directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-file-traversal-test-'));
    const panelPath = path.join(tmpDir, 'index.html');
    const outsidePath = path.join(path.dirname(tmpDir), 'outside.glb');
    fs.writeFileSync(panelPath, '<!DOCTYPE html><html><body></body></html>');
    fs.writeFileSync(outsidePath, 'outside-data');
    const panel = new PanelModule();
    panel.register('@scope/html.preview', panelPath);
    const router = createPanelAssetRouter(panel);
    const { res, body, statusCode } = mockRes();

    router(mockReq('GET', '/api/assets/panel/%40scope%2Fhtml.preview/..%2Foutside.glb'), res);

    expect(statusCode()).toBe(404);
    expect(body()).toContain('Panel asset not found');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outsidePath, { force: true });
  });

  it('rejects sibling asset symlinks that resolve outside the panel directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-file-symlink-test-'));
    const panelPath = path.join(tmpDir, 'index.html');
    const outsidePath = path.join(path.dirname(tmpDir), 'outside-symlink.glb');
    const linkPath = path.join(tmpDir, 'linked.glb');
    fs.writeFileSync(panelPath, '<!DOCTYPE html><html><body></body></html>');
    fs.writeFileSync(outsidePath, 'outside-data');
    fs.symlinkSync(outsidePath, linkPath);
    const panel = new PanelModule();
    panel.register('@scope/html.preview', panelPath);
    const router = createPanelAssetRouter(panel);
    const { res, body, statusCode } = mockRes();

    router(mockReq('GET', '/api/assets/panel/%40scope%2Fhtml.preview/linked.glb'), res);

    expect(statusCode()).toBe(404);
    expect(body()).toContain('Panel asset not found');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outsidePath, { force: true });
  });

  it('does not serve legacy panel module routes', () => {
    const panel = new PanelModule();
    panel.register('@scope/demo.preview', '/tmp/demo/index.js');
    const router = createPanelAssetRouter(panel);
    const { res, body, statusCode } = mockRes();

    router(mockReq('GET', '/api/assets/panel-module/%40scope%2Fdemo.preview.js'), res);

    expect(statusCode()).toBe(404);
    expect(body()).toContain('Not found');
  });

  it('does not serve legacy panel file routes', () => {
    const panel = new PanelModule();
    panel.register('@scope/demo.preview', '/tmp/demo/index.html');
    const router = createPanelAssetRouter(panel);
    const { res, body, statusCode } = mockRes();

    router(mockReq('GET', '/api/assets/panel-file/%40scope%2Fdemo.preview/mesh.glb'), res);

    expect(statusCode()).toBe(404);
    expect(body()).toContain('Not found');
  });
});
