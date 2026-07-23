import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { createKitManagerView } from './kit-manager-view.mjs';

const htmlUrl = new URL('../kit-manager.html', import.meta.url);
const cssUrl = new URL('../kit-manager.css', import.meta.url);
const rendererUrl = new URL('../kit-manager-renderer.mjs', import.meta.url);

function snapshot(overrides = {}) {
  return {
    source: 'network',
    stale: false,
    validatedAt: '2026-07-23T10:00:00.000Z',
    kits: [{
      id: '@itharbors/kit-sqlite',
      label: 'SQLite Workbench',
      publisher: 'itharbors',
      summary: 'Inspect and edit local SQLite databases.',
      channels: {
        stable: { version: '1.2.0', permissions: ['filesystem', 'native-code'] },
        preview: { version: '1.3.0-preview.abc1234', permissions: ['filesystem', 'native-code'] },
      },
    }],
    ...overrides,
  };
}

async function createView({ api, initial = snapshot(), confirmInstall } = {}) {
  const html = await readFile(htmlUrl, 'utf8');
  const dom = new JSDOM(html, { url: 'file:///kit-manager.html' });
  const calls = [];
  const defaultApi = {
    list: async () => initial,
    refresh: async () => initial,
    install: async (value) => { calls.push(['install', value]); return { status: 'installed' }; },
    activate: async (value) => { calls.push(['activate', value]); return { requiresRestart: true }; },
    rollback: async (value) => { calls.push(['rollback', value]); return { requiresRestart: true }; },
  };
  const resolvedApi = { ...defaultApi, ...api };
  const view = createKitManagerView({
    document: dom.window.document,
    api: resolvedApi,
    confirmInstall: confirmInstall ?? (() => true),
  });
  return { dom, document: dom.window.document, view, calls, api: resolvedApi };
}

test('uses a locked-down local document with semantic landmarks and no inline or remote resources', async () => {
  const [html, css, renderer] = await Promise.all([
    readFile(htmlUrl, 'utf8'), readFile(cssUrl, 'utf8'), readFile(rendererUrl, 'utf8'),
  ]);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /style-src 'self'/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(`${html}\n${css}\n${renderer}`, /https?:\/\//i);
  for (const element of ['aside', 'header', 'main', 'section', 'footer']) {
    assert.match(html, new RegExp(`<${element}\\b`, 'i'));
  }
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
});

test('renders loading, online empty, offline cache, and unavailable states with direction', async () => {
  let resolveList;
  const pending = new Promise((resolve) => { resolveList = resolve; });
  const value = await createView({ api: { list: async () => pending } });
  const starting = value.view.start();
  assert.equal(value.document.querySelector('main').getAttribute('aria-busy'), 'true');
  assert.match(value.document.querySelector('#registry-status').textContent, /Loading/i);
  resolveList(snapshot({ kits: [] }));
  await starting;
  assert.match(value.document.querySelector('#registry-status').textContent, /Registry online/i);
  assert.match(value.document.querySelector('#stable-empty').textContent, /No Kits are published yet/i);

  value.view.render(snapshot({
    source: 'cache', stale: true, kits: [],
    error: { code: 'NETWORK_ERROR', message: 'Registry refresh failed' },
  }));
  assert.match(value.document.querySelector('#registry-status').textContent, /Offline cache/i);
  assert.match(value.document.querySelector('#registry-notice').textContent, /Registry refresh failed/i);

  value.view.render(snapshot({ source: 'none', stale: true, validatedAt: null, kits: [] }));
  assert.match(value.document.querySelector('#registry-status').textContent, /Market unavailable/i);
  assert.match(value.document.querySelector('#stable-empty').textContent, /Refresh when.*online/i);
});

test('renders stable and collapsed preview berths with permissions and lifecycle state', async () => {
  const value = await createView({
    initial: snapshot({
      kits: [{
        ...snapshot().kits[0],
        installed: {
          active: '1.1.0',
          previous: '1.0.0',
          pending: '1.2.0',
          channel: 'stable',
          autoUpdate: true,
          versions: ['1.0.0', '1.1.0', '1.2.0', '1.3.0-preview.abc1234'],
          badVersions: ['1.3.0-preview.abc1234'],
        },
      }],
    }),
  });
  await value.view.start();
  const stable = value.document.querySelector('[data-kit-id="@itharbors/kit-sqlite"][data-channel="stable"]');
  assert.match(stable.textContent, /SQLite Workbench/);
  assert.match(stable.textContent, /itharbors/);
  assert.match(stable.textContent, /1\.2\.0/);
  assert.match(stable.textContent, /Queued for restart/i);
  assert.match(stable.textContent, /Native code — elevated risk/i);
  assert.equal(stable.querySelector('[data-action="activate"]').disabled, true);
  assert.ok(stable.querySelector('[data-action="rollback"]'));
  const preview = value.document.querySelector('#preview-section');
  assert.equal(preview.open, false);
  assert.match(preview.textContent, /Preview/);
  assert.match(preview.textContent, /Marked bad/i);
  assert.match(preview.querySelector('[data-action="activate"]').textContent, /Retry after restart/i);
});

test('confirms native code, installs a selected channel, and refreshes the installed projection', async () => {
  const calls = [];
  let current = snapshot();
  const api = {
    list: async () => current,
    install: async (input) => {
      calls.push(['install', input]);
      current = snapshot({
        kits: [{
          ...snapshot().kits[0],
          installed: {
            channel: 'stable', autoUpdate: true, versions: ['1.2.0'], badVersions: [],
          },
        }],
      });
      return { status: 'installed' };
    },
  };
  const confirmations = [];
  const value = await createView({
    api,
    confirmInstall: (details) => { confirmations.push(details); return true; },
  });
  await value.view.start();
  value.document.querySelector('[data-channel="stable"] [data-action="install"]').click();
  await value.view.whenIdle();
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /native code/i);
  assert.deepEqual(calls, [[
    'install', { id: '@itharbors/kit-sqlite', version: '1.2.0', channel: 'stable' },
  ]]);
  assert.match(value.document.querySelector('#operation-status').textContent, /Installed.*restart/i);
  assert.match(value.document.querySelector('[data-channel="stable"]').textContent, /Installed/i);
});

test('does not install native code when confirmation is declined', async () => {
  const value = await createView({ confirmInstall: () => false });
  await value.view.start();
  value.document.querySelector('[data-channel="stable"] [data-action="install"]').click();
  await value.view.whenIdle();
  assert.deepEqual(value.calls, []);
});

test('queues activation, explicit bad retry, and rollback while disabling concurrent controls', async () => {
  let releaseActivation;
  const activationGate = new Promise((resolve) => { releaseActivation = resolve; });
  const calls = [];
  const installed = snapshot({
    kits: [{
      ...snapshot().kits[0],
      installed: {
        active: '1.1.0', previous: '1.0.0', channel: 'stable', autoUpdate: true,
        versions: ['1.0.0', '1.1.0', '1.2.0', '1.3.0-preview.abc1234'],
        badVersions: ['1.3.0-preview.abc1234'],
      },
    }],
  });
  const api = {
    list: async () => installed,
    activate: async (input) => { calls.push(['activate', input]); await activationGate; },
    rollback: async (input) => { calls.push(['rollback', input]); },
  };
  const value = await createView({ api });
  await value.view.start();
  const activate = value.document.querySelector('[data-channel="stable"] [data-action="activate"]');
  activate.click();
  assert.equal(value.document.querySelector('main').getAttribute('aria-busy'), 'true');
  assert.equal([...value.document.querySelectorAll('button')].every((button) => button.disabled), true);
  releaseActivation();
  await value.view.whenIdle();
  assert.deepEqual(calls[0], ['activate', {
    id: '@itharbors/kit-sqlite', version: '1.2.0', retryBad: false,
  }]);

  value.document.querySelector('[data-channel="preview"] [data-action="activate"]').click();
  await value.view.whenIdle();
  assert.deepEqual(calls[1], ['activate', {
    id: '@itharbors/kit-sqlite', version: '1.3.0-preview.abc1234', retryBad: true,
  }]);
  value.document.querySelector('[data-channel="stable"] [data-action="rollback"]').click();
  await value.view.whenIdle();
  assert.deepEqual(calls[2], ['rollback', '@itharbors/kit-sqlite']);
});

test('recovers controls after refresh and operation errors without inserting remote HTML', async () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const api = {
    list: async () => snapshot({ kits: [{ ...snapshot().kits[0], label: malicious }] }),
    refresh: async () => { throw Object.assign(new Error('Registry unavailable'), { code: 'TIMEOUT' }); },
    install: async () => { throw Object.assign(new Error('Artifact rejected'), { code: 'DIGEST_MISMATCH' }); },
  };
  const value = await createView({ api });
  await value.view.start();
  assert.equal(value.document.querySelector('[data-channel="stable"] img'), null);
  assert.match(value.document.querySelector('[data-channel="stable"] h3').textContent, /<img/);
  value.document.querySelector('#refresh-button').click();
  await value.view.whenIdle();
  assert.match(value.document.querySelector('#operation-status').textContent, /Registry unavailable/);
  assert.equal(value.document.querySelector('#refresh-button').disabled, false);
  value.document.querySelector('[data-channel="stable"] [data-action="install"]').click();
  await value.view.whenIdle();
  assert.match(value.document.querySelector('#operation-status').textContent, /Artifact rejected/);
  assert.equal(value.document.querySelector('[data-action="install"]').disabled, false);
});
