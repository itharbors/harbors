import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html>');
Object.assign(globalThis, { window: dom.window, document: dom.window.document });
const { buildProxyUrl, validateProxySessionResponse } = await import('./index.ts');

function response() {
  return {
    sessionId: 'session-test',
    port: 49391,
    path: '/preview/session/test?resource=%2F',
    expiresAt: Date.now() + 60_000,
  };
}

test('uses the current IPv4 or hostname while replacing only the proxy port', () => {
  const value = response();
  assert.equal(buildProxyUrl(value, 'http://127.0.0.1:49380/panel'), 'http://127.0.0.1:49391/preview/session/test?resource=%2F');
  assert.equal(buildProxyUrl(value, 'http://harbors.local:49380/panel'), 'http://harbors.local:49391/preview/session/test?resource=%2F');
});

test('formats IPv6 hosts correctly', () => {
  assert.equal(buildProxyUrl(response(), 'http://[::1]:49380/panel'), 'http://[::1]:49391/preview/session/test?resource=%2F');
});

test('rejects HTTPS pages in the first local HTTP-only version', () => {
  assert.throws(() => buildProxyUrl(response(), 'https://harbors.local/panel'), /HTTPS 页面暂不支持/);
});

test('strictly validates proxy port, path, and expiry', () => {
  assert.throws(() => validateProxySessionResponse({ ...response(), port: 0 }), /端口无效/);
  assert.throws(() => validateProxySessionResponse({ ...response(), path: '//attacker.test/p' }), /路径无效/);
  assert.throws(() => validateProxySessionResponse({ ...response(), expiresAt: Date.now() - 1 }), /已过期/);
});
