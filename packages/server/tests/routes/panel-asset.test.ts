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
    const { res, body, statusCode } = mockRes();

    router(mockReq('GET', '/api/assets/panel/%40scope%2Fdemo.preview/index.html'), res);

    const html = body();
    expect(statusCode()).toBe(200);
    expect(html).toContain("await import('./index.js')");
    expect(html).toContain('const definition = panelModule.default;');
    expect(html).toContain('Panel module must default-export a PanelDefinition object');
    expect(html).toContain('window.__panelDefinition = definition;');
    expect(html).toContain('window.editor = {');
    expect(html).not.toContain('editor.panel.define');
    expect(html).not.toContain('/api/assets/panel-module/');
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
