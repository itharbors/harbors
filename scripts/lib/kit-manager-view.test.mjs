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

function workspaceSnapshot(overrides = {}) {
  const releases = snapshot().kits[0].channels;
  return snapshot({
    kits: [
      {
        id: '@itharbors/kit-csv',
        label: 'CSV',
        publisher: 'itharbors',
        summary: 'CSV/TSV 文件浏览、筛选、排序与导出工作台',
        channels: { stable: { ...releases.stable, version: '1.2.0' } },
        installed: {
          active: '1.2.0',
          channel: 'stable',
          autoUpdate: true,
          versions: ['1.2.0', '1.1.0'],
          badVersions: [],
        },
      },
      {
        id: '@itharbors/kit-mysql',
        label: 'MySQL',
        publisher: 'itharbors',
        summary: 'MySQL 数据库连接、浏览、编辑与 SQL 工作台',
        channels: { stable: { ...releases.stable, version: '2.0.0' } },
        installed: {
          active: '2.0.0',
          channel: 'stable',
          autoUpdate: true,
          versions: ['2.0.0'],
          badVersions: [],
        },
      },
      {
        id: '@itharbors/kit-notifications',
        label: 'Notifications',
        publisher: 'itharbors',
        summary: '桌面通知中心',
        channels: { stable: { ...releases.stable, version: '0.8.0' } },
      },
    ],
    ...overrides,
  });
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
    deactivate: async (value) => { calls.push(['deactivate', value]); return { runtimeReloaded: true }; },
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
  assert.match(document.body.textContent, /停用/);
  assert.match(document.body.textContent, /仅限已验证 Kit/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
  assert.match(
    css,
    /\.operation-status\s*\{[^}]*position:\s*sticky;[^}]*top:\s*12px;[^}]*z-index:\s*[1-9]\d*;/su,
  );
});

test('renders a master-detail workspace and keeps a valid Kit selected across refreshes', async () => {
  const initial = workspaceSnapshot();
  const value = await createView({ initial });

  await value.view.start();

  assert.ok(value.document.querySelector('#kit-search'));
  assert.ok(value.document.querySelector('#kit-navigation'));
  assert.ok(value.document.querySelector('#kit-detail'));
  const items = value.document.querySelectorAll('[data-role="kit-list-item"]');
  assert.equal(items.length, 3);
  assert.equal(
    value.document.querySelector('[data-role="kit-list-item"][aria-selected="true"]').dataset.kitId,
    '@itharbors/kit-csv',
  );
  assert.match(value.document.querySelector('#kit-detail').textContent, /CSV/);
  assert.equal(value.document.querySelector('[data-role="installed-version"]'), null);
  assert.equal(value.document.querySelector('#kit-navigation [data-action="uninstall"]'), null);

  value.document.querySelector('[data-kit-id="@itharbors/kit-mysql"]').click();
  assert.match(value.document.querySelector('#kit-detail').textContent, /MySQL/);
  value.view.render(workspaceSnapshot());
  assert.equal(
    value.document.querySelector('[data-role="kit-list-item"][aria-selected="true"]').dataset.kitId,
    '@itharbors/kit-mysql',
  );

  value.view.render(workspaceSnapshot({
    kits: initial.kits.filter((kit) => kit.id !== '@itharbors/kit-mysql'),
  }));
  assert.equal(
    value.document.querySelector('[data-role="kit-list-item"][aria-selected="true"]').dataset.kitId,
    '@itharbors/kit-csv',
  );
});

test('filters the real Kit list by search and installed state with a directed empty result', async () => {
  const value = await createView({ initial: workspaceSnapshot() });
  await value.view.start();

  const search = value.document.querySelector('#kit-search');
  search.value = 'mysql';
  search.dispatchEvent(new value.dom.window.Event('input'));
  assert.deepEqual(
    [...value.document.querySelectorAll('[data-role="kit-list-item"]')]
      .map((item) => item.dataset.kitId),
    ['@itharbors/kit-mysql'],
  );
  assert.match(value.document.querySelector('#kit-detail').textContent, /MySQL/);

  value.document.querySelector('[data-filter="installed"]').click();
  assert.equal(value.document.querySelectorAll('[data-role="kit-list-item"]').length, 1);
  assert.match(value.document.querySelector('#kit-detail').textContent, /MySQL/);

  search.value = 'missing kit';
  search.dispatchEvent(new value.dom.window.Event('input'));
  assert.equal(value.document.querySelectorAll('[data-role="kit-list-item"]').length, 0);
  assert.equal(value.document.querySelector('#kit-list-empty').hidden, false);
  assert.match(value.document.querySelector('#kit-list-empty').textContent, /没有符合条件的 Kit/);
  assert.match(value.document.querySelector('#kit-detail').textContent, /选择一个 Kit/);
});

test('opens the preview channel when stable is empty on first load', async () => {
  const baseKit = snapshot().kits[0];
  const value = await createView({
    initial: snapshot({
      kits: [{
        ...baseKit,
        channels: { preview: baseKit.channels.preview },
        installed: {
          active: baseKit.channels.preview.version,
          channel: 'preview',
          autoUpdate: false,
          versions: [baseKit.channels.preview.version],
          badVersions: [],
        },
      }],
    }),
  });

  await value.view.start();

  assert.equal(value.document.querySelector('#channel-filter').value, 'preview');
  assert.equal(value.document.querySelectorAll('[data-role="kit-list-item"]').length, 1);
  assert.match(value.document.querySelector('#kit-detail').textContent, /SQLite Workbench/);
});

test('renders compact selectable list items without management controls', async () => {
  const value = await createView();
  await value.view.start();

  const item = value.document.querySelector('[data-role="kit-list-item"]');
  assert.equal(item.tagName, 'BUTTON');
  assert.equal(item.getAttribute('role'), 'option');
  assert.match(item.textContent, /SQLite Workbench/);
  assert.match(item.textContent, /1\.2\.0/);
  assert.equal(item.querySelector('.permission'), null);
  assert.equal(item.querySelector('[data-action]'), null);
  assert.equal(item.querySelector('select'), null);
  assert.match(value.document.querySelector('#kit-detail').textContent, /SQLite Workbench/);
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
  assert.equal(value.document.querySelector('#kit-list-empty').hidden, false);
  assert.match(value.document.querySelector('#kit-list-empty').textContent, /没有符合条件的 Kit/);

  value.view.render(snapshot({
    source: 'cache', stale: true, kits: [],
    error: { code: 'NETWORK_ERROR', message: 'Registry refresh failed' },
  }));
  assert.match(value.document.querySelector('#registry-status').textContent, /离线缓存/);
  assert.match(value.document.querySelector('#registry-notice').textContent, /Registry refresh failed/i);

  value.view.render(snapshot({ source: 'none', stale: true, validatedAt: null, kits: [] }));
  assert.match(value.document.querySelector('#registry-status').textContent, /Kit 仓库不可用/);
  assert.match(value.document.querySelector('#kit-detail').textContent, /选择一个 Kit/);
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

test('defines the Harbors master-detail visual contract and responsive single-pane mode', async () => {
  const css = await readFile(cssUrl, 'utf8');
  const styleDom = new JSDOM(`<!doctype html>
    <style>${css}</style>
    <section class="manager-workspace">
      <aside class="kit-browser">
        <button class="kit-list-item"></button>
      </aside>
      <section class="kit-detail"></section>
    </section>`);
  const workspaceStyle = styleDom.window.getComputedStyle(
    styleDom.window.document.querySelector('.manager-workspace'),
  );
  const listItemStyle = styleDom.window.getComputedStyle(
    styleDom.window.document.querySelector('.kit-list-item'),
  );

  assert.equal(workspaceStyle.display, 'grid');
  assert.equal(workspaceStyle.gridTemplateColumns, '320px minmax(0, 1fr)');
  assert.equal(listItemStyle.display, 'grid');
  for (const token of [
    '--manager-canvas',
    '--manager-surface',
    '--manager-ink',
    '--manager-muted',
    '--manager-action',
    '--manager-risk',
  ]) {
    assert.match(css, new RegExp(`${token}:`));
  }
  assert.match(css, /@media\s*\(max-width:\s*799px\)/);
  assert.match(css, /@media\s*\(max-width:\s*799px\)\s*and\s*\(max-height:\s*699px\)/);
  assert.match(css, /height:\s*calc\(100vh\s*-\s*296px\)/);
  assert.match(css, /\.manager-workspace\[data-mobile-view="detail"\]/);
  assert.match(css, /\.version-track__item::before/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /\.kit-row__release|\.kit-row__installed/);
});

test('returns from mobile Kit details without changing installed state', async () => {
  const value = await createView({ initial: workspaceSnapshot() });
  await value.view.start();

  value.document.querySelector('[data-kit-id="@itharbors/kit-mysql"]').click();
  assert.equal(value.document.querySelector('#manager-workspace').dataset.mobileView, 'detail');
  const back = value.document.querySelector('[data-action="back-to-list"]');
  assert.equal(back.textContent, '返回 Kit 列表');
  back.click();

  assert.equal(value.document.querySelector('#manager-workspace').dataset.mobileView, 'list');
  assert.equal(
    value.document.querySelector(
      '[data-role="kit-list-item"][aria-selected="true"]',
    ).dataset.kitId,
    '@itharbors/kit-mysql',
  );
  assert.deepEqual(value.calls, []);
});

test('renders overview, permission, and version tabs with high-risk permission semantics', async () => {
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
  assert.deepEqual(
    [...value.document.querySelectorAll('[data-detail-tab]')].map((tab) => tab.textContent),
    ['概览', '权限', '版本记录'],
  );
  assert.match(value.document.querySelector('[role="tabpanel"]').textContent, /1\.2\.0/);
  assert.match(value.document.querySelector('[role="tabpanel"]').textContent, /稳定版/);
  value.document.querySelector('[data-detail-tab="permissions"]').click();
  assert.match(value.document.querySelector('[role="tabpanel"]').textContent, /文件访问/);
  const nativePermission = value.document.querySelector('[data-permission="native-code"]');
  assert.match(nativePermission.textContent, /原生代码/);
  assert.equal(nativePermission.dataset.risk, 'high');
  assert.equal(value.document.querySelector('[data-action="activate"]').disabled, true);
});

test('shows every retained version on a version track with current and abnormal state', async () => {
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

  value.document.querySelector('[data-detail-tab="versions"]').click();
  const nodes = [...value.document.querySelectorAll('.version-track__item[data-version]')];
  assert.deepEqual(nodes.map((node) => node.dataset.version), [
    '2.0.0', '1.10.0', '1.9.0',
  ]);
  assert.equal(nodes[0].dataset.versionState, 'bad');
  assert.match(nodes[0].textContent, /异常/);
  assert.equal(nodes[1].dataset.versionState, 'active');
  assert.match(nodes[1].textContent, /当前启用/);
  assert.equal(nodes[1].querySelector('[data-action="activate-version"]'), null);
  assert.equal(nodes[2].dataset.versionState, 'installed');
  assert.equal(nodes[2].querySelector('[data-action="activate-version"]').textContent, '切换');
  assert.equal(value.document.querySelector('[data-action="rollback"]'), null);
});

test('deactivates an active Kit while keeping its versions ready to enable again', async () => {
  let current = snapshot({
    kits: [{
      ...snapshot().kits[0],
      installed: {
        active: '1.10.0', previous: '1.9.0', channel: 'stable', autoUpdate: true,
        versions: ['1.10.0', '1.9.0'], badVersions: [],
      },
    }],
  });
  const calls = [];
  const confirmations = [];
  const value = await createView({
    api: {
      list: async () => current,
      deactivate: async (kitId) => {
        calls.push(['deactivate', kitId]);
        current = snapshot({
          kits: [{
            ...snapshot().kits[0],
            installed: {
              previous: '1.10.0', channel: 'stable', autoUpdate: true,
              versions: ['1.10.0', '1.9.0'], badVersions: [],
            },
          }],
        });
        return { runtimeReloaded: true };
      },
    },
    confirmInstall: (message) => { confirmations.push(message); return true; },
  });
  await value.view.start();

  const deactivateButton = value.document.querySelector('[data-action="deactivate"]');
  assert.equal(deactivateButton.textContent, '停用');
  deactivateButton.click();
  await value.view.whenIdle();

  assert.deepEqual(calls, [['deactivate', '@itharbors/kit-sqlite']]);
  assert.match(confirmations[0], /保留全部已安装版本/);
  assert.match(value.document.querySelector('#operation-status').textContent, /已停用/);
  assert.equal(value.document.querySelector('[data-action="deactivate"]'), null);
  value.document.querySelector('[data-detail-tab="versions"]').click();
  assert.deepEqual(
    [...value.document.querySelectorAll('.version-track__item[data-version]')]
      .map((node) => node.dataset.version),
    ['1.10.0', '1.9.0'],
  );
  assert.equal(
    value.document.querySelector('[data-action="activate-version"][data-version="1.10.0"]').textContent,
    '启用',
  );
});

test('renders builtin Kits without an install action', async () => {
  const value = await createView({
    initial: snapshot({
      kits: [{ ...snapshot().kits[0], builtin: true }],
    }),
  });

  await value.view.start();

  const button = value.document.querySelector('[data-action="builtin"]');
  assert.equal(button.textContent, '内置');
  assert.equal(button.disabled, true);
  assert.equal(value.document.querySelector('[data-action="install"]'), null);
  assert.equal(value.document.querySelector('[data-role="installed-version"]'), null);
  assert.deepEqual(value.calls, []);
});

test('does not show version history before a Kit is installed', async () => {
  const value = await createView();
  await value.view.start();
  value.document.querySelector('[data-detail-tab="versions"]').click();
  assert.equal(value.document.querySelector('.version-track'), null);
  assert.match(value.document.querySelector('[role="tabpanel"]').textContent, /尚未安装/);
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
  value.document.querySelector('[data-action="install"]').click();
  await installStarted;
  let detail = value.document.querySelector('#kit-detail');
  assert.equal(detail.dataset.operation, 'install');
  assert.equal(detail.querySelector('.kit-detail__progress').hidden, false);
  assert.match(detail.querySelector('.kit-detail__progress').textContent, /正在下载并验证/);
  assert.equal(detail.querySelector('.kit-detail__spinner').getAttribute('aria-hidden'), 'true');
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
  assert.match(value.document.querySelector('#kit-detail').textContent, /已启用/);
  detail = value.document.querySelector('#kit-detail');
  assert.equal(detail.dataset.operation, undefined);
  assert.equal(detail.querySelector('.kit-detail__progress').hidden, true);
});

test('does not install native code when confirmation is declined', async () => {
  const value = await createView({ confirmInstall: () => false });
  await value.view.start();
  value.document.querySelector('[data-action="install"]').click();
  await value.view.whenIdle();
  assert.deepEqual(value.calls, []);
});

test('marks process control as elevated risk and includes it in install confirmation', async () => {
  const processControlSnapshot = snapshot({
    kits: [{
      ...snapshot().kits[0],
      channels: {
        stable: { version: '1.2.0', permissions: ['process-control'] },
      },
    }],
  });
  const confirmations = [];
  const value = await createView({
    initial: processControlSnapshot,
    confirmInstall: (message) => { confirmations.push(message); return false; },
  });

  await value.view.start();
  value.document.querySelector('[data-detail-tab="permissions"]').click();
  const permission = value.document.querySelector('[data-permission="process-control"]');
  assert.equal(permission.dataset.risk, 'high');
  assert.match(permission.textContent, /进程控制.*高风险/);
  value.document.querySelector('[data-action="install"]').click();
  await value.view.whenIdle();

  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /进程控制/);
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
  value.document.querySelector('[data-detail-tab="versions"]').click();
  value.document.querySelector(
    '[data-action="activate-version"][data-version="1.9.0"]',
  ).click();
  assert.equal(value.document.querySelector('main').getAttribute('aria-busy'), 'true');
  assert.equal(
    value.document.querySelector('[data-action="activate-version"][data-version="2.0.0"]').disabled,
    true,
  );
  assert.equal(value.document.querySelector('[data-role="kit-list-item"]').disabled, false);
  releaseActivation();
  await value.view.whenIdle();
  assert.deepEqual(calls[0], ['activate', {
    id: '@itharbors/kit-sqlite', version: '1.9.0', retryBad: false,
  }]);
  assert.match(confirmations[0], /1\.9\.0/);
  assert.match(confirmations[0], /重新加载所有 Kit 窗口/);

  value.document.querySelector('[data-detail-tab="versions"]').click();
  assert.equal(
    value.document.querySelector(
      '[data-action="activate-version"][data-version="2.0.0"]',
    ).textContent,
    '重试',
  );
  value.document.querySelector(
    '[data-action="activate-version"][data-version="2.0.0"]',
  ).click();
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
  const channelFilter = value.document.querySelector('#channel-filter');
  channelFilter.value = 'preview';
  channelFilter.dispatchEvent(new value.dom.window.Event('change'));

  const buttons = value.document.querySelectorAll('[data-action="uninstall"]');
  assert.equal(buttons.length, 1);
  assert.equal(value.document.querySelector('#kit-detail').dataset.channel, 'preview');
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
    install: async () => {
      throw Object.assign(new Error('Artifact rejected'), {
        code: 'KIT_RUNTIME_APPLY_FAILED',
        causes: Object.freeze([
          'Kit runtime validation failed',
          'ENOENT: missing plugins/agent-guard-background/resources/policy-v1.json',
          '<script>alert(1)</script>',
        ]),
      });
    },
  };
  const value = await createView({ api });
  await value.view.start();
  assert.equal(value.document.querySelector('#kit-detail img'), null);
  assert.match(value.document.querySelector('#kit-detail h2').textContent, /<img/);
  value.document.querySelector('#refresh-button').click();
  await value.view.whenIdle();
  assert.match(value.document.querySelector('#operation-status').textContent, /Registry unavailable/);
  assert.equal(value.document.querySelector('#refresh-button').disabled, false);
  value.document.querySelector('[data-action="install"]').click();
  await value.view.whenIdle();
  const operationStatus = value.document.querySelector('#operation-status');
  assert.match(operationStatus.textContent, /Artifact rejected/);
  const technicalDetails = operationStatus.querySelector('details');
  assert.ok(technicalDetails);
  assert.equal(technicalDetails.open, false);
  assert.equal(technicalDetails.querySelector('summary').textContent, '技术详情');
  assert.match(technicalDetails.textContent, /KIT_RUNTIME_APPLY_FAILED/);
  assert.match(technicalDetails.textContent, /policy-v1\.json/);
  assert.match(technicalDetails.textContent, /<script>alert\(1\)<\/script>/);
  assert.equal(technicalDetails.querySelector('script'), null);
  assert.equal(technicalDetails.querySelector('img'), null);
  assert.equal(value.document.querySelector('[data-action="install"]').disabled, false);
  const detail = value.document.querySelector('#kit-detail');
  assert.equal(detail.dataset.operation, undefined);
  assert.equal(detail.querySelector('.kit-detail__progress').hidden, true);

  value.api.refresh = async () => snapshot();
  value.document.querySelector('#refresh-button').click();
  await value.view.whenIdle();
  assert.match(operationStatus.textContent, /Kit 仓库已刷新/);
  assert.equal(operationStatus.querySelector('details'), null);
});
