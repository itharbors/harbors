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
  interactionGeneration: number;
  kind: Exclude<ConnectionActivity, 'hydrate' | null>;
  startConnection: ConnectionSnapshot;
  broadcasts: ConnectionSnapshot[];
};

type HydrationToken = {
  mountGeneration: number;
  hydrationGeneration: number;
  connectionGeneration: number;
};

type SanitizedProfiles = {
  profiles: MysqlConnectionProfile[];
  droppedInvalid: boolean;
};

type ProfileListToken = {
  mountGeneration: number;
  profileListGeneration: number;
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
let connection: ConnectionSnapshot = disconnectedSnapshot();
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
let mountGeneration = 0;
let hydrationGeneration = 0;
let connectionGeneration = 0;
let interactionGeneration = 0;
let profileListGeneration = 0;
let feedbackGeneration = 0;
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
    const hydration: HydrationToken = {
      mountGeneration,
      hydrationGeneration: ++hydrationGeneration,
      connectionGeneration,
    };
    const [connectionResult, capabilityResult] = await Promise.allSettled([
      requestCore<unknown>('getConnectionState'),
      requestCore<unknown>('getCredentialCapability'),
    ]);
    if (!isCurrentHydration(hydration)) return;

    const capability = capabilityResult.status === 'fulfilled'
      ? sanitizeCapability(capabilityResult.value)
      : CREDENTIALS_UNAVAILABLE;
    let profiles: MysqlConnectionProfile[] = [];
    let profileError: PanelError | null = null;
    if (capability.available) {
      const profileListToken = beginProfileList();
      try {
        const sanitized = sanitizeProfiles(await requestCore<unknown>('listConnectionProfiles'));
        profiles = sanitized.profiles;
        if (sanitized.droppedInvalid) {
          profileError = { message: '部分保存的连接资料无效，已忽略。' };
        }
      } catch (caught) {
        profileError = panelError(caught);
      }
      if (!isCurrentHydration(hydration) || !isCurrentProfileList(profileListToken)) return;
    } else {
      profileListGeneration += 1;
    }

    saved = {
      capability,
      profiles,
      selectedProfileId: selectAvailableProfile(connection.profileId, profiles),
    };
    let connectionError: PanelError | null = null;
    if (connectionGeneration === hydration.connectionGeneration) {
      if (connectionResult.status === 'fulfilled') {
        const hydratedConnection = sanitizeConnectionSnapshot(connectionResult.value);
        if (hydratedConnection) {
          acceptConnection(hydratedConnection);
        } else {
          connectionError = { message: 'MySQL 返回了无效的连接状态。' };
        }
      } else {
        connectionError = panelError(connectionResult.reason);
      }
    }
    if (activity === 'hydrate') activity = null;
    error = profileError ?? connectionError;
    render();
  },

  unmount() {
    mountGeneration += 1;
    hydrationGeneration += 1;
    activeAction = null;
    root?.replaceChildren();
    root = null;
    context = undefined;
    connection = disconnectedSnapshot();
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
    connectionGeneration = 0;
    interactionGeneration = 0;
    profileListGeneration += 1;
    feedbackGeneration = 0;
  },

  methods: {
    onConnectionChanged(payload: unknown) {
      const next = sanitizeConnectionSnapshot(payload);
      if (!next || isStale(next)) return;
      if (activeAction && isActiveAction(activeAction)) activeAction.broadcasts.push(next);
      manualConnectEligible = false;
      acceptConnection(next);
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

function disconnectedSnapshot(): ConnectionSnapshot {
  return {
    connected: DISCONNECTED.connected,
    endpoint: DISCONNECTED.endpoint,
    database: DISCONNECTED.database,
    mysqlVersion: DISCONNECTED.mysqlVersion,
    tls: DISCONNECTED.tls,
    profileId: DISCONNECTED.profileId,
    connectionRevision: DISCONNECTED.connectionRevision,
    schemaRevision: DISCONNECTED.schemaRevision,
    dataRevision: DISCONNECTED.dataRevision,
  };
}

function defaultSavedState(): SavedState {
  return { capability: null, profiles: [], selectedProfileId: null };
}

function resetState(): void {
  connection = disconnectedSnapshot();
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
  hydrationGeneration += 1;
  connectionGeneration = 0;
  interactionGeneration = 0;
  profileListGeneration += 1;
  feedbackGeneration = 0;
}

function isCurrentHydration(token: HydrationToken): boolean {
  return token.mountGeneration === mountGeneration
    && token.hydrationGeneration === hydrationGeneration
    && context !== undefined
    && root?.isConnected === true;
}

function acceptConnection(next: ConnectionSnapshot): void {
  connectionGeneration += 1;
  if (activity === 'hydrate') activity = null;
  connection = next;
  if (next.profileId && saved.profiles.some((profile) => profile.id === next.profileId)) {
    saved.selectedProfileId = next.profileId;
  }
  feedbackGeneration += 1;
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
    const pendingConnection = requestCore<unknown>('connect', input);
    form.password = '';
    render();
    const next = sanitizeConnectionSnapshot(await pendingConnection);
    if (!isActionResultCurrent(token) || !next || isStale(next)) return;
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
  feedbackGeneration += 1;
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
    const next = sanitizeConnectionSnapshot(
      await requestCore<unknown>('connectSaved', { profileId }),
    );
    if (!isActionResultCurrent(token) || !next || isStale(next)) return;
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
    if (!next) {
      if (isActionResultCurrent(token)) throw new Error('MySQL 返回了无效的连接资料。');
      return;
    }
    if (!isProfileResultCurrent(token, next)) {
      reconcileProfilesAfterConfirmedMutation(token);
      return;
    }
    profileListGeneration += 1;
    upsertProfile(next);
    saved.selectedProfileId = next.id;
    manualConnectEligible = false;
    profileLabel = '';
    feedbackGeneration += 1;
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
    if (!next) {
      if (isActionResultCurrent(token)) throw new Error('MySQL 返回了无效的连接资料。');
      return;
    }
    if (!isProfileResultCurrent(token, next)) {
      reconcileProfilesAfterConfirmedMutation(token);
      return;
    }
    profileListGeneration += 1;
    upsertProfile(next);
    passwordUpdateVisible = false;
    manualConnectEligible = false;
    feedbackGeneration += 1;
    notice = '密码已更新并重新连接。';
  });
}

async function deleteProfile(): Promise<void> {
  const profileId = selectedProfile()?.id;
  if (!profileId || !window.confirm('将删除本机保存的连接和密码，是否继续？')) return;
  await runAction('delete-profile', async (token) => {
    const response = await requestCore<unknown>('deleteConnectionProfile', { profileId });
    if (!isDeleteResponse(response, profileId)) {
      if (isActionResultCurrent(token)) throw new Error('MySQL 返回了无效的删除结果。');
      return;
    }
    if (!isDeleteResultCurrent(token, profileId)) {
      reconcileProfilesAfterConfirmedMutation(token);
      return;
    }
    profileListGeneration += 1;
    saved.profiles = saved.profiles.filter((profile) => profile.id !== profileId);
    saved.selectedProfileId = selectAvailableProfile(null, saved.profiles);
    replacementPassword = '';
    passwordUpdateVisible = false;
    manualConnectEligible = false;
    feedbackGeneration += 1;
    notice = '已删除本机保存的连接和密码。';
  });
}

async function disconnect(): Promise<void> {
  await runAction('disconnect', async (token) => {
    const next = sanitizeConnectionSnapshot(await requestCore<unknown>('disconnect'));
    if (!isActionResultCurrent(token) || !next || isStale(next)) return;
    manualConnectEligible = false;
    acceptConnection(next);
  });
}

async function refreshObjects(): Promise<void> {
  await runAction('refresh', async (token) => {
    await requestExplorer('refreshObjects');
    if (!isActionResultCurrent(token)) return;
    error = null;
  });
}

async function runAction(
  kind: Exclude<ConnectionActivity, 'hydrate' | null>,
  action: (token: ActionToken) => Promise<void>,
): Promise<void> {
  if (activity !== null) return;
  activity = kind;
  feedbackGeneration += 1;
  error = null;
  notice = null;
  invalidField = null;
  const token: ActionToken = {
    mountGeneration,
    actionSequence: ++actionSequence,
    interactionGeneration,
    kind,
    startConnection: connection,
    broadcasts: [],
  };
  activeAction = token;
  render();
  try {
    await action(token);
  } catch (caught) {
    if (isActionResultCurrent(token)) {
      feedbackGeneration += 1;
      error = panelError(caught);
    }
  } finally {
    if (!isActiveAction(token)) return;
    activeAction = null;
    activity = null;
    render();
  }
}

function isProfileActivity(kind: ConnectionActivity): boolean {
  return kind === 'save' || kind === 'update-password' || kind === 'delete-profile';
}

function isActiveAction(token: ActionToken): boolean {
  return activeAction === token
    && token.mountGeneration === mountGeneration
    && context !== undefined
    && root?.isConnected === true;
}

function isActionResultCurrent(token: ActionToken): boolean {
  return isActiveAction(token) && token.interactionGeneration === interactionGeneration;
}

function isActionMountCurrent(token: ActionToken): boolean {
  return token.mountGeneration === mountGeneration
    && context !== undefined
    && root?.isConnected === true;
}

function beginProfileList(): ProfileListToken {
  return {
    mountGeneration,
    profileListGeneration: ++profileListGeneration,
  };
}

function isCurrentProfileList(token: ProfileListToken): boolean {
  return token.mountGeneration === mountGeneration
    && token.profileListGeneration === profileListGeneration
    && context !== undefined
    && root?.isConnected === true;
}

function reconcileProfilesAfterConfirmedMutation(token: ActionToken): void {
  if (!isActionMountCurrent(token) || saved.capability?.available !== true) return;
  const profileListToken = beginProfileList();
  const startingFeedbackGeneration = feedbackGeneration;
  void reconcileProfiles(profileListToken, startingFeedbackGeneration);
}

async function reconcileProfiles(
  token: ProfileListToken,
  startingFeedbackGeneration: number,
): Promise<void> {
  try {
    const sanitized = sanitizeProfiles(await requestCore<unknown>('listConnectionProfiles'));
    if (!isCurrentProfileList(token) || saved.capability?.available !== true) return;
    const preferredProfileId = saved.selectedProfileId;
    saved.profiles = sanitized.profiles;
    saved.selectedProfileId = selectReconciledProfile(preferredProfileId, sanitized.profiles);
    if (sanitized.droppedInvalid && feedbackGeneration === startingFeedbackGeneration) {
      feedbackGeneration += 1;
      error = { message: '部分保存的连接资料无效，已忽略。' };
      notice = null;
    }
    render();
  } catch {
    if (!isCurrentProfileList(token) || saved.capability?.available !== true) return;
    if (feedbackGeneration === startingFeedbackGeneration) {
      feedbackGeneration += 1;
      error = { message: '保存的连接列表刷新失败，请重试。' };
      notice = null;
      render();
    }
  }
}

function isProfileResultCurrent(token: ActionToken, profile: MysqlConnectionProfile): boolean {
  if (!isActionResultCurrent(token)) return false;
  if (token.broadcasts.length === 0) return sameRevisions(connection, token.startConnection);
  if (token.broadcasts.length !== 1) return false;
  const [broadcast] = token.broadcasts;
  if (!broadcast || !sameConnectionSnapshot(connection, broadcast)) return false;
  if (broadcast.connectionRevision !== token.startConnection.connectionRevision + 1) return false;
  if (token.kind === 'save') {
    return token.startConnection.connected
      && token.startConnection.profileId === null
      && broadcast.connected
      && broadcast.profileId === profile.id
      && sameConnectionIdentity(broadcast, token.startConnection);
  }
  if (token.kind === 'update-password') {
    return broadcast.connected
      && broadcast.profileId === profile.id
      && broadcast.endpoint === `${profile.host}:${profile.port}`
      && broadcast.database === profile.database
      && broadcast.tls === profile.tls;
  }
  return false;
}

function isDeleteResultCurrent(token: ActionToken, profileId: string): boolean {
  if (!isActionResultCurrent(token)) return false;
  if (token.broadcasts.length === 0) {
    return token.startConnection.profileId !== profileId
      && sameRevisions(connection, token.startConnection);
  }
  if (token.broadcasts.length !== 1 || token.startConnection.profileId !== profileId) return false;
  const [broadcast] = token.broadcasts;
  return broadcast !== undefined
    && sameConnectionSnapshot(connection, broadcast)
    && broadcast.connectionRevision === token.startConnection.connectionRevision + 1
    && !broadcast.connected
    && broadcast.profileId === null;
}

function sameConnectionIdentity(left: ConnectionSnapshot, right: ConnectionSnapshot): boolean {
  return left.connected === right.connected
    && left.endpoint === right.endpoint
    && left.database === right.database
    && left.mysqlVersion === right.mysqlVersion
    && left.tls === right.tls;
}

function sameRevisions(left: ConnectionSnapshot, right: ConnectionSnapshot): boolean {
  return left.connectionRevision === right.connectionRevision
    && left.schemaRevision === right.schemaRevision
    && left.dataRevision === right.dataRevision;
}

function sameConnectionSnapshot(left: ConnectionSnapshot, right: ConnectionSnapshot): boolean {
  return sameConnectionIdentity(left, right)
    && left.profileId === right.profileId
    && sameRevisions(left, right);
}

function isDeleteResponse(value: unknown, profileId: string): boolean {
  return isRecord(value) && value.deleted === true && value.profileId === profileId;
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
  const disabled = activity !== null && !isProfileActivity(activity);
  return `<div class="connection-mode" role="tablist" aria-label="连接方式">
    <button data-connection-mode="manual" role="tab" type="button" aria-selected="${manualSelected}" tabindex="${manualSelected ? '0' : '-1'}"${disabled ? ' disabled' : ''}>手工连接</button>
    ${savedAvailable ? `<button data-connection-mode="saved" role="tab" type="button" aria-selected="${!manualSelected}" tabindex="${manualSelected ? '-1' : '0'}"${disabled ? ' disabled' : ''}>已保存连接</button>` : ''}
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
  const navigationDisabled = disabled && !isProfileActivity(activity);
  const connectedToSelected = connection.connected && connection.profileId === selected.id;
  return `<section class="saved-connection" aria-busy="${activity !== null}">
    <label class="profile-select">已保存连接<select data-field="profile" name="profile"${navigationDisabled ? ' disabled' : ''}>
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
  for (const nextMode of ['manual', 'saved'] as const) {
    const tab = root?.querySelector<HTMLButtonElement>(`[data-connection-mode="${nextMode}"]`);
    tab?.addEventListener('click', () => switchMode(nextMode, true));
    tab?.addEventListener('keydown', (event) => handleModeKeydown(event));
  }
  root?.querySelector('[data-action="connect"]')?.addEventListener('click', () => void connect());
  root?.querySelector('[data-action="connect-saved"]')?.addEventListener('click', () => void connectSaved());
  root?.querySelector('[data-action="save-connection"]')?.addEventListener('click', () => void saveCurrentConnection());
  root?.querySelector('[data-action="show-password-update"]')?.addEventListener('click', () => {
    passwordUpdateVisible = true;
    replacementPassword = '';
    feedbackGeneration += 1;
    error = null;
    notice = null;
    render();
    queueMicrotask(() => root?.querySelector<HTMLInputElement>('[data-field="replacement-password"]')?.focus());
  });
  root?.querySelector('[data-action="cancel-password-update"]')?.addEventListener('click', () => {
    passwordUpdateVisible = false;
    replacementPassword = '';
    invalidField = null;
    feedbackGeneration += 1;
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
    if (profileId === saved.selectedProfileId) return;
    interactionGeneration += 1;
    saved.selectedProfileId = saved.profiles.some((profile) => profile.id === profileId) ? profileId : null;
    passwordUpdateVisible = false;
    replacementPassword = '';
    invalidField = null;
    feedbackGeneration += 1;
    error = null;
    notice = null;
    render();
  });
}

function switchMode(next: ConnectionMode, focusTab = false): void {
  if ((activity !== null && !isProfileActivity(activity))
    || (next === 'saved' && !saved.capability?.available)) return;
  if (mode !== next) {
    interactionGeneration += 1;
    mode = next;
  }
  replacementPassword = '';
  passwordUpdateVisible = false;
  invalidField = null;
  feedbackGeneration += 1;
  error = null;
  notice = null;
  render();
  if (focusTab) {
    root?.querySelector<HTMLButtonElement>(
      `[data-connection-mode="${next}"]`,
    )?.focus();
  }
}

function handleModeKeydown(event: KeyboardEvent): void {
  if (!saved.capability?.available) return;
  let next: ConnectionMode | null = null;
  if (event.key === 'Home') next = 'manual';
  if (event.key === 'End') next = 'saved';
  if (event.key === 'ArrowRight') next = mode === 'manual' ? 'saved' : 'manual';
  if (event.key === 'ArrowLeft') next = mode === 'saved' ? 'manual' : 'saved';
  if (!next) return;
  event.preventDefault();
  switchMode(next, true);
}

function clearFieldError(field: InvalidField | 'password' | 'database'): void {
  if (invalidField !== field) return;
  invalidField = null;
  feedbackGeneration += 1;
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

function selectReconciledProfile(
  preferredId: string | null,
  profiles: MysqlConnectionProfile[],
): string | null {
  if (profiles.some((profile) => profile.id === preferredId)) return preferredId;
  if (profiles.some((profile) => profile.id === connection.profileId)) return connection.profileId;
  return profiles[0]?.id ?? null;
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_LABEL_LENGTH = 80;
const MAX_HOST_LENGTH = 255;
const MAX_USER_LENGTH = 128;
const MAX_DATABASE_LENGTH = 64;
const MAX_TIMESTAMP_LENGTH = 64;

function sanitizeProfiles(value: unknown): SanitizedProfiles {
  if (!Array.isArray(value)) throw new Error('MySQL 返回了无效的连接资料列表。');
  const profiles: MysqlConnectionProfile[] = [];
  const profileIds = new Set<string>();
  let droppedInvalid = false;
  for (const candidate of value) {
    const profile = sanitizeProfile(candidate);
    if (!profile || profileIds.has(profile.id)) {
      droppedInvalid = true;
      continue;
    }
    profileIds.add(profile.id);
    profiles.push(profile);
  }
  return { profiles, droppedInvalid };
}

function sanitizeProfile(value: unknown): MysqlConnectionProfile | null {
  if (!isRecord(value)) return null;
  const id = sanitizeProfileId(value.id);
  const label = boundedTrimmedString(value.label, MAX_LABEL_LENGTH);
  const host = boundedTrimmedString(value.host, MAX_HOST_LENGTH);
  const user = boundedTrimmedString(value.user, MAX_USER_LENGTH);
  const database = value.database === null
    ? null
    : boundedTrimmedString(value.database, MAX_DATABASE_LENGTH);
  const createdAt = sanitizeTimestamp(value.createdAt);
  const updatedAt = sanitizeTimestamp(value.updatedAt);
  if (!id
    || !label
    || !host
    || !Number.isInteger(value.port)
    || Number(value.port) < 1
    || Number(value.port) > 65_535
    || !user
    || database === undefined
    || typeof value.tls !== 'boolean'
    || !createdAt
    || !updatedAt) return null;
  return {
    id,
    label,
    host,
    port: value.port as number,
    user,
    database,
    tls: value.tls,
    createdAt,
    updatedAt,
  };
}

function sanitizeProfileId(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function boundedTrimmedString(value: unknown, maxLength: number): string | null | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && [...normalized].length <= maxLength ? normalized : null;
}

function sanitizeTimestamp(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_TIMESTAMP_LENGTH
    && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function panelError(caught: unknown): PanelError {
  return caught instanceof Error
    ? {
      message: caught.message,
      ...('detail' in caught && typeof caught.detail === 'string' ? { detail: caught.detail } : {}),
    }
    : { message: String(caught) };
}

function sanitizeConnectionSnapshot(value: unknown): ConnectionSnapshot | null {
  if (!isRecord(value)) return null;
  const connected = value.connected;
  const endpoint = value.endpoint;
  const database = value.database;
  const mysqlVersion = value.mysqlVersion;
  const tls = value.tls;
  const rawProfileId = value.profileId;
  const profileId = rawProfileId === null ? null : sanitizeProfileId(rawProfileId);
  const connectionRevision = value.connectionRevision;
  const schemaRevision = value.schemaRevision;
  const dataRevision = value.dataRevision;
  if (typeof connected !== 'boolean'
    || !isNullableString(endpoint)
    || !isNullableString(database)
    || !isNullableString(mysqlVersion)
    || typeof tls !== 'boolean'
    || !(rawProfileId === null || profileId !== null)
    || !isRevision(connectionRevision)
    || !isRevision(schemaRevision)
    || !isRevision(dataRevision)) return null;
  return {
    connected,
    endpoint,
    database,
    mysqlVersion,
    tls,
    profileId,
    connectionRevision,
    schemaRevision,
    dataRevision,
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
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
