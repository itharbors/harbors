import {
  MYSQL_CORE,
  MYSQL_EXPLORER,
  unwrapMysqlResponse,
  type ConnectionSnapshot,
  type SchemaSnapshot,
  type SelectionSnapshot,
} from '@itharbors/mysql-contracts';

type PanelContext = {
  message: { request(plugin: string, method: string, input?: unknown): Promise<unknown> };
};

type SchemaObject = { name: string; type: 'table' | 'view'; insertable: boolean };
type ConnectionForm = {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  tls: boolean;
};
type PanelError = { message: string; detail?: string };

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
let objects: SchemaObject[] = [];
let selection: SelectionSnapshot = { connectionRevision: 0, objectName: null };
let form: ConnectionForm = defaultForm();
let query = '';
let busy = false;
let status = '尚未连接数据库';
let error: PanelError | null = null;
let requestSequence = 0;

const definition = {
  async mount(ctx: PanelContext) {
    context = ctx;
    root = document.querySelector('#panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    resetState();
    render();
    await hydrate();
  },
  unmount() {
    requestSequence += 1;
    root?.replaceChildren();
    root = null;
    context = undefined;
    resetState();
  },
  methods: {
    async onConnectionChanged(payload: unknown) {
      if (isConnectionSnapshot(payload)) await acceptConnection(payload);
    },
    async onSchemaChanged(payload: unknown) {
      if (isRevisionEvent(payload) && payload.connectionRevision === connection.connectionRevision) {
        await refreshSchema();
      }
    },
  },
};

export default definition;

function defaultForm(): ConnectionForm {
  return { host: '127.0.0.1', port: '3306', user: 'root', password: '', database: '', tls: false };
}

function resetState(): void {
  connection = { ...DISCONNECTED };
  objects = [];
  selection = { connectionRevision: 0, objectName: null };
  form = defaultForm();
  query = '';
  busy = false;
  status = '尚未连接数据库';
  error = null;
  requestSequence += 1;
}

async function hydrate(): Promise<void> {
  const sequence = ++requestSequence;
  try {
    const [nextConnection, nextSelection] = await Promise.all([
      core<ConnectionSnapshot>('getConnectionState'),
      explorer<SelectionSnapshot>('getSelection'),
    ]);
    if (sequence !== requestSequence) return;
    connection = nextConnection;
    selection = nextSelection.connectionRevision === nextConnection.connectionRevision
      ? nextSelection
      : { connectionRevision: nextConnection.connectionRevision, objectName: null };
    if (connection.connected) await refreshSchema();
    else render();
  } catch (caught) {
    if (sequence === requestSequence) setError(caught);
  }
}

async function acceptConnection(next: ConnectionSnapshot): Promise<void> {
  connection = next;
  objects = [];
  selection = { connectionRevision: next.connectionRevision, objectName: null };
  query = '';
  error = null;
  status = next.connected ? `已连接 ${next.database ?? 'MySQL'}` : '连接已断开';
  render();
  if (next.connected) await refreshSchema();
}

async function refreshSchema(): Promise<void> {
  if (!connection.connected) {
    objects = [];
    render();
    return;
  }
  const sequence = ++requestSequence;
  try {
    const schema = await core<SchemaSnapshot<SchemaObject>>('getSchema');
    if (sequence !== requestSequence || schema.connectionRevision !== connection.connectionRevision) return;
    objects = schema.objects;
    const current = objects.some((object) => object.name === selection.objectName)
      ? selection.objectName
      : null;
    const preferred = current
      ?? objects.find((object) => object.type === 'table')?.name
      ?? objects[0]?.name
      ?? null;
    if (preferred !== selection.objectName || selection.connectionRevision !== connection.connectionRevision) {
      selection = await explorer<SelectionSnapshot>('selectObject', {
        connectionRevision: connection.connectionRevision,
        objectName: preferred,
      });
    }
    status = objects.length === 0 ? '数据库中没有对象' : `已载入 ${objects.length} 个对象`;
    error = null;
  } catch (caught) {
    if (sequence !== requestSequence) return;
    setError(caught, false);
  }
  render();
}

async function connect(): Promise<void> {
  await runAction(async () => {
    const port = Number(form.port);
    const next = await core<ConnectionSnapshot>('connect', {
      host: form.host,
      port,
      user: form.user,
      password: form.password,
      database: form.database,
      tls: form.tls,
    });
    form.password = '';
    await acceptConnection(next);
  });
}

async function disconnect(): Promise<void> {
  await runAction(async () => acceptConnection(await core<ConnectionSnapshot>('disconnect')));
}

async function chooseObject(objectName: string): Promise<void> {
  await runAction(async () => {
    selection = await explorer<SelectionSnapshot>('selectObject', {
      connectionRevision: connection.connectionRevision,
      objectName,
    });
    status = `已选择 ${objectName}`;
  });
}

async function runAction(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  error = null;
  render();
  try {
    await action();
  } catch (caught) {
    setError(caught, false);
  } finally {
    busy = false;
    render();
  }
}

async function core<T>(method: string, input?: unknown): Promise<T> {
  if (!context) throw new Error('MySQL Explorer 尚未挂载。');
  return unwrapMysqlResponse<T>(await context.message.request(MYSQL_CORE, method, input));
}

async function explorer<T>(method: string, input?: unknown): Promise<T> {
  if (!context) throw new Error('MySQL Explorer 尚未挂载。');
  return context.message.request(MYSQL_EXPLORER, method, input) as Promise<T>;
}

function render(): void {
  if (!root) return;
  root.innerHTML = `
    <main class="explorer-shell">
      <header><div class="brand"><strong>MY</strong><span>MySQL<br><small>资源管理器</small></span></div></header>
      <form class="connection-form" data-form="connection">
        ${field('host', '主机', form.host)}
        ${field('port', '端口', form.port, 'number')}
        ${field('user', '用户', form.user)}
        ${field('password', '密码', form.password, 'password')}
        ${field('database', '数据库', form.database)}
        <label class="tls"><input data-field="tls" type="checkbox"${form.tls ? ' checked' : ''}> TLS</label>
        <div class="actions"><button class="primary" data-action="connect" type="submit">连接</button><button data-action="refresh" type="button"${connection.connected ? '' : ' disabled'}>刷新</button><button class="danger" data-action="disconnect" type="button"${connection.connected ? '' : ' disabled'}>断开</button></div>
      </form>
      <section class="connection-summary" data-connected="${connection.connected}">${renderConnection()}</section>
      ${error ? `<div class="error" role="alert">${escapeHtml(error.message)}</div>` : ''}
      <section class="objects" aria-label="数据库对象">${renderObjects()}</section>
      <footer role="status" aria-live="polite">${escapeHtml(status)}</footer>
    </main>`;
  bind();
}

function field(name: keyof Omit<ConnectionForm, 'tls'>, label: string, value: string, type = 'text'): string {
  return `<label><span>${label}</span><input data-field="${name}" type="${type}" value="${escapeHtml(value)}" autocomplete="${name === 'password' ? 'current-password' : 'off'}"></label>`;
}

function renderConnection(): string {
  if (!connection.connected) return '<span class="signal"></span><span>未连接</span>';
  return `<span class="signal"></span><strong data-current-endpoint>${escapeHtml(connection.endpoint ?? '')}</strong><span>${escapeHtml(connection.database ?? '')}</span><small>MySQL ${escapeHtml(connection.mysqlVersion ?? '未知版本')}${connection.tls ? ' · TLS' : ''}</small>`;
}

function renderObjects(): string {
  if (!connection.connected) return '<div class="empty">连接 MySQL 后显示数据表和视图。</div>';
  if (objects.length === 0) return '<div class="empty">当前数据库中没有可浏览对象。</div>';
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = objects.filter((object) => object.name.toLocaleLowerCase().includes(normalized));
  const groups = (['table', 'view'] as const).map((type) => {
    const items = filtered.filter((object) => object.type === type);
    if (items.length === 0) return '';
    const label = type === 'table' ? '数据表' : '视图';
    return `<section class="object-group"><h2>${label} · ${items.length}</h2>${items.map((object) => `<button type="button" class="object-item" data-object-name="${escapeHtml(object.name)}" aria-pressed="${object.name === selection.objectName}"><span aria-hidden="true">${type === 'table' ? '▦' : '◇'}</span><span>${escapeHtml(object.name)}</span><small>${label}</small></button>`).join('')}</section>`;
  }).join('');
  return `<input class="search" type="search" data-field="object-search" value="${escapeHtml(query)}" placeholder="搜索对象" aria-label="搜索数据库对象">${groups || '<div class="empty">没有匹配对象。</div>'}`;
}

function bind(): void {
  root?.querySelector<HTMLFormElement>('[data-form="connection"]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void connect();
  });
  root?.querySelector('[data-action="refresh"]')?.addEventListener('click', () => void refreshSchema());
  root?.querySelector('[data-action="disconnect"]')?.addEventListener('click', () => void disconnect());
  for (const name of ['host', 'port', 'user', 'password', 'database'] as const) {
    root?.querySelector<HTMLInputElement>(`[data-field="${name}"]`)?.addEventListener('input', (event) => {
      form[name] = (event.currentTarget as HTMLInputElement).value;
    });
  }
  root?.querySelector<HTMLInputElement>('[data-field="tls"]')?.addEventListener('change', (event) => {
    form.tls = (event.currentTarget as HTMLInputElement).checked;
  });
  root?.querySelector<HTMLInputElement>('[data-field="object-search"]')?.addEventListener('input', (event) => {
    query = (event.currentTarget as HTMLInputElement).value;
    render();
  });
  for (const button of Array.from(root?.querySelectorAll<HTMLButtonElement>('[data-object-name]') ?? [])) {
    button.addEventListener('click', () => void chooseObject(button.dataset.objectName!));
  }
  if (busy) {
    for (const button of Array.from(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])) button.disabled = true;
  }
}

function setError(caught: unknown, shouldRender = true): void {
  error = caught instanceof Error
    ? { message: caught.message, ...('detail' in caught && typeof caught.detail === 'string' ? { detail: caught.detail } : {}) }
    : { message: String(caught) };
  status = '操作失败';
  if (shouldRender) render();
}

function isConnectionSnapshot(value: unknown): value is ConnectionSnapshot {
  return isRevisionEvent(value)
    && typeof value.connected === 'boolean'
    && (value.endpoint === null || typeof value.endpoint === 'string')
    && (value.database === null || typeof value.database === 'string');
}

function isRevisionEvent(value: unknown): value is Record<string, unknown> & { connectionRevision: number } {
  return typeof value === 'object' && value !== null
    && Number.isInteger((value as Record<string, unknown>).connectionRevision);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[character] ?? character);
}
