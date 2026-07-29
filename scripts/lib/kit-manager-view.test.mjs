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
    activate: async (value) => { calls.push(['activate', value]); return { runtimeReloaded: true }; },
    rollback: async (value) => { calls.push(['rollback', value]); return { runtimeReloaded: true }; },
    uninstall: async (value) => { calls.push(['uninstall', value]); return { runtimeReloaded: true }; },
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
  const document = new JSDOM(html).window.document;
  assert.equal(document.documentElement.lang, 'zh-CN');
  assert.match(document.body.textContent, /Kit 管理/);
  assert.match(document.body.textContent, /稳定版/);
  assert.match(document.body.textContent, /预览版/);
  assert.match(document.body.textContent, /仅限已验证 Kit/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
  assert.match(
    css,
    /\.operation-status\s*\{[^}]*position:\s*sticky;[^}]*top:\s*12px;[^}]*z-index:\s*[1-9]\d*;/su,
  );
});

test('renders one horizontal resource row per channel with four stable regions', async () => {
  const [html, css] = await Promise.all([
    readFile(htmlUrl, 'utf8'),
    readFile(cssUrl, 'utf8'),
  ]);
  const value = await createView();
  await value.view.start();

  assert.equal(value.document.querySelector('#stable-list').className, 'kit-list');
  assert.equal(value.document.querySelector('#preview-list').className, 'kit-list');
  for (const row of value.document.querySelectorAll('[data-kit-id]')) {
    assert.equal(row.classList.contains('kit-row'), true);
    assert.ok(row.querySelector('.kit-row__identity'));
    assert.ok(row.querySelector('.kit-row__release'));
    assert.ok(row.querySelector('.kit-row__installed'));
    assert.ok(row.querySelector('.kit-row__actions'));
  }

  const styleDom = new JSDOM(`<!doctype html><style>${css}</style><div class="kit-list"><article class="kit-row"></article></div>`);
  const listStyle = styleDom.window.getComputedStyle(styleDom.window.document.querySelector('.kit-list'));
  const rowStyle = styleDom.window.getComputedStyle(styleDom.window.document.querySelector('.kit-row'));
  assert.equal(listStyle.display, 'grid');
  assert.equal(listStyle.gridTemplateColumns, 'minmax(0, 1fr)');
  assert.equal(rowStyle.display, 'grid');
  assert.equal(rowStyle.minHeight, '118px');
  assert.equal(rowStyle.borderLeftWidth, '4px');
  assert.match(html, /class="kit-list"/);
});

test('renders loading, online empty, offline cache, and unavailable states with direction', async () => {
  let resolveList;
  const pending = new Promise((resolve) => { resolveList = resolve; });
  const value = await createView({ api: { list: async () => pending } });
  const starting = value.view.start();
  assert.equal(value.document.querySelector('main').getAttribute('aria-busy'), 'true');
  assert.match(value.document.querySelector('#registry-status').textContent, /正在加载 Kit 仓库/);
  resolveList(snapshot({ kits: [] }));
  await starting;
  assert.match(value.document.querySelector('#registry-status').textContent, /Kit 仓库在线/);
  assert.match(value.document.querySelector('#stable-empty').textContent, /尚未发布 Kit/);

  value.view.render(snapshot({
    source: 'cache', stale: true, kits: [],
    error: { code: 'NETWORK_ERROR', message: 'Registry refresh failed' },
  }));
  assert.match(value.document.querySelector('#registry-status').textContent, /离线缓存/);
  assert.match(value.document.querySelector('#registry-notice').textContent, /Registry refresh failed/i);

  value.view.render(snapshot({ source: 'none', stale: true, validatedAt: null, kits: [] }));
  assert.match(value.document.querySelector('#registry-status').textContent, /Kit 仓库不可用/);
  assert.match(value.document.querySelector('#stable-empty').textContent, /联网后刷新/);
});

test('keeps the compact header count aligned with unique installed Kits', async () => {
  const baseKit = snapshot().kits[0];
  const installedKits = ['csv', 'mysql', 'notifications', 'sqlite'].map((slug) => ({
    ...baseKit,
    id: `@itharbors/kit-${slug}`,
    label: slug,
    channels: { stable: baseKit.channels.stable },
    installed: {
      active: '1.2.0', channel: 'stable', autoUpdate: true,
      versions: ['1.2.0'], badVersions: [],
    },
  }));
  const value = await createView({ initial: snapshot({ kits: installedKits }) });

  await value.view.start();

  const installedCount = value.document.querySelector('#installed-count');
  assert.ok(installedCount);
  assert.equal(installedCount.textContent, '4 个已安装');
  value.view.render(snapshot({ kits: [] }));
  assert.equal(installedCount.textContent, '0 个已安装');

  const css = await readFile(cssUrl, 'utf8');
  const styleDom = new JSDOM(`<!doctype html><style>${css}</style><div class="dock-shell"><header class="dock-header"></header></div>`);
  const shellStyle = styleDom.window.getComputedStyle(styleDom.window.document.querySelector('.dock-shell'));
  const headerStyle = styleDom.window.getComputedStyle(styleDom.window.document.querySelector('.dock-header'));
  assert.equal(shellStyle.gridTemplateColumns, '68px minmax(0, 1fr)');
  assert.equal(headerStyle.display, 'grid');
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
  assert.match(stable.textContent, /正在应用/);
  assert.match(stable.textContent, /原生代码 — 高风险/);
  assert.equal(stable.querySelector('[data-action="activate"]').disabled, true);
  const preview = value.document.querySelector('#preview-section');
  assert.equal(preview.open, false);
  assert.match(preview.textContent, /预览版/);
  assert.match(preview.textContent, /已标记异常/);
  assert.match(preview.querySelector('[data-action="activate"]').textContent, /立即重试/);
  assert.equal(value.document.querySelectorAll('[data-action="uninstall"]').length, 1);
});

test('shows every retained version with current and abnormal state on the installed owner row', async () => {
  const value = await createView({
    initial: snapshot({
      kits: [{
        ...snapshot().kits[0],
        installed: {
          active: '1.10.0', previous: '1.9.0', channel: 'stable', autoUpdate: true,
          versions: ['2.0.0', '1.10.0', '1.9.0'],
          badVersions: ['2.0.0'],
        },
      }],
    }),
  });

  await value.view.start();

  const stable = value.document.querySelector('[data-channel="stable"]');
  const select = stable.querySelector('[data-role="installed-version"]');
  assert.deepEqual([...select.options].map((option) => option.value), [
    '2.0.0', '1.10.0', '1.9.0',
  ]);
  assert.match(select.options[0].textContent, /异常/);
  assert.match(select.options[1].textContent, /当前/);
  assert.equal(select.value, '1.10.0');
  const switchButton = stable.querySelector('[data-action="switch-version"]');
  assert.equal(switchButton.disabled, true);
  assert.equal(switchButton.textContent, '当前已启用');
  const uninstallButton = stable.querySelector('[data-action="uninstall"]');
  assert.equal(uninstallButton.textContent, '删除');
  assert.equal(uninstallButton.classList.contains('button--danger'), true);
  assert.equal(value.document.querySelector('[data-channel="preview"] [data-role="installed-version"]'), null);
  assert.equal(value.document.querySelector('[data-action="rollback"]'), null);
});

test('renders builtin Kits without an install action', async () => {
  const value = await createView({
    initial: snapshot({
      kits: [{ ...snapshot().kits[0], builtin: true }],
    }),
  });

  await value.view.start();

  const button = value.document.querySelector('[data-channel="stable"] [data-action="builtin"]');
  assert.equal(button.textContent, '内置');
  assert.equal(button.disabled, true);
  assert.equal(value.document.querySelector('[data-action="install"]'), null);
  assert.equal(value.document.querySelector('[data-role="installed-version"]'), null);
  assert.deepEqual(value.calls, []);
});

test('does not show version history before a Kit is installed', async () => {
  const value = await createView();
  await value.view.start();
  assert.equal(value.document.querySelector('[data-role="installed-version"]'), null);
});

test('confirms native code, installs a selected channel, and refreshes the installed projection', async () => {
  const calls = [];
  let current = snapshot();
  let releaseInstall;
  const installGate = new Promise((resolve) => { releaseInstall = resolve; });
  let markInstallStarted;
  const installStarted = new Promise((resolve) => { markInstallStarted = resolve; });
  const api = {
    list: async () => current,
    install: async (input) => {
      calls.push(['install', input]);
      markInstallStarted();
      await installGate;
      current = snapshot({
        kits: [{
          ...snapshot().kits[0],
          installed: {
            active: '1.2.0', channel: 'stable', autoUpdate: true,
            versions: ['1.2.0'], badVersions: [],
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
  await installStarted;
  let stable = value.document.querySelector('[data-channel="stable"]');
  assert.equal(stable.dataset.operation, 'install');
  assert.equal(stable.querySelector('.kit-row__progress').hidden, false);
  assert.match(stable.querySelector('.kit-row__progress').textContent, /正在下载并验证/);
  assert.equal(stable.querySelector('.kit-row__spinner').getAttribute('aria-hidden'), 'true');
  assert.match(
    value.document.querySelector('#operation-status').textContent,
    /正在安装并应用 SQLite Workbench 1\.2\.0/,
  );
  assert.equal(value.document.querySelector('#operation-status').getAttribute('role'), 'status');
  releaseInstall();
  await value.view.whenIdle();
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /包含原生代码/);
  assert.match(confirmations[0], /1\.2\.0/);
  assert.deepEqual(calls, [[
    'install', { id: '@itharbors/kit-sqlite', version: '1.2.0', channel: 'stable' },
  ]]);
  assert.match(value.document.querySelector('#operation-status').textContent, /已安装并启用/);
  assert.doesNotMatch(value.document.querySelector('#operation-status').textContent, /重启/);
  assert.match(value.document.querySelector('[data-channel="stable"]').textContent, /已启用/);
  stable = value.document.querySelector('[data-channel="stable"]');
  assert.equal(stable.dataset.operation, undefined);
  assert.equal(stable.querySelector('.kit-row__progress').hidden, true);
});

test('does not install native code when confirmation is declined', async () => {
  const value = await createView({ confirmInstall: () => false });
  await value.view.start();
  value.document.querySelector('[data-channel="stable"] [data-action="install"]').click();
  await value.view.whenIdle();
  assert.deepEqual(value.calls, []);
});

test('switches to retained versions and explicitly retries abnormal versions', async () => {
  let releaseActivation;
  const activationGate = new Promise((resolve) => { releaseActivation = resolve; });
  const calls = [];
  const confirmations = [];
  const installed = snapshot({
    kits: [{
      ...snapshot().kits[0],
      installed: {
        active: '1.10.0', previous: '1.9.0', channel: 'stable', autoUpdate: true,
        versions: ['2.0.0', '1.10.0', '1.9.0'],
        badVersions: ['2.0.0'],
      },
    }],
  });
  const api = {
    list: async () => installed,
    activate: async (input) => { calls.push(['activate', input]); await activationGate; },
  };
  const value = await createView({
    api,
    confirmInstall: (message) => { confirmations.push(message); return true; },
  });
  await value.view.start();
  let select = value.document.querySelector('[data-role="installed-version"]');
  let switchButton = value.document.querySelector('[data-action="switch-version"]');
  select.value = '1.9.0';
  select.dispatchEvent(new value.dom.window.Event('change'));
  assert.equal(switchButton.textContent, '切换到此版本');
  assert.equal(switchButton.disabled, false);
  switchButton.click();
  assert.equal(value.document.querySelector('main').getAttribute('aria-busy'), 'true');
  assert.equal([...value.document.querySelectorAll('button, select')].every((control) => control.disabled), true);
  releaseActivation();
  await value.view.whenIdle();
  assert.deepEqual(calls[0], ['activate', {
    id: '@itharbors/kit-sqlite', version: '1.9.0', retryBad: false,
  }]);
  assert.match(confirmations[0], /1\.9\.0/);
  assert.match(confirmations[0], /重新加载所有 Kit 窗口/);

  select = value.document.querySelector('[data-role="installed-version"]');
  switchButton = value.document.querySelector('[data-action="switch-version"]');
  select.value = '2.0.0';
  select.dispatchEvent(new value.dom.window.Event('change'));
  assert.equal(switchButton.textContent, '重试此版本');
  switchButton.click();
  await value.view.whenIdle();
  assert.deepEqual(calls[1], ['activate', {
    id: '@itharbors/kit-sqlite', version: '2.0.0', retryBad: true,
  }]);
  assert.match(confirmations[1], /2\.0\.0/);
  assert.doesNotMatch(value.document.querySelector('#operation-status').textContent, /重启/);
});

test('renders one uninstall action, confirms all-version deletion, and refreshes projection', async () => {
  let current = snapshot({
    kits: [{
      ...snapshot().kits[0],
      channels: { preview: snapshot().kits[0].channels.preview },
      installed: {
        active: '1.3.0-preview.abc1234', channel: 'preview', autoUpdate: false,
        versions: ['1.2.0', '1.3.0-preview.abc1234'], badVersions: [],
      },
    }],
  });
  const calls = [];
  const confirmations = [];
  const value = await createView({
    api: {
      list: async () => current,
      uninstall: async (kitId) => {
        calls.push(['uninstall', kitId]);
        current = snapshot({ kits: [] });
        return { runtimeReloaded: true };
      },
    },
    confirmInstall: (message) => { confirmations.push(message); return true; },
  });
  await value.view.start();

  const buttons = value.document.querySelectorAll('[data-action="uninstall"]');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].closest('[data-channel]').dataset.channel, 'preview');
  buttons[0].click();
  await value.view.whenIdle();

  assert.deepEqual(calls, [['uninstall', '@itharbors/kit-sqlite']]);
  assert.match(confirmations.at(-1), /关闭该 Kit 窗口/);
  assert.match(confirmations.at(-1), /全部已安装版本/);
  assert.match(value.document.querySelector('#operation-status').textContent, /已删除/);
  assert.equal(value.document.querySelector('[data-action="uninstall"]'), null);
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
  const stable = value.document.querySelector('[data-channel="stable"]');
  assert.equal(stable.dataset.operation, undefined);
  assert.equal(stable.querySelector('.kit-row__progress').hidden, true);
});
