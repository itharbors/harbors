import {
  MYSQL_CORE,
  MYSQL_EXPLORER,
  unwrapMysqlResponse,
  type ConnectionSnapshot,
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

type PanelError = { message: string; detail?: string };
type ConnectionActivity = 'hydrate' | 'connect' | 'disconnect' | 'refresh' | null;

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
  connectionRevision: 0,
  schemaRevision: 0,
  dataRevision: 0,
};

let context: PanelContext | undefined;
let root: HTMLElement | null = null;
let connection: ConnectionSnapshot = { ...DISCONNECTED };
let form = defaultForm();
let activity: ConnectionActivity = null;
let error: PanelError | null = null;
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
    try {
      const next = await requestCore<ConnectionSnapshot>('getConnectionState');
      if (sequence !== requestSequence || !isConnectionSnapshot(next) || isStale(next)) return;
      activity = null;
      acceptConnection(next);
    } catch (caught) {
      if (sequence !== requestSequence) return;
      activity = null;
      error = panelError(caught);
      render();
    }
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
    activity = null;
    error = null;
  },

  methods: {
    onConnectionChanged(payload: unknown) {
      if (!isConnectionSnapshot(payload) || isStale(payload)) return;
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

function resetState(): void {
  connection = { ...DISCONNECTED };
  form = defaultForm();
  activity = null;
  error = null;
  activeAction = null;
  requestSequence += 1;
}

function acceptConnection(next: ConnectionSnapshot): void {
  requestSequence += 1;
  if (activity === 'hydrate') activity = null;
  connection = { ...next };
  error = null;
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
  const input = {
    host: form.host,
    port: Number(form.port),
    user: form.user,
    password: form.password,
    database: form.database.trim() || null,
    tls: form.tls,
  };
  await runAction('connect', async (token) => {
    const pendingConnection = requestCore<ConnectionSnapshot>('connect', input);
    form.password = '';
    render();
    const next = await pendingConnection;
    if (!isCurrentAction(token)) return;
    if (!isCurrentActionResult(token) || isStale(next)) return;
    acceptConnection(next);
  });
}

async function disconnect(): Promise<void> {
  await runAction('disconnect', async (token) => {
    const next = await requestCore<ConnectionSnapshot>('disconnect');
    if (!isCurrentActionResult(token) || isStale(next)) return;
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
  kind: Exclude<ConnectionActivity, null>,
  action: (token: ActionToken) => Promise<void>,
): Promise<void> {
  if (activity !== null) return;
  activity = kind;
  error = null;
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
    if (isCurrentActionResult(token)) error = panelError(caught);
  } finally {
    if (!isCurrentAction(token)) return;
    activeAction = null;
    activity = null;
    render();
  }
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
        <form class="connection-form" data-connection-form aria-busy="${activity !== null}">
          ${field('host', '主机', form.host, 'text', 'off', '', fieldsDisabled)}
          ${field('port', '端口', form.port, 'number', 'off', 'port-field', fieldsDisabled)}
          ${field('user', '用户名', form.user, 'text', 'username', '', fieldsDisabled)}
          ${field('password', '密码', form.password, 'password', 'current-password', '', fieldsDisabled)}
          ${field('database', '数据库（可选）', form.database, 'text', 'off', '', fieldsDisabled)}
          <label class="tls-field"><input data-field="tls" name="tls" type="checkbox"${form.tls ? ' checked' : ''}${fieldsDisabled ? ' disabled' : ''}><span>TLS</span></label>
          <div class="connection-actions">${renderActions()}</div>
        </form>
        <div class="connection-readout" data-connection="${connection.connected ? 'connected' : 'disconnected'}" role="status" aria-live="polite">
          ${renderConnectionReadout()}
          ${error ? `<span class="connection-error" role="alert" title="${escapeHtml(error.detail ?? error.message)}">${escapeHtml(error.message)}</span>` : ''}
        </div>
      </header>
    </main>`;

  root.querySelector('[data-action="connect"]')?.addEventListener('click', () => void connect());
  root.querySelector('[data-action="disconnect"]')?.addEventListener('click', () => void disconnect());
  root.querySelector('[data-action="refresh"]')?.addEventListener('click', () => void refreshObjects());
  root.querySelector<HTMLFormElement>('[data-connection-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!connection.connected && activity === null) void connect();
  });
  for (const name of ['host', 'port', 'user', 'password', 'database'] as const) {
    root.querySelector<HTMLInputElement>(`[data-field="${name}"]`)?.addEventListener('input', (event) => {
      form[name] = (event.currentTarget as HTMLInputElement).value;
    });
  }
  root.querySelector<HTMLInputElement>('[data-field="tls"]')?.addEventListener('change', (event) => {
    form.tls = (event.currentTarget as HTMLInputElement).checked;
  });
}

function renderActions(): string {
  const disabled = activity !== null ? ' disabled' : '';
  if (!connection.connected) {
    const pending = activity === 'connect';
    return `<button class="primary-action${pending ? ' is-busy' : ''}" data-action="connect" type="button"${disabled}>${pending ? `${spinner()}连接中…` : '连接'}</button>`;
  }
  const disconnecting = activity === 'disconnect';
  const refreshing = activity === 'refresh';
  return `<button class="${disconnecting ? 'is-busy' : ''}" data-action="disconnect" type="button"${disabled}>${disconnecting ? `${spinner()}断开中…` : '断开连接'}</button>
    <button class="icon-action${refreshing ? ' is-busy' : ''}" data-action="refresh" type="button" aria-label="${refreshing ? '刷新中' : '刷新数据库'}"${disabled}>${refreshing ? `${spinner()}<span>刷新中…</span>` : '↻'}</button>`;
}

function spinner(): string {
  return '<span class="activity-spinner" aria-hidden="true"></span>';
}

function renderConnectionReadout(): string {
  if (activity === 'hydrate') {
    return `<span class="connection-state">正在读取连接状态…</span>${spinner()}`;
  }
  if (!connection.connected) {
    const state = activity === 'connect' ? '正在连接…' : '未连接';
    return `<span class="connection-state">${state}</span><span>凭据仅保留在当前服务端会话中。</span>`;
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

function field(
  name: keyof Omit<ConnectionForm, 'tls'>,
  label: string,
  value: string,
  type: string,
  autocomplete: string,
  className = '',
  disabled = false,
): string {
  return `<label${className ? ` class="${className}"` : ''}>${label}<input data-field="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" autocomplete="${autocomplete}"${name === 'port' ? ' min="1" max="65535"' : ''}${name === 'database' ? ' placeholder="连接后选择…"' : ''}${disabled ? ' disabled' : ''}></label>`;
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
