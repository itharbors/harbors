import {
  SQLITE_CORE,
  SQLITE_EXPLORER,
  unwrapSqliteResponse,
  type ConnectionSnapshot,
  type SchemaSnapshot,
  type SelectionSnapshot,
} from '@itharbors/sqlite-contracts';

type PanelContext = {
  message: {
    request(plugin: string, method: string, input?: unknown): Promise<unknown>;
  };
};

type SchemaObject = {
  name: string;
  kind: 'table' | 'view' | 'virtual' | 'shadow';
  type: 'table' | 'view';
  writable: boolean;
  readOnlyReason?: string | null;
};

type FileEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  sqliteCandidate: boolean;
};

type FileDialog = {
  mode: 'open' | 'create';
  currentPath: string;
  parentPath: string | null;
  entries: FileEntry[];
  selectedPath: string | null;
  recentPaths: string[];
  showAll: boolean;
  fileName: string;
};

type PanelError = { message: string; detail?: string };

const DISCONNECTED: ConnectionSnapshot = {
  connected: false,
  path: null,
  fileName: null,
  mode: null,
  sqliteVersion: null,
  connectionRevision: 0,
  schemaRevision: 0,
  dataRevision: 0,
};

let context: PanelContext | undefined;
let root: HTMLElement | null = null;
let connection: ConnectionSnapshot = { ...DISCONNECTED };
let objects: SchemaObject[] = [];
let selection: SelectionSnapshot = { connectionRevision: 0, objectName: null };
let query = '';
let busy = false;
let status = '尚未连接数据库';
let error: PanelError | null = null;
let writeDialog = false;
let fileDialog: FileDialog | null = null;
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
      if (!isConnectionSnapshot(payload)) return;
      await acceptConnection(payload);
    },
    async onSchemaChanged(payload: unknown) {
      if (!isRevisionEvent(payload) || payload.connectionRevision !== connection.connectionRevision) return;
      await refreshSchema();
    },
  },
};

export default definition;

function resetState(): void {
  connection = { ...DISCONNECTED };
  objects = [];
  selection = { connectionRevision: 0, objectName: null };
  query = '';
  busy = false;
  status = '尚未连接数据库';
  error = null;
  writeDialog = false;
  fileDialog = null;
  requestSequence += 1;
}

async function hydrate(): Promise<void> {
  const sequence = ++requestSequence;
  try {
    const [nextConnection, nextSelection] = await Promise.all([
      requestCore<ConnectionSnapshot>('getConnectionState'),
      requestExplorer<SelectionSnapshot>('getSelection'),
    ]);
    if (sequence !== requestSequence) return;
    connection = nextConnection;
    selection = nextSelection.connectionRevision === nextConnection.connectionRevision
      ? nextSelection
      : { connectionRevision: nextConnection.connectionRevision, objectName: null };
    if (connection.connected) await refreshSchema();
    else render();
  } catch (caught) {
    if (sequence !== requestSequence) return;
    setError(caught);
  }
}

async function acceptConnection(next: ConnectionSnapshot): Promise<void> {
  connection = next;
  objects = [];
  selection = { connectionRevision: next.connectionRevision, objectName: null };
  query = '';
  error = null;
  status = next.connected ? `已连接 ${next.fileName ?? 'SQLite'}` : '数据库已关闭';
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
    const schema = await requestCore<SchemaSnapshot<SchemaObject>>('getSchema');
    if (sequence !== requestSequence || schema.connectionRevision !== connection.connectionRevision) return;
    objects = schema.objects;
    const existing = objects.some((object) => object.name === selection.objectName)
      ? selection.objectName
      : null;
    const preferred = existing
      ?? objects.find((object) => object.kind === 'table')?.name
      ?? objects[0]?.name
      ?? null;
    if (preferred !== selection.objectName || selection.connectionRevision !== connection.connectionRevision) {
      selection = await requestExplorer<SelectionSnapshot>('selectObject', {
        connectionRevision: connection.connectionRevision,
        objectName: preferred,
      });
    }
    status = objects.length === 0 ? '数据库中还没有对象' : `已载入 ${objects.length} 个对象`;
    error = null;
  } catch (caught) {
    if (sequence !== requestSequence) return;
    setError(caught, false);
  }
  render();
}

async function chooseObject(objectName: string): Promise<void> {
  await runAction(async () => {
    selection = await requestExplorer<SelectionSnapshot>('selectObject', {
      connectionRevision: connection.connectionRevision,
      objectName,
    });
    status = `已选择 ${objectName}`;
  });
}

async function openFileBrowser(mode: 'open' | 'create'): Promise<void> {
  await runAction(async () => {
    const [listing, recentPaths] = await Promise.all([
      requestCore<{
        currentPath: string;
        parentPath: string | null;
        entries: FileEntry[];
      }>('listDirectory', { path: '.', showAll: false }),
      requestCore<string[]>('getRecentDatabases'),
    ]);
    fileDialog = {
      mode,
      ...listing,
      selectedPath: null,
      recentPaths,
      showAll: false,
      fileName: '',
    };
  });
}

async function browseDirectory(path: string): Promise<void> {
  if (!fileDialog) return;
  await runAction(async () => {
    const listing = await requestCore<{
      currentPath: string;
      parentPath: string | null;
      entries: FileEntry[];
    }>('listDirectory', { path, showAll: fileDialog!.showAll });
    fileDialog = { ...fileDialog!, ...listing, selectedPath: null };
  });
}

async function confirmFileDialog(): Promise<void> {
  if (!fileDialog) return;
  const current = fileDialog;
  const target = current.mode === 'open'
    ? current.selectedPath
    : joinDisplayPath(current.currentPath, current.fileName.trim());
  if (!target) {
    error = { message: current.mode === 'open' ? '请选择 SQLite 数据库文件。' : '请输入数据库文件名。' };
    render();
    return;
  }
  await runAction(async () => {
    const next = await requestCore<ConnectionSnapshot>('openDatabase', {
      path: target,
      create: current.mode === 'create',
    });
    fileDialog = null;
    await acceptConnection(next);
  });
}

async function confirmWriteMode(): Promise<void> {
  await runAction(async () => {
    const next = await requestCore<ConnectionSnapshot>('setConnectionMode', { mode: 'readwrite' });
    writeDialog = false;
    await acceptConnection(next);
  });
}

async function closeDatabase(): Promise<void> {
  await runAction(async () => {
    const next = await requestCore<ConnectionSnapshot>('closeDatabase');
    await acceptConnection(next);
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

async function requestCore<T>(method: string, input?: unknown): Promise<T> {
  if (!context) throw new Error('SQLite Explorer 尚未挂载。');
  return unwrapSqliteResponse<T>(await context.message.request(SQLITE_CORE, method, input));
}

async function requestExplorer<T>(method: string, input?: unknown): Promise<T> {
  if (!context) throw new Error('SQLite Explorer 尚未挂载。');
  return context.message.request(SQLITE_EXPLORER, method, input) as Promise<T>;
}

function render(): void {
  if (!root) return;
  root.innerHTML = `
    <main class="explorer-shell">
      <header class="explorer-header">
        <div class="brand"><h1>SQLite</h1><small>数据库资源管理器</small></div>
        <div class="connection-actions" aria-label="数据库连接操作">
          <button type="button" class="primary" data-action="browse-open">打开数据库</button>
          <button type="button" data-action="browse-create">新建数据库</button>
          <button type="button" data-action="refresh"${connection.connected ? '' : ' disabled'}>刷新对象</button>
          <button type="button" class="danger" data-action="close"${connection.connected ? '' : ' disabled'}>关闭连接</button>
        </div>
        <div class="connection-card" data-connected="${connection.connected}">${renderConnection()}</div>
      </header>
      ${error ? renderError(error) : ''}
      <section class="object-section" aria-label="数据库对象">
        ${renderObjectList()}
      </section>
      <footer class="status" role="status" aria-live="polite">${escapeHtml(status)}</footer>
      ${writeDialog ? renderWriteDialog() : ''}
      ${fileDialog ? renderFileDialog(fileDialog) : ''}
    </main>
  `;

  bindClick('browse-open', () => openFileBrowser('open'));
  bindClick('browse-create', () => openFileBrowser('create'));
  bindClick('refresh', refreshSchema);
  bindClick('close', closeDatabase);
  bindClick('unlock-writes', () => { writeDialog = true; render(); });
  bindClick('cancel-write', () => { writeDialog = false; render(); });
  bindClick('confirm-write', confirmWriteMode);
  bindClick('cancel-file', () => { fileDialog = null; render(); });
  bindClick('confirm-open', confirmFileDialog);
  bindClick('confirm-create', confirmFileDialog);

  root.querySelector<HTMLInputElement>('[data-field="object-search"]')?.addEventListener('input', (event) => {
    query = (event.currentTarget as HTMLInputElement).value;
    render();
    queueMicrotask(() => root?.querySelector<HTMLInputElement>('[data-field="object-search"]')?.focus());
  });
  root.querySelector<HTMLInputElement>('[data-field="create-name"]')?.addEventListener('input', (event) => {
    if (fileDialog) fileDialog.fileName = (event.currentTarget as HTMLInputElement).value;
  });
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-object-name]'))) {
    button.addEventListener('click', () => { void chooseObject(button.dataset.objectName!); });
  }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-file-path]'))) {
    button.addEventListener('click', () => {
      if (!fileDialog) return;
      if (button.dataset.kind === 'directory') void browseDirectory(button.dataset.filePath!);
      else { fileDialog.selectedPath = button.dataset.filePath!; render(); }
    });
  }
  root.querySelector<HTMLButtonElement>('[data-action="parent-directory"]')?.addEventListener('click', () => {
    if (fileDialog?.parentPath) void browseDirectory(fileDialog.parentPath);
  });
}

function renderConnection(): string {
  if (!connection.connected) {
    return '<div><span class="signal"></span>未连接</div><span>打开已有数据库或显式新建数据库</span>';
  }
  return `
    <div class="mode-row"><span><span class="signal"></span>${connection.mode === 'readonly' ? '只读连接' : '可写连接'}</span>
      ${connection.mode === 'readonly' ? '<button type="button" data-action="unlock-writes">启用写入</button>' : ''}
    </div>
    <code data-current-path title="${escapeHtml(connection.path ?? '')}">${escapeHtml(connection.path ?? '')}</code>
    <span>SQLite ${escapeHtml(connection.sqliteVersion ?? '未知版本')}</span>
  `;
}

function renderObjectList(): string {
  if (!connection.connected) return '<div class="empty">连接数据库后，这里会显示表、视图和系统对象。</div>';
  if (objects.length === 0) return '<div class="empty">数据库中还没有可浏览的对象。</div>';
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = objects.filter((object) => object.name.toLocaleLowerCase().includes(normalizedQuery));
  const labels: Record<SchemaObject['kind'], string> = {
    table: '普通表',
    view: '视图',
    virtual: '虚拟表',
    shadow: '系统对象',
  };
  const groups = (['table', 'view', 'virtual', 'shadow'] as const).map((kind) => {
    const group = filtered.filter((object) => object.kind === kind);
    if (group.length === 0) return '';
    return `<section class="object-group" data-object-kind="${kind}">
      <h2>${labels[kind]} · ${group.length}</h2>
      ${group.map((object) => `
        <button type="button" class="object-item" data-object-name="${escapeHtml(object.name)}" aria-pressed="${object.name === selection.objectName}" title="${escapeHtml(object.readOnlyReason ?? '')}">
          <span aria-hidden="true">${kind === 'table' ? '▦' : kind === 'view' ? '◇' : kind === 'virtual' ? '◈' : '·'}</span>
          <span>${escapeHtml(object.name)}</span><small>${labels[kind]}</small>
        </button>`).join('')}
    </section>`;
  }).join('');
  return `<div class="object-toolbar"><input type="search" data-field="object-search" aria-label="搜索数据库对象" placeholder="搜索对象" value="${escapeHtml(query)}"></div>${groups || '<div class="empty">没有匹配的对象。</div>'}`;
}

function renderError(panelError: PanelError): string {
  return `<div class="error" role="alert">${escapeHtml(panelError.message)}${panelError.detail ? `<details><summary>查看详情</summary><pre>${escapeHtml(panelError.detail)}</pre></details>` : ''}</div>`;
}

function renderWriteDialog(): string {
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="write-dialog-title">
    <h2 id="write-dialog-title">启用写入</h2>
    <p>写入模式允许新增、修改、删除记录以及执行写 SQL。请确认你信任当前数据库文件。</p>
    <div class="modal-actions"><button type="button" data-action="cancel-write">取消</button><button type="button" class="primary" data-action="confirm-write">确认启用写入</button></div>
  </section></div>`;
}

function renderFileDialog(dialog: FileDialog): string {
  const title = dialog.mode === 'open' ? '打开 SQLite 数据库' : '新建 SQLite 数据库';
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="file-dialog-title">
    <h2 id="file-dialog-title">${title}</h2>
    <div class="path-row"><button type="button" data-action="parent-directory"${dialog.parentPath ? '' : ' disabled'} aria-label="上级文件夹">↑</button><input value="${escapeHtml(dialog.currentPath)}" aria-label="当前文件夹" readonly></div>
    <div class="file-list">${dialog.entries.map((entry) => `<button type="button" class="file-entry" data-file-path="${escapeHtml(entry.path)}" data-kind="${entry.kind}" aria-pressed="${entry.path === dialog.selectedPath}"><span aria-hidden="true">${entry.kind === 'directory' ? '▸' : '▤'}</span><span>${escapeHtml(entry.name)}</span></button>`).join('') || '<div class="empty">这个文件夹中没有可选项目。</div>'}</div>
    ${dialog.mode === 'create' ? `<div class="path-row"><input data-field="create-name" aria-label="数据库文件名" placeholder="例如 project.sqlite" value="${escapeHtml(dialog.fileName)}"></div>` : ''}
    <div class="modal-actions"><button type="button" data-action="cancel-file">取消</button><button type="button" class="primary" data-action="${dialog.mode === 'open' ? 'confirm-open' : 'confirm-create'}">${dialog.mode === 'open' ? '打开' : '新建'}</button></div>
  </section></div>`;
}

function bindClick(action: string, handler: () => void | Promise<void>): void {
  const button = root?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  button?.addEventListener('click', () => { void handler(); });
  if (button && busy) button.disabled = true;
}

function setError(caught: unknown, shouldRender = true): void {
  error = caught instanceof Error
    ? { message: caught.message, ...('detail' in caught && typeof caught.detail === 'string' ? { detail: caught.detail } : {}) }
    : { message: String(caught) };
  status = '操作失败';
  if (shouldRender) render();
}

function joinDisplayPath(directory: string, name: string): string | null {
  if (!name) return null;
  return `${directory.replace(/[\\/]$/, '')}/${name}`;
}

function isConnectionSnapshot(value: unknown): value is ConnectionSnapshot {
  return isRevisionEvent(value)
    && typeof value.connected === 'boolean'
    && (value.path === null || typeof value.path === 'string')
    && (value.mode === null || value.mode === 'readonly' || value.mode === 'readwrite');
}

function isRevisionEvent(value: unknown): value is Record<string, unknown> & { connectionRevision: number } {
  return typeof value === 'object' && value !== null && Number.isInteger((value as Record<string, unknown>).connectionRevision);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[character] ?? character);
}
