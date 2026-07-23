const PERMISSION_LABELS = Object.freeze({
  network: 'Network',
  filesystem: 'File access',
  'native-code': 'Native code — elevated risk',
  'application-startup': 'Starts with ITHARBORS',
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
    : 'The operation could not be completed.';
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
  if (state.pending) return 'Queued for restart';
  if (state.active) return 'Active';
  if (state.bad) return 'Marked bad';
  if (state.isInstalled) return 'Installed';
  return 'Available';
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
  if (!value) return 'No verified snapshot is stored.';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Verified snapshot time unavailable.'
    : `Verified ${date.toLocaleString()}`;
}

export function createKitManagerView({ document, api, confirmInstall = () => true }) {
  if (!document || typeof document.querySelector !== 'function') {
    throw new TypeError('document is required');
  }
  for (const method of ['list', 'refresh', 'install', 'activate', 'rollback']) {
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
      if (reference.permissions.includes('native-code')) {
        const accepted = await confirmInstall(
          `${kit.label ?? kit.id} contains native code. Native code has elevated machine access. Install this version?`,
        );
        if (!accepted) return;
      }
      await api.install({ id: kit.id, version: reference.version, channel });
      await reloadInstalledProjection();
      setOperationMessage(`Installed ${kit.label ?? kit.id} ${reference.version}. Activate it after restart when ready.`);
    });
  }

  function activate(kit, reference, state) {
    return queue(async () => {
      await api.activate({ id: kit.id, version: reference.version, retryBad: state.bad });
      await reloadInstalledProjection();
      setOperationMessage(`${kit.label ?? kit.id} ${reference.version} will activate after restart.`);
    });
  }

  function rollback(kit) {
    return queue(async () => {
      await api.rollback(kit.id);
      await reloadInstalledProjection();
      setOperationMessage(`${kit.label ?? kit.id} will roll back after restart.`);
    });
  }

  function createCard(kit, channel, reference) {
    const state = channelState(kit, channel, reference);
    const risk = reference.permissions.includes('native-code');
    const card = element(document, 'article', `kit-card${risk ? ' kit-card--risk' : ''}`);
    card.dataset.kitId = kit.id;
    card.dataset.channel = channel;

    const top = element(document, 'div', 'kit-card__topline');
    top.append(element(document, 'span', 'channel-tag', channel));
    const status = element(
      document,
      'span',
      `state-tag${state.bad || state.pending ? ' state-tag--warning' : ''}`,
      statusText(state),
    );
    top.append(status);
    card.append(top);
    card.append(element(document, 'h3', '', kit.label ?? kit.id));
    card.append(element(document, 'p', 'kit-card__publisher', kit.publisher ?? 'Local installation'));
    card.append(element(document, 'p', 'kit-card__summary', kit.summary ?? 'Installed outside the current Registry.'));

    const versionRow = element(document, 'div', 'kit-card__version');
    versionRow.append(element(document, 'span', 'version-label', 'Version'));
    versionRow.append(element(document, 'code', '', reference.version));
    card.append(versionRow);

    const permissions = element(document, 'div', 'kit-card__permissions');
    if (reference.permissionsUnavailable) {
      permissions.append(element(document, 'span', 'permission permission--risk', 'Permission data unavailable'));
    } else if (reference.permissions.length === 0) {
      permissions.append(element(document, 'span', 'permission', 'No declared privileges'));
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
    if (!state.isInstalled) {
      actions.append(createButton(
        document,
        kit.installed ? 'Install update' : 'Install',
        'install',
        () => install(kit, channel, reference),
      ));
    } else if (!state.active) {
      actions.append(createButton(
        document,
        state.bad ? 'Retry after restart' : 'Activate after restart',
        'activate',
        () => activate(kit, reference, state),
        { disabled: state.pending },
      ));
    }
    if (channel === 'stable' && kit.installed?.previous) {
      actions.append(createButton(
        document,
        `Roll back to ${kit.installed.previous}`,
        'rollback',
        () => rollback(kit),
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
      registryStatus.textContent = 'Registry online';
      registryDetail.textContent = formatValidatedAt(snapshot.validatedAt);
    } else if (source === 'cache') {
      registryStatus.textContent = snapshot.stale ? 'Offline cache' : 'Verified cache';
      registryDetail.textContent = formatValidatedAt(snapshot.validatedAt);
    } else {
      registryStatus.textContent = 'Market unavailable';
      registryDetail.textContent = 'No verified Registry snapshot is available.';
    }
    registryNotice.hidden = snapshot?.error === undefined;
    registryNotice.textContent = snapshot?.error?.message ?? '';

    let stableCount = 0;
    let previewCount = 0;
    for (const kit of snapshot?.kits ?? []) {
      if (kit.channels?.stable) {
        stableList.append(createCard(kit, 'stable', kit.channels.stable));
        stableCount += 1;
      } else if (kit.installed) {
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
      ? 'No verified market is available. Refresh when you are online; installed Kits remain unchanged.'
      : 'No Kits are published yet. Refresh to check for newly released Kits.';
    previewEmpty.hidden = previewCount !== 0;
  }

  async function start() {
    setBusy(true);
    registryStatus.textContent = 'Loading Registry…';
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
      if (typeof api.refresh !== 'function') throw new Error('Refresh is unavailable.');
      render(await api.refresh());
      setOperationMessage('Registry refreshed.');
    });
  });

  return {
    start,
    render,
    whenIdle: () => operation,
    snapshot: () => structuredClone(currentSnapshot),
  };
}
