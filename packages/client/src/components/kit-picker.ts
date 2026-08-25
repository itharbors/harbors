import type {
  PublicKitCatalogEntry,
  PublicSessionSummary,
  WorkbenchContext,
} from '@itharbors/plugin-types';
import '../styles/kit-picker.css';

interface PendingDevice {
  deviceId: string;
  ip: string;
  userAgent: string;
  requestedAt: number;
  displayName: string;
}

interface AuthorizedDevice {
  deviceId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  user?: { userId: string; displayName: string };
}

export interface KitPickerOptions {
  context: WorkbenchContext;
  selectedSessionId: string | null;
  onSessionSelected(sessionId: string): void;
  onSessionCleared(): void;
  onContextChanged(): void;
}

export function renderKitPicker(
  host: HTMLElement,
  kits: PublicKitCatalogEntry[],
  input: string | KitPickerOptions,
): void {
  const options = typeof input === 'string' ? legacyOptions(input) : input;
  host.replaceChildren(createPickerShell(kits, options));
}

export function renderKitPickerLoading(host: HTMLElement): void {
  const status = element('div', 'kit-host-state');
  const spinner = element('span', 'kit-host-spinner', '');
  spinner.setAttribute('aria-hidden', 'true');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.append(
    spinner,
    element('strong', '', '正在读取 Kit…'),
    element('span', '', '正在同步当前主机上的工作台列表。'),
  );
  host.replaceChildren(status);
}

export function renderKitPickerError(host: HTMLElement, retry: () => void): void {
  const alert = element('div', 'kit-host-state kit-host-error');
  const errorMark = element('span', 'kit-host-error-mark', '!');
  errorMark.setAttribute('aria-hidden', 'true');
  alert.setAttribute('role', 'alert');
  alert.append(
    errorMark,
    element('strong', '', '无法读取 Kit 列表'),
    element('span', '', '确认服务仍在运行，然后重新加载列表。'),
  );
  const button = element('button', 'kit-retry', '重新加载');
  button.setAttribute('type', 'button');
  button.addEventListener('click', retry);
  alert.append(button);
  host.replaceChildren(alert);
}

function createPickerShell(kits: PublicKitCatalogEntry[], options: KitPickerOptions): HTMLElement {
  const shell = element('div', 'kit-picker-shell');

  const tabs = element('nav', 'kit-tabs');
  tabs.setAttribute('role', 'tablist');

  const workbenchTab = element('button', 'kit-tab kit-tab-active', '工作台');
  workbenchTab.setAttribute('role', 'tab');
  workbenchTab.setAttribute('aria-selected', 'true');
  const authTab = element('button', 'kit-tab', '授权管理');
  authTab.setAttribute('role', 'tab');
  authTab.setAttribute('aria-selected', 'false');

  tabs.append(workbenchTab, authTab);

  const workbenchPanel = element('div', 'kit-tab-panel');
  workbenchPanel.setAttribute('role', 'tabpanel');
  workbenchPanel.append(createWorkbenchView(kits, options));

  const authPanel = element('div', 'kit-tab-panel');
  authPanel.setAttribute('role', 'tabpanel');
  authPanel.style.display = 'none';
  authPanel.append(createAuthView());

  workbenchTab.addEventListener('click', () => {
    workbenchTab.classList.add('kit-tab-active');
    authTab.classList.remove('kit-tab-active');
    workbenchTab.setAttribute('aria-selected', 'true');
    authTab.setAttribute('aria-selected', 'false');
    workbenchPanel.style.display = '';
    authPanel.style.display = 'none';
  });

  authTab.addEventListener('click', () => {
    authTab.classList.add('kit-tab-active');
    workbenchTab.classList.remove('kit-tab-active');
    authTab.setAttribute('aria-selected', 'true');
    workbenchTab.setAttribute('aria-selected', 'false');
    authPanel.style.display = '';
    workbenchPanel.style.display = 'none';
    void refreshAuthView(authPanel);
  });

  shell.append(tabs, workbenchPanel, authPanel);
  return shell;
}

function createWorkbenchView(kits: PublicKitCatalogEntry[], options: KitPickerOptions): HTMLElement {
  const main = element('main', 'kit-picker-body');
  main.setAttribute('aria-labelledby', 'kit-picker-title');

  const masthead = element('header', 'kit-masthead');
  const identity = element('div', 'kit-host-identity');
  identity.append(
    element('span', 'kit-host-mark', 'IH'),
    element('span', 'kit-host-name', 'ITHARBORS'),
  );
  masthead.append(
    identity,
    element('span', 'kit-host-mode', 'Web Host / Multi-Kit'),
  );

  const intro = element('section', 'kit-picker-intro');
  const eyebrow = element('p', 'kit-picker-eyebrow', '多 Kit 主机');
  const title = element('h1', '', '选择工作台');
  title.id = 'kit-picker-title';
  intro.append(
    eyebrow,
    title,
    element('p', 'kit-picker-lede', '每个工作台使用独立会话。选择一个 Kit，在当前浏览器中开始工作。'),
  );

  const contextTrack = element('section', 'workbench-context-track');
  contextTrack.setAttribute('aria-label', '用户与 Session');
  const status = element('p', 'workbench-context-status');
  status.setAttribute('aria-live', 'polite');
  const userField = element('label', 'workbench-context-field');
  userField.append(element('span', 'workbench-context-label', '用户'));
  const userSelect = element('select', 'workbench-context-select');
  const users = options.context.users;
  for (const user of users) {
    const option = element('option', '', user.displayName);
    option.value = user.userId;
    userSelect.append(option);
  }
  const initialOwner = options.context.currentUser?.userId
    ?? options.context.sessions.find((session) => session.sessionId === options.selectedSessionId)?.ownerUserId
    ?? users[0]?.userId
    ?? '';
  userSelect.value = initialOwner;
  userSelect.disabled = options.context.actor === 'user';
  userField.append(userSelect);

  const sessionField = element('label', 'workbench-context-field');
  sessionField.append(element('span', 'workbench-context-label', 'Session'));
  const sessionSelect = element('select', 'workbench-context-select');
  sessionField.append(sessionSelect);
  const createSession = element('button', 'workbench-context-action', '＋ 新建 Session');
  createSession.type = 'button';
  const createUser = element('button', 'workbench-context-action', '＋ 创建用户');
  createUser.type = 'button';
  createUser.hidden = options.context.actor !== 'local-admin';
  const renameUser = element('button', 'workbench-context-action', '重命名用户');
  renameUser.type = 'button';
  renameUser.hidden = options.context.actor !== 'local-admin';
  const claim = element('button', 'workbench-context-action', '归属未分配 Session');
  claim.type = 'button';
  claim.hidden = options.context.actor !== 'local-admin' || options.context.ownerlessSessions.length === 0;
  const ownerlessSelect = element('select', 'workbench-context-select workbench-ownerless-select');
  ownerlessSelect.setAttribute('aria-label', '未分配 Session');
  ownerlessSelect.hidden = claim.hidden;
  for (const session of options.context.ownerlessSessions) {
    const option = element('option', '', `${shortId(session.sessionId)} · ${formatTime(session.lastAccessAt)}`);
    option.value = session.sessionId;
    ownerlessSelect.append(option);
  }

  const updateLinks = (sessionId: string | null) => {
    for (const link of main.querySelectorAll<HTMLAnchorElement>('.kit-link')) {
      const kitId = link.dataset.kitId ?? '';
      if (sessionId) {
        link.href = `/kits/${encodeURIComponent(kitId)}?session=${encodeURIComponent(sessionId)}`;
        link.removeAttribute('aria-disabled');
        link.tabIndex = 0;
      } else {
        link.removeAttribute('href');
        link.setAttribute('aria-disabled', 'true');
        link.tabIndex = -1;
      }
    }
  };
  const refreshSessions = () => {
    const owned = options.context.sessions.filter((session) => session.ownerUserId === userSelect.value);
    sessionSelect.replaceChildren();
    const placeholder = element('option', '', owned.length ? '选择 Session' : '暂无 Session，请新建');
    placeholder.value = '';
    sessionSelect.append(placeholder);
    for (const session of owned) {
      const option = element('option', '', `${shortId(session.sessionId)} · ${formatTime(session.lastAccessAt)}`);
      option.value = session.sessionId;
      sessionSelect.append(option);
    }
    const selected = owned.some((session) => session.sessionId === options.selectedSessionId)
      ? options.selectedSessionId
      : null;
    sessionSelect.value = selected ?? '';
    updateLinks(selected);
  };
  userSelect.addEventListener('change', () => {
    options.selectedSessionId = null;
    options.onSessionCleared();
    refreshSessions();
    status.textContent = '已切换用户，请选择或新建 Session。';
  });
  sessionSelect.addEventListener('change', () => {
    const selected = sessionSelect.value || null;
    options.selectedSessionId = selected;
    updateLinks(selected);
    if (selected) options.onSessionSelected(selected);
  });
  createSession.addEventListener('click', async () => {
    if (!userSelect.value) {
      status.textContent = '请先创建或选择用户。';
      return;
    }
    createSession.disabled = true;
    try {
      const response = await fetch('/api/workbench/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: userSelect.value }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const session = await response.json() as PublicSessionSummary;
      options.onSessionSelected(session.sessionId);
      options.onContextChanged();
    } catch {
      status.textContent = '无法新建 Session，请重试。';
    } finally {
      createSession.disabled = false;
    }
  });
  createUser.addEventListener('click', async () => {
    const displayName = window.prompt('输入用户显示名')?.trim();
    if (!displayName) return;
    const response = await fetch('/api/workbench/user', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName }),
    });
    if (response.ok) options.onContextChanged();
    else status.textContent = '无法创建用户，请重试。';
  });
  renameUser.addEventListener('click', async () => {
    const current = users.find((user) => user.userId === userSelect.value);
    if (!current) return;
    const displayName = window.prompt('修改用户显示名', current.displayName)?.trim();
    if (!displayName) return;
    const response = await fetch(`/api/workbench/user/${encodeURIComponent(current.userId)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName }),
    });
    if (response.ok) options.onContextChanged();
    else status.textContent = '无法修改显示名，请重试。';
  });
  claim.addEventListener('click', async () => {
    const target = options.context.ownerlessSessions.find((session) => session.sessionId === ownerlessSelect.value);
    if (!target || !userSelect.value || !window.confirm(`将 Session ${shortId(target.sessionId)} 归属给当前用户？此操作不能撤销。`)) return;
    const response = await fetch(`/api/workbench/session/${encodeURIComponent(target.sessionId)}/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: userSelect.value }),
    });
    if (response.ok) options.onContextChanged();
    else status.textContent = '无法归属 Session，它可能已被处理。';
  });
  contextTrack.append(userField, sessionField, createSession, createUser, renameUser, ownerlessSelect, claim, status);

  const berth = element('section', 'kit-berth');
  berth.setAttribute('aria-label', '可用 Kit');
  const berthHeader = element('div', 'kit-berth-heading');
  berthHeader.append(
    element('span', '', '可用工作台'),
    element('span', 'kit-count', `${kits.length} KIT${kits.length === 1 ? '' : 'S'}`),
  );
  berth.append(berthHeader);

  if (kits.length === 0) {
    const empty = element('div', 'kit-empty');
    empty.append(
      element('strong', '', '没有可用的 Kit'),
      element('p', '', '检查 kits 目录中的 package.json，确认 Kit manifest 完整有效。'),
    );
    berth.append(empty);
  } else {
    const list = element('ul', 'kit-list');
    list.setAttribute('role', 'list');
    for (const kit of kits) list.append(createKitItem(kit, options.selectedSessionId ?? ''));
    berth.append(list);
  }

  const footer = element('footer', 'kit-picker-footer');
  footer.append(
    element('span', '', '同一端口 · 独立 Session'),
    element('span', '', 'ITHARBORS WORKBENCH'),
  );

  main.append(masthead, intro, contextTrack, berth, footer);
  refreshSessions();
  return main;
}

function createKitItem(kit: PublicKitCatalogEntry, sessionId: string): HTMLLIElement {
  const item = element('li', 'kit-item');
  const link = element('a', 'kit-link');
  link.dataset.kitId = kit.id;
  link.href = `/kits/${encodeURIComponent(kit.id)}?session=${encodeURIComponent(sessionId)}`;

  const symbol = element('span', 'kit-symbol', monogram(kit.label));
  symbol.setAttribute('aria-hidden', 'true');
  const copy = element('span', 'kit-copy');
  const packageName = element('span', 'kit-package', kit.name);
  packageName.setAttribute('translate', 'no');
  const route = element('span', 'kit-route', `/kits/${kit.id}`);
  route.setAttribute('translate', 'no');
  copy.append(
    element('strong', 'kit-label', kit.label),
    packageName,
    route,
  );
  const action = element('span', 'kit-open', '打开工作台');
  const arrow = element('span', 'kit-open-arrow', '↗');
  arrow.setAttribute('aria-hidden', 'true');
  action.append(arrow);
  link.append(symbol, copy, action);
  item.append(link);
  return item;
}

function legacyOptions(sessionId: string): KitPickerOptions {
  const now = Date.now();
  return {
    context: {
      actor: 'local-admin',
      currentUser: null,
      users: [{ userId: 'legacy-user', displayName: '当前用户', createdAt: now, updatedAt: now }],
      sessions: [{ sessionId, ownerUserId: 'legacy-user', createdAt: now, lastAccessAt: now }],
      ownerlessSessions: [],
    },
    selectedSessionId: sessionId,
    onSessionSelected: () => undefined,
    onSessionCleared: () => undefined,
    onContextChanged: () => undefined,
  };
}

function createAuthView(): HTMLElement {
  const container = element('div', 'auth-view');
  container.append(
    element('h2', 'auth-section-title', '待授权设备'),
    element('div', 'auth-pending-list'),
    element('h2', 'auth-section-title', '已授权设备'),
    element('div', 'auth-authorized-list'),
  );
  return container;
}

async function refreshAuthView(container: HTMLElement): Promise<void> {
  const pendingList = container.querySelector('.auth-pending-list');
  const authorizedList = container.querySelector('.auth-authorized-list');
  if (!(pendingList instanceof HTMLElement) || !(authorizedList instanceof HTMLElement)) return;

  pendingList.replaceChildren(element('div', 'auth-loading', '加载中…'));
  authorizedList.replaceChildren(element('div', 'auth-loading', '加载中…'));

  try {
    const [pending, authorized, context] = await Promise.all([fetchPending(), fetchAuthorized(), fetchWorkbenchContext()]);
    renderPendingList(pendingList, pending, context.users);
    renderAuthorizedList(authorizedList, authorized);
  } catch {
    pendingList.replaceChildren(element('div', 'auth-error', '无法加载待授权列表'));
    authorizedList.replaceChildren(element('div', 'auth-error', '无法加载已授权列表'));
  }
}

function renderPendingList(host: HTMLElement, devices: PendingDevice[], users: WorkbenchContext['users']): void {
  if (devices.length === 0) {
    host.replaceChildren(element('div', 'auth-empty', '暂无待授权请求'));
    return;
  }
  const list = element('ul', 'auth-device-list');
  for (const device of devices) {
    list.append(createPendingItem(device, users, () => void refreshAuthView(host.closest('.auth-view') ?? host)));
  }
  host.replaceChildren(list);
}

function renderAuthorizedList(host: HTMLElement, devices: AuthorizedDevice[]): void {
  if (devices.length === 0) {
    host.replaceChildren(element('div', 'auth-empty', '暂无已授权设备'));
    return;
  }
  const list = element('ul', 'auth-device-list');
  for (const device of devices) {
    list.append(createAuthorizedItem(device, () => void refreshAuthView(host.closest('.auth-view') ?? host)));
  }
  host.replaceChildren(list);
}

function createPendingItem(device: PendingDevice, users: WorkbenchContext['users'], onChanged: () => void): HTMLLIElement {
  const item = element('li', 'auth-device-item');
  const info = element('div', 'auth-device-info');
  info.append(
    element('div', 'auth-device-id', shortId(device.deviceId)),
    element('div', 'auth-device-meta', `申请名称: ${device.displayName || '未填写'}`),
    element('div', 'auth-device-meta', `IP: ${device.ip || '未知'}`),
    element('div', 'auth-device-meta', `UA: ${device.userAgent || '未知'}`),
    element('div', 'auth-device-meta', `请求时间: ${formatTime(device.requestedAt)}`),
  );
  const actions = element('div', 'auth-device-actions');
  const userSelect = element('select', 'auth-user-select');
  const createOption = element('option', '', `新建用户：${device.displayName || '远程用户'}`);
  createOption.value = '';
  userSelect.append(createOption);
  for (const user of users) {
    const option = element('option', '', `绑定已有用户：${user.displayName}`);
    option.value = user.userId;
    userSelect.append(option);
  }
  const approveBtn = element('button', 'auth-btn auth-btn-approve', '授权');
  approveBtn.addEventListener('click', async () => {
    try {
      await fetch(`/api/auth/approve/${encodeURIComponent(device.deviceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(userSelect.value
          ? { userId: userSelect.value }
          : { displayName: device.displayName || '远程用户' }),
      });
      onChanged();
    } catch {
      // ignore
    }
  });
  const rejectBtn = element('button', 'auth-btn auth-btn-reject', '拒绝');
  rejectBtn.addEventListener('click', async () => {
    try {
      await fetch(`/api/auth/reject/${encodeURIComponent(device.deviceId)}`, { method: 'POST' });
      onChanged();
    } catch {
      // ignore
    }
  });
  actions.append(userSelect, approveBtn, rejectBtn);
  item.append(info, actions);
  return item;
}

function createAuthorizedItem(device: AuthorizedDevice, onChanged: () => void): HTMLLIElement {
  const item = element('li', 'auth-device-item');
  const info = element('div', 'auth-device-info');
  const expiresIn = Math.max(0, Math.floor((device.expiresAt - Date.now()) / (1000 * 60 * 60 * 24)));
  info.append(
    element('div', 'auth-device-id', shortId(device.deviceId)),
    element('div', 'auth-device-meta', `用户: ${device.user?.displayName || shortId(device.userId)}`),
    element('div', 'auth-device-meta', `授权时间: ${formatTime(device.createdAt)}`),
    element('div', 'auth-device-meta', `到期时间: ${formatTime(device.expiresAt)}（${expiresIn} 天后）`),
    element('div', 'auth-device-meta', `最后活跃: ${formatTime(device.lastSeenAt)}`),
  );
  const actions = element('div', 'auth-device-actions');
  const refreshBtn = element('button', 'auth-btn auth-btn-refresh', '续期 7 天');
  refreshBtn.addEventListener('click', async () => {
    try {
      await fetch(`/api/auth/refresh/${encodeURIComponent(device.deviceId)}`, { method: 'POST' });
      onChanged();
    } catch {
      // ignore
    }
  });
  const revokeBtn = element('button', 'auth-btn auth-btn-revoke', '撤销');
  revokeBtn.addEventListener('click', async () => {
    try {
      await fetch(`/api/auth/authorized/${encodeURIComponent(device.deviceId)}`, { method: 'DELETE' });
      onChanged();
    } catch {
      // ignore
    }
  });
  actions.append(refreshBtn, revokeBtn);
  item.append(info, actions);
  return item;
}

async function fetchPending(): Promise<PendingDevice[]> {
  const resp = await fetch('/api/auth/pending', { headers: { accept: 'application/json' } });
  if (!resp.ok) throw new Error(`Failed to fetch pending: ${resp.status}`);
  const data = await resp.json() as { pending?: PendingDevice[] };
  return data.pending ?? [];
}

async function fetchAuthorized(): Promise<AuthorizedDevice[]> {
  const resp = await fetch('/api/auth/authorized', { headers: { accept: 'application/json' } });
  if (!resp.ok) throw new Error(`Failed to fetch authorized: ${resp.status}`);
  const data = await resp.json() as { authorized?: AuthorizedDevice[] };
  return data.authorized ?? [];
}

async function fetchWorkbenchContext(): Promise<WorkbenchContext> {
  const response = await fetch('/api/workbench/context', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Failed to fetch workbench context: ${response.status}`);
  return response.json() as Promise<WorkbenchContext>;
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id;
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString('zh-CN');
  } catch {
    return String(ts);
  }
}

function monogram(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase();
  return label.slice(0, 2).toUpperCase();
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
