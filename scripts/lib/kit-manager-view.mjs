const PERMISSION_LABELS = Object.freeze({
  network: '网络访问',
  filesystem: '文件访问',
  'native-code': '原生代码 — 高风险',
  'application-startup': '随 ITHARBORS 启动',
});

const CHANNEL_LABELS = Object.freeze({
  stable: '稳定版',
  preview: '预览版',
});

function required(document, selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`Kit Manager document is missing ${selector}`);
  return node;
}

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function publicMessage(error) {
  return typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : '操作无法完成。';
}

function channelState(kit, channel, reference) {
  const installed = kit.installed;
  const isInstalled = installed?.versions?.includes(reference.version) ?? false;
  const active = installed?.active === reference.version;
  const pending = installed?.pending === reference.version;
  const bad = installed?.badVersions?.includes(reference.version) ?? false;
  return { isInstalled, active, pending, bad, channel };
}

function statusText(state) {
  if (state.pending) return '正在应用';
  if (state.active) return '已启用';
  if (state.bad) return '已标记异常';
  if (state.isInstalled) return '已安装';
  return '可安装';
}

function createButton(document, label, action, onClick, { secondary = false, disabled = false } = {}) {
  const button = element(
    document,
    'button',
    `button${secondary ? ' button--secondary' : ''}`,
    label,
  );
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.permanentDisabled = String(disabled);
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function formatValidatedAt(value) {
  if (!value) return '未保存已验证快照。';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '已验证快照的时间不可用。'
    : `验证于 ${date.toLocaleString('zh-CN')}`;
}

export function createKitManagerView({ document, api, confirmInstall = () => true }) {
  if (!document || typeof document.querySelector !== 'function') {
    throw new TypeError('document is required');
  }
  for (const method of ['list', 'refresh', 'install', 'activate', 'rollback', 'uninstall']) {
    if (typeof api?.[method] !== 'function') {
      throw new TypeError(`api.${method} is required`);
    }
  }
  if (typeof confirmInstall !== 'function') throw new TypeError('confirmInstall is required');

  const main = required(document, '#manager-main');
  const registryStatus = required(document, '#registry-status');
  const registryDetail = required(document, '#registry-detail');
  const registryNotice = required(document, '#registry-notice');
  const operationStatus = required(document, '#operation-status');
  const refreshButton = required(document, '#refresh-button');
  const stableList = required(document, '#stable-list');
  const stableEmpty = required(document, '#stable-empty');
  const previewList = required(document, '#preview-list');
  const previewEmpty = required(document, '#preview-empty');
  let currentSnapshot;
  let operation = Promise.resolve();

  function setBusy(busy) {
    main.setAttribute('aria-busy', String(busy));
    for (const button of document.querySelectorAll('button')) {
      button.disabled = busy || button.dataset.permanentDisabled === 'true';
    }
  }

  function setOperationMessage(message, error = false) {
    operationStatus.textContent = message;
    operationStatus.dataset.outcome = error ? 'failure' : 'success';
    operationStatus.setAttribute('role', error ? 'alert' : 'status');
  }

  async function reloadInstalledProjection() {
    if (typeof api.list !== 'function') return;
    currentSnapshot = await api.list();
    render(currentSnapshot);
  }

  function queue(task) {
    operation = (async () => {
      setBusy(true);
      try {
        await task();
      } catch (error) {
        setOperationMessage(publicMessage(error), true);
      } finally {
        setBusy(false);
      }
    })();
    return operation;
  }

  function install(kit, channel, reference) {
    return queue(async () => {
      const nativeRisk = reference.permissions.includes('native-code')
        ? '此版本包含原生代码，拥有较高的本机访问权限。'
        : '';
      const accepted = await confirmInstall(
        `${kit.label ?? kit.id} ${reference.version}：${nativeRisk}应用版本时会重新加载所有 Kit 窗口，未保存的页面状态可能丢失。是否继续？`,
      );
      if (!accepted) return;
      const updating = Boolean(kit.installed);
      setOperationMessage(`正在${updating ? '安装更新并应用' : '安装并应用'} ${kit.label ?? kit.id} ${reference.version}…`);
      await api.install({ id: kit.id, version: reference.version, channel });
      await reloadInstalledProjection();
      setOperationMessage(`已${updating ? '更新' : '安装'}并启用 ${kit.label ?? kit.id} ${reference.version}。`);
    });
  }

  function activate(kit, reference, state) {
    return queue(async () => {
      const accepted = await confirmInstall(
        '立即启用会重新加载所有 Kit 窗口，未保存的页面状态可能丢失。是否继续？',
      );
      if (!accepted) return;
      await api.activate({ id: kit.id, version: reference.version, retryBad: state.bad });
      await reloadInstalledProjection();
      setOperationMessage(`已启用 ${kit.label ?? kit.id} ${reference.version}。`);
    });
  }

  function rollback(kit) {
    return queue(async () => {
      const accepted = await confirmInstall(
        '立即回滚会重新加载所有 Kit 窗口，未保存的页面状态可能丢失。是否继续？',
      );
      if (!accepted) return;
      await api.rollback(kit.id);
      await reloadInstalledProjection();
      setOperationMessage(`已回滚 ${kit.label ?? kit.id}。`);
    });
  }

  function uninstall(kit) {
    return queue(async () => {
      const accepted = await confirmInstall(
        `删除 ${kit.label ?? kit.id} 将关闭该 Kit 窗口并删除全部已安装版本；其他 Kit 窗口会重新加载。是否继续？`,
      );
      if (!accepted) return;
      setOperationMessage(`正在删除 ${kit.label ?? kit.id}…`);
      await api.uninstall(kit.id);
      await reloadInstalledProjection();
      setOperationMessage(`已删除 ${kit.label ?? kit.id}。`);
    });
  }

  function createCard(kit, channel, reference) {
    const state = channelState(kit, channel, reference);
    const risk = reference.permissions.includes('native-code');
    const card = element(document, 'article', `kit-card${risk ? ' kit-card--risk' : ''}`);
    card.dataset.kitId = kit.id;
    card.dataset.channel = channel;

    const top = element(document, 'div', 'kit-card__topline');
    top.append(element(document, 'span', 'channel-tag', CHANNEL_LABELS[channel] ?? channel));
    const status = element(
      document,
      'span',
      `state-tag${state.bad || state.pending ? ' state-tag--warning' : ''}`,
      statusText(state),
    );
    top.append(status);
    card.append(top);
    card.append(element(document, 'h3', '', kit.label ?? kit.id));
    card.append(element(document, 'p', 'kit-card__publisher', kit.publisher ?? '本地安装'));
    card.append(element(document, 'p', 'kit-card__summary', kit.summary ?? '安装来源不在当前 Kit 仓库中。'));

    const versionRow = element(document, 'div', 'kit-card__version');
    versionRow.append(element(document, 'span', 'version-label', '版本'));
    versionRow.append(element(document, 'code', '', reference.version));
    card.append(versionRow);

    const permissions = element(document, 'div', 'kit-card__permissions');
    if (reference.permissionsUnavailable) {
      permissions.append(element(document, 'span', 'permission permission--risk', '权限信息不可用'));
    } else if (reference.permissions.length === 0) {
      permissions.append(element(document, 'span', 'permission', '未声明额外权限'));
    } else {
      for (const permission of reference.permissions) {
        permissions.append(element(
          document,
          'span',
          `permission${permission === 'native-code' ? ' permission--risk' : ''}`,
          PERMISSION_LABELS[permission] ?? permission,
        ));
      }
    }
    card.append(permissions);

    const actions = element(document, 'div', 'kit-card__actions');
    if (kit.builtin) {
      actions.append(createButton(
        document,
        '内置',
        'builtin',
        () => {},
        { disabled: true },
      ));
    } else if (!state.isInstalled) {
      actions.append(createButton(
        document,
        kit.installed ? '安装更新' : '安装',
        'install',
        () => install(kit, channel, reference),
      ));
    } else if (!state.active) {
      actions.append(createButton(
        document,
        state.bad ? '立即重试' : '立即启用',
        'activate',
        () => activate(kit, reference, state),
        { disabled: state.pending },
      ));
    }
    if (channel === 'stable' && kit.installed?.previous) {
      actions.append(createButton(
        document,
        `回滚到 ${kit.installed.previous}`,
        'rollback',
        () => rollback(kit),
        { secondary: true },
      ));
    }
    const ownsUninstall = kit.installed && (
      (kit.channels?.stable && channel === 'stable')
      || (!kit.channels?.stable && kit.channels?.preview && channel === 'preview')
      || (!kit.channels?.stable && !kit.channels?.preview && channel === 'stable')
    );
    if (!kit.builtin && ownsUninstall) {
      actions.append(createButton(
        document,
        '删除 Kit',
        'uninstall',
        () => uninstall(kit),
        { secondary: true },
      ));
    }
    card.append(actions);
    return card;
  }

  function render(snapshot) {
    currentSnapshot = snapshot;
    stableList.replaceChildren();
    previewList.replaceChildren();
    const source = snapshot?.source;
    if (source === 'network' && !snapshot.stale) {
      registryStatus.textContent = 'Kit 仓库在线';
      registryDetail.textContent = formatValidatedAt(snapshot.validatedAt);
    } else if (source === 'cache') {
      registryStatus.textContent = snapshot.stale ? '离线缓存' : '已验证缓存';
      registryDetail.textContent = formatValidatedAt(snapshot.validatedAt);
    } else {
      registryStatus.textContent = 'Kit 仓库不可用';
      registryDetail.textContent = '暂无已验证的 Kit 仓库快照。';
    }
    registryNotice.hidden = snapshot?.error === undefined;
    registryNotice.textContent = snapshot?.error?.message ?? '';

    let stableCount = 0;
    let previewCount = 0;
    for (const kit of snapshot?.kits ?? []) {
      if (kit.channels?.stable) {
        stableList.append(createCard(kit, 'stable', kit.channels.stable));
        stableCount += 1;
      } else if (kit.installed && !kit.channels?.preview) {
        const fallbackVersion = kit.installed.active
          ?? kit.installed.pending
          ?? kit.installed.versions.at(-1);
        if (fallbackVersion) {
          stableList.append(createCard(kit, 'stable', {
            version: fallbackVersion,
            permissions: [],
            permissionsUnavailable: true,
          }));
          stableCount += 1;
        }
      }
      if (kit.channels?.preview) {
        previewList.append(createCard(kit, 'preview', kit.channels.preview));
        previewCount += 1;
      }
    }
    stableEmpty.hidden = stableCount !== 0;
    stableEmpty.textContent = source === 'none'
      ? '当前没有可用的已验证 Kit 仓库。联网后刷新；已安装的 Kit 不受影响。'
      : '尚未发布 Kit。刷新以检查新版本。';
    previewEmpty.hidden = previewCount !== 0;
  }

  async function start() {
    setBusy(true);
    registryStatus.textContent = '正在加载 Kit 仓库…';
    try {
      render(await api.list());
    } catch (error) {
      render({ source: 'none', stale: true, validatedAt: null, kits: [] });
      setOperationMessage(publicMessage(error), true);
    } finally {
      setBusy(false);
    }
  }

  refreshButton.addEventListener('click', () => {
    queue(async () => {
      if (typeof api.refresh !== 'function') throw new Error('刷新功能不可用。');
      render(await api.refresh());
      setOperationMessage('Kit 仓库已刷新。');
    });
  });

  return {
    start,
    render,
    whenIdle: () => operation,
    snapshot: () => structuredClone(currentSnapshot),
  };
}
