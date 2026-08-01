import {
  MYSQL_CORE,
  MYSQL_EXPLORER,
  unwrapMysqlResponse,
  type ConnectionSnapshot,
  type MysqlConnectionProfile,
  type MysqlCredentialCapability,
} from '@itharbors/mysql-contracts';

type PanelContext = {
  message: {
    request(plugin: string, method: string, input?: unknown): Promise<unknown>;
  };
};

type ConnectionForm = {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  tls: boolean;
};

type SavedState = {
  capability: MysqlCredentialCapability | null;
  profiles: MysqlConnectionProfile[];
  selectedProfileId: string | null;
};

type PanelError = { message: string; detail?: string };
type ConnectionMode = 'manual' | 'saved';
type ConnectionActivity =
  | 'hydrate'
  | 'connect'
  | 'connect-saved'
  | 'save'
  | 'update-password'
  | 'delete-profile'
  | 'disconnect'
  | 'refresh'
  | null;
type InvalidField = 'host' | 'port' | 'user' | 'profile-label' | 'replacement-password';
type ConnectionValidation = { field: InvalidField; message: string };

type ActionToken = {
  mountGeneration: number;
  actionSequence: number;
  requestSequence: number;
};

const DISCONNECTED: ConnectionSnapshot = {
  connected: false,
  endpoint: null,
  database: null,
  mysqlVersion: null,
  tls: false,
  profileId: null,
  connectionRevision: 0,
  schemaRevision: 0,
  dataRevision: 0,
};

const CREDENTIALS_UNAVAILABLE: MysqlCredentialCapability = {
  available: false,
  reason: 'CREDENTIALS_UNAVAILABLE',
};

let context: PanelContext | undefined;
let root: HTMLElement | null = null;
let connection: ConnectionSnapshot = { ...DISCONNECTED };
let form = defaultForm();
let saved = defaultSavedState();
let mode: ConnectionMode = 'manual';
let activity: ConnectionActivity = null;
let error: PanelError | null = null;
let notice: string | null = null;
let invalidField: InvalidField | null = null;
let manualConnectEligible = false;
let profileLabel = '';
let replacementPassword = '';
let passwordUpdateVisible = false;
let requestSequence = 0;
let mountGeneration = 0;
let actionSequence = 0;
let activeAction: ActionToken | null = null;

const definition = {
  async mount(ctx: PanelContext) {
    mountGeneration += 1;
    context = ctx;
    root = document.querySelector('#panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    resetState();
    activity = 'hydrate';
    render();
    const sequence = ++requestSequence;
    const [connectionResult, capabilityResult] = await Promise.allSettled([
      requestCore<ConnectionSnapshot>('getConnectionState'),
      requestCore<unknown>('getCredentialCapability'),
    ]);
    if (!isCurrentHydration(sequence)) return;
    if (connectionResult.status === 'rejected') {
      finishHydrationError(sequence, connectionResult.reason);
      return;
    }
    if (!isConnectionSnapshot(connectionResult.value) || isStale(connectionResult.value)) {
      finishHydrationError(sequence, new Error('MySQL 返回了无效的连接状态。'));
      return;
    }

    const capability = capabilityResult.status === 'fulfilled'
      ? sanitizeCapability(capabilityResult.value)
      : CREDENTIALS_UNAVAILABLE;
    let profiles: MysqlConnectionProfile[] = [];
    let profileError: PanelError | null = null;
    if (capability.available) {
      try {
        profiles = sanitizeProfiles(await requestCore<unknown>('listConnectionProfiles'));
      } catch (caught) {
        profileError = panelError(caught);
      }
      if (!isCurrentHydration(sequence)) return;
    }

    connection = { ...connectionResult.value };
    saved = {
      capability,
      profiles,
      selectedProfileId: selectAvailableProfile(connectionResult.value.profileId, profiles),
    };
    activity = null;
    error = profileError;
    render();
  },

  unmount() {
    mountGeneration += 1;
    requestSequence += 1;
    activeAction = null;
    root?.replaceChildren();
    root = null;
    context = undefined;
    connection = { ...DISCONNECTED };
    form = defaultForm();
    saved = defaultSavedState();
    mode = 'manual';
    activity = null;
    error = null;
    notice = null;
    invalidField = null;
    manualConnectEligible = false;
    profileLabel = '';
    replacementPassword = '';
    passwordUpdateVisible = false;
  },

  methods: {
    onConnectionChanged(payload: unknown) {
      if (!isConnectionSnapshot(payload) || isStale(payload)) return;
      manualConnectEligible = activity === 'connect' && payload.connected && payload.profileId === null;
      acceptConnection(payload);
    },
  },
};

export default definition;

function defaultForm(): ConnectionForm {
  return {
    host: '127.0.0.1',
    port: '3306',
    user: 'root',
    password: '',
    database: '',
    tls: false,
  };
}

function defaultSavedState(): SavedState {
  return { capability: null, profiles: [], selectedProfileId: null };
}

function resetState(): void {
  connection = { ...DISCONNECTED };
  form = defaultForm();
  saved = defaultSavedState();
  mode = 'manual';
  activity = null;
  error = null;
  notice = null;
  invalidField = null;
  manualConnectEligible = false;
  profileLabel = '';
  replacementPassword = '';
  passwordUpdateVisible = false;
  activeAction = null;
  requestSequence += 1;
}

function isCurrentHydration(sequence: number): boolean {
  return sequence === requestSequence
    && context !== undefined
    && root?.isConnected === true;
}

function finishHydrationError(sequence: number, caught: unknown): void {
  if (!isCurrentHydration(sequence)) return;
  activity = null;
  error = panelError(caught);
  saved.capability = CREDENTIALS_UNAVAILABLE;
  render();
}

function acceptConnection(next: ConnectionSnapshot): void {
  requestSequence += 1;
  if (activity === 'hydrate') activity = null;
  connection = { ...next };
  if (next.profileId && saved.profiles.some((profile) => profile.id === next.profileId)) {
    saved.selectedProfileId = next.profileId;
  }
  error = null;
  notice = null;
  invalidField = null;
  render();
}

function isStale(next: ConnectionSnapshot): boolean {
  return next.connectionRevision < connection.connectionRevision
    || (
      next.connectionRevision === connection.connectionRevision
      && next.schemaRevision < connection.schemaRevision
    );
}

async function connect(): Promise<void> {
  const validation = validateConnectionForm();
  if (validation) {
    showValidation(validation);
    return;
  }
  invalidField = null;
  const input = {
    host: form.host.trim(),
    port: Number(form.port),
    user: form.user.trim(),
    password: form.password,
    database: form.database.trim() || null,
    tls: form.tls,
  };
  await runAction('connect', async (token) => {
    const pendingConnection = requestCore<ConnectionSnapshot>('connect', input);
    form.password = '';
    render();
    const next = await pendingConnection;
    if (!isCurrentActionResult(token) || !isConnectionSnapshot(next) || isStale(next)) return;
    manualConnectEligible = next.connected && next.profileId === null;
    acceptConnection(next);
  });
}

function validateConnectionForm(): ConnectionValidation | null {
  if (!form.host.trim()) return { field: 'host', message: '请输入 MySQL 主机。' };
  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { field: 'port', message: '端口必须是 1 到 65535 之间的整数。' };
  }
  if (!form.user.trim()) return { field: 'user', message: '请输入 MySQL 用户名。' };
  return null;
}

function showValidation(validation: ConnectionValidation): void {
  invalidField = validation.field;
  error = { message: validation.message };
  notice = null;
  render();
  queueMicrotask(() => {
    root?.querySelector<HTMLInputElement>(`[data-field="${validation.field}"]`)?.focus();
  });
}

async function connectSaved(): Promise<void> {
  const profileId = selectedProfile()?.id;
  if (!profileId) return;
  await runAction('connect-saved', async (token) => {
    const next = await requestCore<ConnectionSnapshot>('connectSaved', { profileId });
    if (!isCurrentActionResult(token) || !isConnectionSnapshot(next) || isStale(next)) return;
    manualConnectEligible = false;
    acceptConnection(next);
  });
}

async function saveCurrentConnection(): Promise<void> {
  const label = profileLabel.trim();
  if (!label || label.length > 80) {
    showValidation({
      field: 'profile-label',
      message: label ? '连接名称不能超过 80 个字符。' : '请输入连接名称。',
    });
    return;
  }
  await runAction('save', async (token) => {
    const next = sanitizeProfile(await requestCore<unknown>('saveCurrentConnection', { label }));
    if (!isCurrentAction(token) || !next) {
      if (isCurrentAction(token)) throw new Error('MySQL 返回了无效的连接资料。');
      return;
    }
    upsertProfile(next);
    saved.selectedProfileId = next.id;
    manualConnectEligible = false;
    profileLabel = '';
    notice = '连接已保存到本机凭据库。';
  });
}

async function updatePassword(): Promise<void> {
  const profileId = selectedProfile()?.id;
  if (!profileId) return;
  if (!replacementPassword || replacementPassword.length > 4096) {
    showValidation({
      field: 'replacement-password',
      message: replacementPassword ? '新密码不能超过 4096 个字符。' : '请输入完整的新密码。',
    });
    return;
  }
  const password = replacementPassword;
  await runAction('update-password', async (token) => {
    const pendingUpdate = requestCore<unknown>('updateConnectionProfile', { profileId, password });
    replacementPassword = '';
    render();
    const next = sanitizeProfile(await pendingUpdate);
    if (!isCurrentAction(token) || !next) {
      if (isCurrentAction(token)) throw new Error('MySQL 返回了无效的连接资料。');
      return;
    }
    upsertProfile(next);
    passwordUpdateVisible = false;
    manualConnectEligible = false;
    notice = '密码已更新并重新连接。';
  });
}

async function deleteProfile(): Promise<void> {
  const profileId = selectedProfile()?.id;
  if (!profileId || !window.confirm('将删除本机保存的连接和密码，是否继续？')) return;
  await runAction('delete-profile', async (token) => {
    await requestCore<unknown>('deleteConnectionProfile', { profileId });
    if (!isCurrentAction(token)) return;
    saved.profiles = saved.profiles.filter((profile) => profile.id !== profileId);
    saved.selectedProfileId = selectAvailableProfile(null, saved.profiles);
    replacementPassword = '';
    passwordUpdateVisible = false;
    manualConnectEligible = false;
    notice = '已删除本机保存的连接和密码。';
  });
}

async function disconnect(): Promise<void> {
  await runAction('disconnect', async (token) => {
    const next = await requestCore<ConnectionSnapshot>('disconnect');
    if (!isCurrentActionResult(token) || !isConnectionSnapshot(next) || isStale(next)) return;
    manualConnectEligible = false;
    acceptConnection(next);
  });
}

async function refreshObjects(): Promise<void> {
  await runAction('refresh', async (token) => {
    await requestExplorer('refreshObjects');
    if (!isCurrentActionResult(token)) return;
    error = null;
  });
}

async function runAction(
  kind: Exclude<ConnectionActivity, 'hydrate' | null>,
  action: (token: ActionToken) => Promise<void>,
): Promise<void> {
  if (activity !== null) return;
  activity = kind;
  error = null;
  notice = null;
  invalidField = null;
  const token: ActionToken = {
    mountGeneration,
    actionSequence: ++actionSequence,
    requestSequence: ++requestSequence,
  };
  activeAction = token;
  render();
  try {
    await action(token);
  } catch (caught) {
    if (isCurrentActionResult(token) || (isProfileActivity(kind) && isCurrentAction(token))) {
      error = panelError(caught);
    }
  } finally {
    if (!isCurrentAction(token)) return;
    activeAction = null;
    activity = null;
    render();
  }
}

function isProfileActivity(kind: ConnectionActivity): boolean {
  return kind === 'save' || kind === 'update-password' || kind === 'delete-profile';
}

function isCurrentAction(token: ActionToken): boolean {
  return activeAction === token
    && token.mountGeneration === mountGeneration
    && context !== undefined
    && root?.isConnected === true;
}

function isCurrentActionResult(token: ActionToken): boolean {
  return isCurrentAction(token) && token.requestSequence === requestSequence;
}

async function requestCore<T>(method: string, input?: unknown): Promise<T> {
  if (!context) throw new Error('MySQL 连接栏尚未挂载。');
  return unwrapMysqlResponse<T>(await context.message.request(MYSQL_CORE, method, input));
}

async function requestExplorer(method: string, input?: unknown): Promise<unknown> {
  if (!context) throw new Error('MySQL 连接栏尚未挂载。');
  return context.message.request(MYSQL_EXPLORER, method, input);
}

function render(): void {
  if (!root) return;
  const fieldsDisabled = connection.connected || activity !== null;
  root.innerHTML = `
    <main class="connection-shell">
      <header class="connection-deck">
        <div class="brand-block" aria-label="MySQL 工作台">
          <span class="brand-mark" aria-hidden="true">MY</span>
          <span class="brand-copy"><strong>MySQL 工作台</strong><small>直连数据库</small></span>
        </div>
        <section class="connection-workspace">
          ${renderModeSelector()}
          ${mode === 'saved' && saved.capability?.available
            ? renderSavedConnection()
            : renderManualConnection(fieldsDisabled)}
        </section>
        <div class="connection-readout" data-connection="${connection.connected ? 'connected' : 'disconnected'}" role="status" aria-live="polite">
          ${renderConnectionReadout()}
          ${renderCredentialStatus()}
          ${notice ? `<span class="connection-notice">${escapeHtml(notice)}</span>` : ''}
          ${error ? `<span id="connection-error" class="connection-error" role="alert" title="${escapeHtml(error.detail ?? error.message)}">${escapeHtml(error.message)}</span>` : ''}
        </div>
      </header>
    </main>`;

  bindEvents();
}

function renderModeSelector(): string {
  const manualSelected = mode === 'manual';
  const savedAvailable = saved.capability?.available === true;
  return `<div class="connection-mode" role="tablist" aria-label="连接方式">
    <button data-connection-mode="manual" role="tab" type="button" aria-selected="${manualSelected}" tabindex="${manualSelected ? '0' : '-1'}"${activity !== null ? ' disabled' : ''}>手工连接</button>
    ${savedAvailable ? `<button data-connection-mode="saved" role="tab" type="button" aria-selected="${!manualSelected}" tabindex="${manualSelected ? '-1' : '0'}"${activity !== null ? ' disabled' : ''}>已保存连接</button>` : ''}
  </div>`;
}

function renderManualConnection(fieldsDisabled: boolean): string {
  return `<div class="manual-connection">
    <form class="connection-form" data-connection-form aria-busy="${activity !== null}">
      ${field('host', '主机', form.host, 'text', 'off', '', fieldsDisabled)}
      ${field('port', '端口', form.port, 'number', 'off', 'port-field', fieldsDisabled)}
      ${field('user', '用户名', form.user, 'text', 'username', '', fieldsDisabled)}
      ${field('password', '密码', form.password, 'password', 'current-password', '', fieldsDisabled)}
      ${field('database', '数据库（可选）', form.database, 'text', 'off', '', fieldsDisabled)}
      <label class="tls-field"><input data-field="tls" name="tls" type="checkbox"${form.tls ? ' checked' : ''}${fieldsDisabled ? ' disabled' : ''}><span>TLS</span></label>
      <div class="connection-actions">${renderConnectionActions()}</div>
    </form>
    ${renderManualSave()}
  </div>`;
}

function renderManualSave(): string {
  if (!manualConnectEligible || !saved.capability?.available || !connection.connected) return '';
  const pending = activity === 'save';
  return `<div class="manual-save" aria-busy="${pending}">
    ${simpleField('profile-label', '连接名称', profileLabel, 'text', 'off', '例如：本机开发库', activity !== null, 80)}
    <button data-action="save-connection" type="button"${activity !== null ? ' disabled' : ''}>${pending ? `${spinner()}保存中…` : '保存连接'}</button>
  </div>`;
}

function renderSavedConnection(): string {
  const profiles = saved.profiles;
  if (profiles.length === 0) {
    return `<section class="saved-connection" data-empty-profiles>
      <p>还没有保存的连接。请先通过手工连接成功登录，再保存到本机凭据库。</p>
    </section>`;
  }
  const selected = selectedProfile() ?? profiles[0];
  const disabled = activity !== null;
  const connectedToSelected = connection.connected && connection.profileId === selected.id;
  return `<section class="saved-connection" aria-busy="${activity !== null}">
    <label class="profile-select">已保存连接<select data-field="profile" name="profile"${disabled ? ' disabled' : ''}>
      ${profiles.map((profile) => `<option value="${escapeHtml(profile.id)}"${profile.id === selected.id ? ' selected' : ''}>${escapeHtml(profile.label)}</option>`).join('')}
    </select></label>
    <div class="profile-summary" data-selected-profile>
      <strong>${escapeHtml(selected.label)}</strong>
      <span>${escapeHtml(selected.user)} @ ${escapeHtml(selected.host)}:${selected.port}</span>
      <span>${selected.database ? escapeHtml(selected.database) : '未指定数据库'} · ${selected.tls ? 'TLS' : '无 TLS'}</span>
    </div>
    <div class="saved-actions">
      ${connectedToSelected ? renderConnectedActions() : `<button class="primary-action" data-action="connect-saved" type="button"${disabled ? ' disabled' : ''}>${activity === 'connect-saved' ? `${spinner()}连接中…` : '连接所选项'}</button>`}
      <button data-action="show-password-update" type="button"${disabled ? ' disabled' : ''}>更新密码</button>
      <button class="danger-action" data-action="delete-profile" type="button"${disabled ? ' disabled' : ''}>${activity === 'delete-profile' ? `${spinner()}删除中…` : '删除'}</button>
    </div>
    ${passwordUpdateVisible ? `<div class="password-update">
      ${simpleField('replacement-password', '完整的新密码', replacementPassword, 'password', 'new-password', '', disabled, 4096)}
      <button data-action="update-password" type="button"${disabled ? ' disabled' : ''}>${activity === 'update-password' ? `${spinner()}验证中…` : '验证并更新'}</button>
      <button data-action="cancel-password-update" type="button"${disabled ? ' disabled' : ''}>取消</button>
    </div>` : ''}
  </section>`;
}

function renderConnectionActions(): string {
  if (!connection.connected) {
    const pending = activity === 'connect';
    return `<button class="primary-action${pending ? ' is-busy' : ''}" data-action="connect" type="button"${activity !== null ? ' disabled' : ''}>${pending ? `${spinner()}连接中…` : '连接'}</button>`;
  }
  return renderConnectedActions();
}

function renderConnectedActions(): string {
  const disabled = activity !== null ? ' disabled' : '';
  const disconnecting = activity === 'disconnect';
  const refreshing = activity === 'refresh';
  return `<button class="${disconnecting ? 'is-busy' : ''}" data-action="disconnect" type="button"${disabled}>${disconnecting ? `${spinner()}断开中…` : '断开连接'}</button>
    <button class="icon-action${refreshing ? ' is-busy' : ''}" data-action="refresh" type="button" aria-label="${refreshing ? '刷新中' : '刷新数据库'}"${disabled}>${refreshing ? `${spinner()}<span>刷新中…</span>` : '↻'}</button>`;
}

function bindEvents(): void {
  root?.querySelector('[data-connection-mode="manual"]')?.addEventListener('click', () => switchMode('manual'));
  root?.querySelector('[data-connection-mode="saved"]')?.addEventListener('click', () => switchMode('saved'));
  root?.querySelector('[data-action="connect"]')?.addEventListener('click', () => void connect());
  root?.querySelector('[data-action="connect-saved"]')?.addEventListener('click', () => void connectSaved());
  root?.querySelector('[data-action="save-connection"]')?.addEventListener('click', () => void saveCurrentConnection());
  root?.querySelector('[data-action="show-password-update"]')?.addEventListener('click', () => {
    passwordUpdateVisible = true;
    replacementPassword = '';
    error = null;
    notice = null;
    render();
    queueMicrotask(() => root?.querySelector<HTMLInputElement>('[data-field="replacement-password"]')?.focus());
  });
  root?.querySelector('[data-action="cancel-password-update"]')?.addEventListener('click', () => {
    passwordUpdateVisible = false;
    replacementPassword = '';
    invalidField = null;
    error = null;
    render();
  });
  root?.querySelector('[data-action="update-password"]')?.addEventListener('click', () => void updatePassword());
  root?.querySelector('[data-action="delete-profile"]')?.addEventListener('click', () => void deleteProfile());
  root?.querySelector('[data-action="disconnect"]')?.addEventListener('click', () => void disconnect());
  root?.querySelector('[data-action="refresh"]')?.addEventListener('click', () => void refreshObjects());
  root?.querySelector<HTMLFormElement>('[data-connection-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!connection.connected && activity === null) void connect();
  });
  for (const name of ['host', 'port', 'user', 'password', 'database'] as const) {
    root?.querySelector<HTMLInputElement>(`[data-field="${name}"]`)?.addEventListener('input', (event) => {
      form[name] = (event.currentTarget as HTMLInputElement).value;
      clearFieldError(name);
    });
  }
  root?.querySelector<HTMLInputElement>('[data-field="tls"]')?.addEventListener('change', (event) => {
    form.tls = (event.currentTarget as HTMLInputElement).checked;
  });
  root?.querySelector<HTMLInputElement>('[data-field="profile-label"]')?.addEventListener('input', (event) => {
    profileLabel = (event.currentTarget as HTMLInputElement).value;
    clearFieldError('profile-label');
  });
  root?.querySelector<HTMLInputElement>('[data-field="replacement-password"]')?.addEventListener('input', (event) => {
    replacementPassword = (event.currentTarget as HTMLInputElement).value;
    clearFieldError('replacement-password');
  });
  root?.querySelector<HTMLSelectElement>('[data-field="profile"]')?.addEventListener('change', (event) => {
    const profileId = (event.currentTarget as HTMLSelectElement).value;
    saved.selectedProfileId = saved.profiles.some((profile) => profile.id === profileId) ? profileId : null;
    passwordUpdateVisible = false;
    replacementPassword = '';
    invalidField = null;
    error = null;
    notice = null;
    render();
  });
}

function switchMode(next: ConnectionMode): void {
  if (activity !== null || (next === 'saved' && !saved.capability?.available)) return;
  mode = next;
  replacementPassword = '';
  passwordUpdateVisible = false;
  invalidField = null;
  error = null;
  notice = null;
  render();
}

function clearFieldError(field: InvalidField | 'password' | 'database'): void {
  if (invalidField !== field) return;
  invalidField = null;
  error = null;
  render();
  queueMicrotask(() => root?.querySelector<HTMLInputElement>(`[data-field="${field}"]`)?.focus());
}

function spinner(): string {
  return '<span class="activity-spinner" aria-hidden="true"></span>';
}

function renderConnectionReadout(): string {
  if (activity === 'hydrate') {
    return `<span class="connection-state">正在读取连接状态…</span>${spinner()}`;
  }
  if (!connection.connected) {
    const state = activity === 'connect' || activity === 'connect-saved' ? '正在连接…' : '未连接';
    return `<span class="connection-state">${state}</span><span>手工凭据仅保留在当前服务端会话中；已保存密码由本机凭据库保管。</span>`;
  }
  const activityLabel = activity === 'disconnect'
    ? '<span class="connection-activity">正在断开连接…</span>'
    : activity === 'refresh'
      ? '<span class="connection-activity">正在刷新数据库对象…</span>'
      : '';
  return `<span class="connection-state">已连接</span>
    <strong data-current-endpoint>${escapeHtml(connection.endpoint ?? 'MySQL')}</strong>
    <span class="connection-database">${connection.database ? escapeHtml(connection.database) : '未选择数据库'}</span>
    <span>MySQL ${escapeHtml(connection.mysqlVersion ?? '未知版本')}</span>
    ${connection.tls ? '<span class="secure-badge">TLS 已验证</span>' : ''}
    ${activityLabel}`;
}

function renderCredentialStatus(): string {
  const capability = saved.capability;
  if (!capability || capability.available !== false) return '';
  const message = capability.reason === 'CREDENTIALS_DISABLED'
    ? '当前宿主未启用本机凭据；仍可使用手工连接。'
    : capability.reason === 'CREDENTIALS_LOCKED'
      ? '请先解锁本机凭据库；仍可使用手工连接。'
      : '本机凭据库当前不可用；仍可使用手工连接。';
  return `<span class="credential-status">${message}</span>`;
}

function field(
  name: keyof Omit<ConnectionForm, 'tls'>,
  label: string,
  value: string,
  type: string,
  autocomplete: string,
  className = '',
  disabled = false,
): string {
  const required = name === 'host' || name === 'port' || name === 'user';
  return `<label${className ? ` class="${className}"` : ''}>${label}<input data-field="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" autocomplete="${autocomplete}"${name === 'port' ? ' min="1" max="65535"' : ''}${name === 'database' ? ' placeholder="连接后选择…"' : ''}${required ? ' required' : ''}${invalidAttributes(name)}${disabled ? ' disabled' : ''}></label>`;
}

function simpleField(
  name: 'profile-label' | 'replacement-password',
  label: string,
  value: string,
  type: string,
  autocomplete: string,
  placeholder: string,
  disabled: boolean,
  maxLength: number,
): string {
  return `<label>${label}<input data-field="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" autocomplete="${autocomplete}"${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ''} maxlength="${maxLength}"${invalidAttributes(name)}${disabled ? ' disabled' : ''}></label>`;
}

function invalidAttributes(name: string): string {
  return invalidField === name ? ' aria-invalid="true" aria-describedby="connection-error"' : '';
}

function selectedProfile(): MysqlConnectionProfile | null {
  return saved.profiles.find((profile) => profile.id === saved.selectedProfileId) ?? null;
}

function upsertProfile(next: MysqlConnectionProfile): void {
  const currentIndex = saved.profiles.findIndex((profile) => profile.id === next.id);
  saved.profiles = currentIndex === -1
    ? [...saved.profiles, next]
    : saved.profiles.map((profile, index) => index === currentIndex ? next : profile);
}

function selectAvailableProfile(
  preferredId: string | null,
  profiles: MysqlConnectionProfile[],
): string | null {
  return profiles.some((profile) => profile.id === preferredId)
    ? preferredId
    : profiles[0]?.id ?? null;
}

function sanitizeCapability(value: unknown): MysqlCredentialCapability {
  if (!isRecord(value) || typeof value.available !== 'boolean') return CREDENTIALS_UNAVAILABLE;
  if (value.available) return { available: true };
  return value.reason === 'CREDENTIALS_DISABLED'
    || value.reason === 'CREDENTIALS_UNAVAILABLE'
    || value.reason === 'CREDENTIALS_LOCKED'
    ? { available: false, reason: value.reason }
    : CREDENTIALS_UNAVAILABLE;
}

function sanitizeProfiles(value: unknown): MysqlConnectionProfile[] {
  if (!Array.isArray(value)) throw new Error('MySQL 返回了无效的连接资料列表。');
  const profiles: MysqlConnectionProfile[] = [];
  for (const candidate of value) {
    const profile = sanitizeProfile(candidate);
    if (!profile) throw new Error('MySQL 返回了无效的连接资料。');
    profiles.push(profile);
  }
  return profiles;
}

function sanitizeProfile(value: unknown): MysqlConnectionProfile | null {
  const database = isRecord(value) ? value.database : undefined;
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.label !== 'string'
    || typeof value.host !== 'string'
    || !Number.isInteger(value.port)
    || typeof value.user !== 'string'
    || !(database === null || typeof database === 'string')
    || typeof value.tls !== 'boolean'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string') return null;
  return {
    id: value.id,
    label: value.label,
    host: value.host,
    port: value.port as number,
    user: value.user,
    database: database as string | null,
    tls: value.tls,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function panelError(caught: unknown): PanelError {
  return caught instanceof Error
    ? {
      message: caught.message,
      ...('detail' in caught && typeof caught.detail === 'string' ? { detail: caught.detail } : {}),
    }
    : { message: String(caught) };
}

function isConnectionSnapshot(value: unknown): value is ConnectionSnapshot {
  return isRecord(value)
    && typeof value.connected === 'boolean'
    && (value.endpoint === null || typeof value.endpoint === 'string')
    && (value.database === null || typeof value.database === 'string')
    && (value.mysqlVersion === null || typeof value.mysqlVersion === 'string')
    && typeof value.tls === 'boolean'
    && (value.profileId === null || typeof value.profileId === 'string')
    && isRevision(value.connectionRevision)
    && isRevision(value.schemaRevision)
    && isRevision(value.dataRevision);
}

function isRevision(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[character] ?? character);
}
