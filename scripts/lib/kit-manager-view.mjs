const PERMISSION_LABELS = Object.freeze({
  network: '网络访问',
  filesystem: '文件访问',
  'native-code': '原生代码 — 高风险',
  'process-control': '进程控制 — 高风险',
  'application-startup': '随 ITHARBORS 启动',
  credentials: '凭据存储 — 高风险',
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

function formatValidatedAt(value) {
  if (!value) return '未保存已验证快照。';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '已验证快照的时间不可用。'
    : `验证于 ${date.toLocaleString('zh-CN')}`;
}

function fallbackReference(kit) {
  const version = kit.installed?.active
    ?? kit.installed?.pending
    ?? kit.installed?.previous
    ?? kit.installed?.versions?.[0];
  if (!version) return undefined;
  return { version, permissions: [], permissionsUnavailable: true };
}

function entryForChannel(kit, channel) {
  const reference = kit.channels?.[channel];
  if (reference) return { kit, channel, reference };
  if (channel === 'stable' && kit.installed && !kit.channels?.preview) {
    const fallback = fallbackReference(kit);
    if (fallback) return { kit, channel, reference: fallback };
  }
  return undefined;
}

function entryStatus({ kit, reference }) {
  const installed = kit.installed;
  if (installed?.pending === reference.version) return '正在应用';
  if (installed?.active === reference.version) return '已启用';
  if (installed?.badVersions?.includes(reference.version)) return '异常';
  if (installed?.versions?.includes(reference.version)) {
    return installed.active ? '已安装' : '已停用';
  }
  return installed ? '有更新' : '未安装';
}

function isUpdate({ kit, reference }) {
  return Boolean(kit.installed)
    && !(kit.installed.versions?.includes(reference.version) ?? false);
}

function isElevatedRiskPermission(permission) {
  return permission === 'native-code'
    || permission === 'process-control'
    || permission === 'credentials';
}

function elevatedRiskNotice(permissions) {
  const notices = [];
  if (permissions.includes('native-code')) {
    notices.push('此版本包含原生代码，拥有较高的本机访问权限。');
  }
  if (permissions.includes('process-control')) {
    notices.push('此版本请求进程控制权限，能够暂停或结束本机进程。');
  }
  if (permissions.includes('credentials')) {
    notices.push('此版本可在系统凭据库中保存和使用登录秘密。');
  }
  return notices.join('');
}

function channelState(kit, channel, reference) {
  const installed = kit.installed;
  return {
    isInstalled: installed?.versions?.includes(reference.version) ?? false,
    active: installed?.active === reference.version,
    pending: installed?.pending === reference.version,
    bad: installed?.badVersions?.includes(reference.version) ?? false,
    channel,
  };
}

function createButton(
  document,
  label,
  action,
  onClick,
  { secondary = false, danger = false, disabled = false } = {},
) {
  const button = element(
    document,
    'button',
    `button${secondary ? ' button--secondary' : ''}${danger ? ' button--danger' : ''}`,
    label,
  );
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.permanentDisabled = String(disabled);
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function entryKey(entry) {
  return `${entry.kit.id}\u0000${entry.channel}`;
}

export function createKitManagerView({ document, api, confirmInstall = () => true }) {
  if (!document || typeof document.querySelector !== 'function') {
    throw new TypeError('document is required');
  }
  for (const method of [
    'list', 'refresh', 'install', 'activate', 'rollback', 'deactivate', 'uninstall',
  ]) {
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
  const installedCountNode = required(document, '#installed-count');
  const refreshButton = required(document, '#refresh-button');
  const workspace = required(document, '#manager-workspace');
  const searchInput = required(document, '#kit-search');
  const channelFilter = required(document, '#channel-filter');
  const listEmpty = required(document, '#kit-list-empty');
  const navigation = required(document, '#kit-navigation');
  const detail = required(document, '#kit-detail');
  const filterButtons = [...document.querySelectorAll('[data-filter]')];

  const uiState = {
    query: '',
    filter: 'all',
    channel: channelFilter.value || 'stable',
    selectedKitId: undefined,
    selectedChannel: undefined,
    detailTab: 'overview',
    channelInitialized: false,
  };
  let currentSnapshot;
  let operation = Promise.resolve();

  function setBusy(busy) {
    main.setAttribute('aria-busy', String(busy));
    refreshButton.disabled = busy;
    for (const control of document.querySelectorAll('[data-action]')) {
      control.disabled = busy || control.dataset.permanentDisabled === 'true';
    }
  }

  function setOperationMessage(message, error = false) {
    operationStatus.textContent = message;
    operationStatus.dataset.outcome = error ? 'failure' : 'success';
    operationStatus.setAttribute('role', error ? 'alert' : 'status');
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

  async function reloadInstalledProjection() {
    currentSnapshot = await api.list();
    render(currentSnapshot);
  }

  function install(selection, detailNode) {
    return queue(async () => {
      const permissions = selection.reference.permissions ?? [];
      const elevatedRisk = elevatedRiskNotice(permissions);
      const accepted = await confirmInstall(
        `${selection.kit.label ?? selection.kit.id} ${selection.reference.version}：${elevatedRisk}应用版本时会重新加载所有 Kit 窗口，未保存的页面状态可能丢失。是否继续？`,
      );
      if (!accepted) return;
      const updating = Boolean(selection.kit.installed);
      const progress = detailNode.querySelector('.kit-detail__progress');
      detailNode.dataset.operation = 'install';
      progress.hidden = false;
      try {
        setOperationMessage(
          `正在${updating ? '安装更新并应用' : '安装并应用'} ${selection.kit.label ?? selection.kit.id} ${selection.reference.version}…`,
        );
        await api.install({
          id: selection.kit.id,
          version: selection.reference.version,
          channel: selection.channel,
        });
        await reloadInstalledProjection();
        setOperationMessage(
          `已${updating ? '更新' : '安装'}并启用 ${selection.kit.label ?? selection.kit.id} ${selection.reference.version}。`,
        );
      } finally {
        delete detailNode.dataset.operation;
        progress.hidden = true;
      }
    });
  }

  function activate(selection) {
    return queue(async () => {
      const state = channelState(
        selection.kit,
        selection.channel,
        selection.reference,
      );
      const accepted = await confirmInstall(
        '立即启用会重新加载所有 Kit 窗口，未保存的页面状态可能丢失。是否继续？',
      );
      if (!accepted) return;
      await api.activate({
        id: selection.kit.id,
        version: selection.reference.version,
        retryBad: state.bad,
      });
      await reloadInstalledProjection();
      setOperationMessage(
        `已启用 ${selection.kit.label ?? selection.kit.id} ${selection.reference.version}。`,
      );
    });
  }

  function activateInstalledVersion(kit, version) {
    return queue(async () => {
      const enabling = kit.installed.active === undefined;
      const accepted = await confirmInstall(
        `${enabling ? '启用' : '切换到'} ${version} 会重新加载所有 Kit 窗口，未保存的页面状态可能丢失。是否继续？`,
      );
      if (!accepted) return;
      await api.activate({
        id: kit.id,
        version,
        retryBad: kit.installed.badVersions.includes(version),
      });
      await reloadInstalledProjection();
      setOperationMessage(
        enabling
          ? `已启用 ${kit.label ?? kit.id} ${version}。`
          : `已切换 ${kit.label ?? kit.id} 到 ${version}。`,
      );
    });
  }

  function deactivate(kit) {
    return queue(async () => {
      const accepted = await confirmInstall(
        `停用 ${kit.label ?? kit.id} 将关闭该 Kit 窗口并重新加载其他 Kit 窗口；保留全部已安装版本。是否继续？`,
      );
      if (!accepted) return;
      setOperationMessage(`正在停用 ${kit.label ?? kit.id}…`);
      await api.deactivate(kit.id);
      await reloadInstalledProjection();
      setOperationMessage(`已停用 ${kit.label ?? kit.id}。`);
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

  function allEntries(snapshot) {
    return (snapshot?.kits ?? [])
      .map((kit) => entryForChannel(kit, uiState.channel))
      .filter(Boolean);
  }

  function visibleEntries(snapshot) {
    const query = uiState.query.trim().toLocaleLowerCase('zh-CN');
    return allEntries(snapshot).filter((entry) => {
      if (uiState.filter === 'installed' && !entry.kit.installed) return false;
      if (uiState.filter === 'updates' && !isUpdate(entry)) return false;
      if (!query) return true;
      return [
        entry.kit.label,
        entry.kit.id,
        entry.kit.publisher,
        entry.kit.summary,
      ].some((value) => String(value ?? '').toLocaleLowerCase('zh-CN').includes(query));
    });
  }

  function ensureSelection(entries) {
    const selectedKey = uiState.selectedKitId && uiState.selectedChannel
      ? `${uiState.selectedKitId}\u0000${uiState.selectedChannel}`
      : undefined;
    let selected = entries.find((entry) => entryKey(entry) === selectedKey);
    selected ??= entries.find((entry) => entry.kit.installed);
    selected ??= entries[0];
    uiState.selectedKitId = selected?.kit.id;
    uiState.selectedChannel = selected?.channel;
    return selected;
  }

  function createListItem(entry, selected) {
    const item = element(document, 'button', 'kit-list-item');
    item.type = 'button';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(selected));
    item.dataset.role = 'kit-list-item';
    item.dataset.kitId = entry.kit.id;
    item.dataset.channel = entry.channel;

    const identity = element(document, 'span', 'kit-list-item__identity');
    identity.append(element(document, 'strong', '', entry.kit.label ?? entry.kit.id));
    identity.append(element(
      document,
      'span',
      'kit-list-item__summary',
      entry.kit.summary ?? '安装来源不在当前 Kit 仓库中。',
    ));
    item.append(identity);

    const meta = element(document, 'span', 'kit-list-item__meta');
    meta.append(element(document, 'code', '', entry.reference.version));
    meta.append(element(
      document,
      'span',
      `kit-list-item__status kit-list-item__status--${entryStatus(entry)}`,
      entryStatus(entry),
    ));
    item.append(meta);

    item.addEventListener('click', () => {
      uiState.selectedKitId = entry.kit.id;
      uiState.selectedChannel = entry.channel;
      uiState.detailTab = 'overview';
      workspace.dataset.mobileView = 'detail';
      renderWorkspace();
    });
    return item;
  }

  function createDetailTabs(selection) {
    const tabs = element(document, 'div', 'detail-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', `${selection.kit.label ?? selection.kit.id} 详情`);
    for (const [id, label] of [
      ['overview', '概览'],
      ['permissions', '权限'],
      ['versions', '版本记录'],
    ]) {
      const button = element(document, 'button', 'detail-tab', label);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(uiState.detailTab === id));
      button.dataset.detailTab = id;
      button.addEventListener('click', () => {
        uiState.detailTab = id;
        renderDetail(selection);
      });
      tabs.append(button);
    }
    return tabs;
  }

  function renderVersionTrack(kit) {
    if (!kit.installed?.versions?.length) {
      return element(document, 'p', 'detail-empty', '尚未安装，暂无本机版本记录。');
    }
    const track = element(document, 'ol', 'version-track');
    for (const version of kit.installed.versions) {
      let state = 'installed';
      let label = '已安装';
      if (kit.installed.active === version) {
        state = 'active';
        label = '当前启用';
      } else if (kit.installed.pending === version) {
        state = 'pending';
        label = '正在应用';
      } else if (kit.installed.badVersions.includes(version)) {
        state = 'bad';
        label = '异常';
      }

      const item = element(document, 'li', 'version-track__item');
      item.dataset.version = version;
      item.dataset.versionState = state;
      const node = element(document, 'span', 'version-track__node');
      node.setAttribute('aria-hidden', 'true');
      item.append(node);
      const identity = element(document, 'div', 'version-track__identity');
      identity.append(element(document, 'code', '', version));
      identity.append(element(document, 'span', 'version-track__state', label));
      item.append(identity);
      if (state !== 'active' && state !== 'pending') {
        const actionLabel = kit.installed.active === undefined
          ? '启用'
          : state === 'bad' ? '重试' : '切换';
        const button = createButton(
          document,
          actionLabel,
          'activate-version',
          () => activateInstalledVersion(kit, version),
          { secondary: true },
        );
        button.dataset.version = version;
        item.append(button);
      }
      track.append(item);
    }
    return track;
  }

  function renderDetailPanel(selection) {
    const panel = element(document, 'div', 'kit-detail__panel');
    panel.setAttribute('role', 'tabpanel');
    if (uiState.detailTab === 'permissions') {
      const permissions = selection.reference.permissions ?? [];
      if (selection.reference.permissionsUnavailable) {
        panel.append(element(
          document,
          'p',
          'detail-empty detail-empty--warning',
          '当前仓库未提供此本机版本的权限信息。',
        ));
      } else if (permissions.length === 0) {
        panel.append(element(document, 'p', 'detail-empty', '此版本未声明额外权限。'));
      } else {
        const list = element(document, 'ul', 'permission-list');
        for (const permission of permissions) {
          const item = element(
            document,
            'li',
            'permission-item',
            PERMISSION_LABELS[permission] ?? permission,
          );
          item.dataset.permission = permission;
          if (isElevatedRiskPermission(permission)) item.dataset.risk = 'high';
          list.append(item);
        }
        panel.append(list);
      }
      return panel;
    }
    if (uiState.detailTab === 'versions') {
      panel.append(renderVersionTrack(selection.kit));
      return panel;
    }

    const facts = element(document, 'dl', 'kit-detail__facts');
    facts.append(element(document, 'dt', '', '频道'));
    facts.append(element(
      document,
      'dd',
      '',
      CHANNEL_LABELS[selection.channel] ?? selection.channel,
    ));
    facts.append(element(document, 'dt', '', '版本'));
    facts.append(element(document, 'dd', '', selection.reference.version));
    facts.append(element(document, 'dt', '', '发布者'));
    facts.append(element(document, 'dd', '', selection.kit.publisher ?? '本地安装'));
    facts.append(element(document, 'dt', '', '状态'));
    facts.append(element(document, 'dd', '', entryStatus(selection)));
    panel.append(facts);
    return panel;
  }

  function createMainAction(selection) {
    if (selection.kit.builtin) {
      return createButton(document, '内置', 'builtin', () => {}, { disabled: true });
    }
    const state = channelState(selection.kit, selection.channel, selection.reference);
    if (!state.isInstalled) {
      return createButton(
        document,
        selection.kit.installed ? '更新' : '安装',
        'install',
        () => install(selection, detail),
      );
    }
    if (!state.active) {
      return createButton(
        document,
        state.bad ? '重试' : '启用',
        'activate',
        () => activate(selection),
        { disabled: state.pending },
      );
    }
    return createButton(
      document,
      '停用',
      'deactivate',
      () => deactivate(selection.kit),
      { secondary: true },
    );
  }

  function renderDetail(selection) {
    detail.replaceChildren();
    delete detail.dataset.channel;
    if (!selection) {
      const empty = element(document, 'div', 'kit-detail__empty');
      empty.append(element(document, 'strong', '', '选择一个 Kit'));
      empty.append(element(document, 'span', '', '查看用途、权限和本机版本。'));
      detail.append(empty);
      return;
    }
    detail.dataset.channel = selection.channel;

    const backButton = createButton(
      document,
      '返回 Kit 列表',
      'back-to-list',
      () => {
        workspace.dataset.mobileView = 'list';
      },
      { secondary: true },
    );
    backButton.classList.add('kit-detail__back');
    detail.append(backButton);

    const header = element(document, 'header', 'kit-detail__header');
    const heading = element(document, 'div', 'kit-detail__heading');
    heading.append(element(
      document,
      'span',
      'kit-detail__channel',
      CHANNEL_LABELS[selection.channel] ?? selection.channel,
    ));
    heading.append(element(document, 'h2', '', selection.kit.label ?? selection.kit.id));
    heading.append(element(
      document,
      'p',
      'kit-detail__publisher',
      `${selection.kit.publisher ?? '本地安装'} · 已验证`,
    ));
    heading.append(element(
      document,
      'p',
      'kit-detail__summary',
      selection.kit.summary ?? '安装来源不在当前 Kit 仓库中。',
    ));
    header.append(heading);
    const actions = element(document, 'div', 'kit-detail__actions');
    const mainAction = createMainAction(selection);
    actions.append(mainAction);
    if (
      selection.kit.installed?.active
      && mainAction.dataset.action !== 'deactivate'
      && !selection.kit.builtin
    ) {
      actions.append(createButton(
        document,
        '停用',
        'deactivate',
        () => deactivate(selection.kit),
        { secondary: true },
      ));
    }
    header.append(actions);
    const progress = element(document, 'div', 'kit-detail__progress');
    progress.hidden = true;
    const spinner = element(document, 'span', 'kit-detail__spinner');
    spinner.setAttribute('aria-hidden', 'true');
    progress.append(spinner);
    progress.append(element(document, 'span', '', '正在下载并验证…'));
    header.append(progress);
    detail.append(header);
    detail.append(createDetailTabs(selection));
    detail.append(renderDetailPanel(selection));
    if (selection.kit.installed && !selection.kit.builtin) {
      const danger = element(document, 'section', 'kit-detail__danger');
      danger.append(element(document, 'div', '', '删除 Kit'));
      danger.append(element(
        document,
        'p',
        '',
        '删除全部本机版本；此操作会关闭该 Kit 窗口。',
      ));
      danger.append(createButton(
        document,
        '删除',
        'uninstall',
        () => uninstall(selection.kit),
        { secondary: true, danger: true },
      ));
      detail.append(danger);
    }
  }

  function renderWorkspace() {
    const entries = visibleEntries(currentSnapshot);
    const selected = ensureSelection(entries);
    navigation.replaceChildren();
    for (const entry of entries) {
      navigation.append(createListItem(entry, entryKey(entry) === entryKey(selected)));
    }
    listEmpty.hidden = entries.length > 0;
    listEmpty.textContent = entries.length > 0 ? '' : '没有符合条件的 Kit。请调整搜索或筛选。';
    for (const button of filterButtons) {
      button.setAttribute('aria-selected', String(button.dataset.filter === uiState.filter));
    }
    renderDetail(selected);
  }

  function render(snapshot) {
    currentSnapshot = snapshot;
    if (!uiState.channelInitialized) {
      const kits = snapshot?.kits ?? [];
      const hasStable = kits.some((kit) => entryForChannel(kit, 'stable'));
      const hasPreview = kits.some((kit) => entryForChannel(kit, 'preview'));
      if (!hasStable && hasPreview) {
        uiState.channel = 'preview';
        channelFilter.value = 'preview';
      }
      uiState.channelInitialized = true;
    }
    const installedCount = new Set(
      (snapshot?.kits ?? []).filter((kit) => kit.installed).map((kit) => kit.id),
    ).size;
    installedCountNode.textContent = `${installedCount} 个已安装`;
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
    renderWorkspace();
  }

  searchInput.addEventListener('input', () => {
    uiState.query = searchInput.value;
    renderWorkspace();
  });
  channelFilter.addEventListener('change', () => {
    uiState.channel = channelFilter.value;
    uiState.selectedChannel = undefined;
    workspace.dataset.mobileView = 'list';
    renderWorkspace();
  });
  for (const button of filterButtons) {
    button.addEventListener('click', () => {
      uiState.filter = button.dataset.filter;
      renderWorkspace();
    });
  }
  refreshButton.addEventListener('click', () => queue(async () => {
    currentSnapshot = await api.refresh();
    render(currentSnapshot);
    setOperationMessage('Kit 仓库已刷新。');
  }));

  return Object.freeze({
    async start() {
      main.setAttribute('aria-busy', 'true');
      try {
        currentSnapshot = await api.list();
        render(currentSnapshot);
      } catch (error) {
        render({ source: 'none', stale: true, kits: [], error: { message: publicMessage(error) } });
      } finally {
        main.setAttribute('aria-busy', 'false');
      }
    },
    render,
    whenIdle() {
      return operation;
    },
  });
}
