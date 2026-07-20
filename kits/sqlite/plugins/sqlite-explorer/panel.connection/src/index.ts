import {
  SQLITE_CORE,
  SQLITE_EXPLORER,
  unwrapSqliteResponse,
  type ConnectionSnapshot,
} from '@itharbors/sqlite-contracts';

type PanelContext = {
  message: {
    request(plugin: string, method: string, input?: unknown): Promise<unknown>;
  };
  panel: {
    setModalOpen(open: boolean): void;
  };
};

type FileEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  sqliteCandidate: boolean;
  size?: number | null;
  modifiedAt?: string | null;
};

type FileDialog = {
  mode: 'open' | 'create';
  currentPath: string;
  parentPath: string | null;
  entries: FileEntry[];
  selectedPath: string | null;
  fileName: string;
  recentPaths: string[];
  showAll: boolean;
  manualPath: string;
  openerAction: string;
};

type PanelError = { message: string; detail?: string };

type ActionToken = {
  mountGeneration: number;
  actionSequence: number;
  requestSequence: number;
  focusAction: string | null;
};

const DISCONNECTED: ConnectionSnapshot = {
  connected: false,
  path: null,
  fileName: null,
  mode: null,
  sqliteVersion: null,
  foreignKeys: null,
  busyTimeout: null,
  connectionRevision: 0,
  schemaRevision: 0,
  dataRevision: 0,
};

let context: PanelContext | undefined;
let root: HTMLElement | null = null;
let connection: ConnectionSnapshot = { ...DISCONNECTED };
let busy = false;
let error: PanelError | null = null;
let fileDialog: FileDialog | null = null;
let writeDialog = false;
let writeDialogOpener = 'unlock-writes';
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
    window.addEventListener('keydown', handleKeydown);
    render();
    const sequence = ++requestSequence;
    try {
      const next = await requestCore<ConnectionSnapshot>('getConnectionState');
      if (sequence !== requestSequence || !isConnectionSnapshot(next)) return;
      acceptConnection(next, false);
    } catch (caught) {
      if (sequence !== requestSequence) return;
      error = panelError(caught);
      render();
    }
  },

  unmount() {
    mountGeneration += 1;
    requestSequence += 1;
    activeAction = null;
    window.removeEventListener('keydown', handleKeydown);
    setModalOpen(false);
    root?.replaceChildren();
    root = null;
    context = undefined;
    connection = { ...DISCONNECTED };
    busy = false;
    error = null;
    fileDialog = null;
    writeDialog = false;
  },

  methods: {
    onConnectionChanged(payload: unknown) {
      if (
        !isConnectionSnapshot(payload)
        || payload.connectionRevision < connection.connectionRevision
      ) return;
      requestSequence += 1;
      acceptConnection(payload);
    },
  },
};

export default definition;

function resetState(): void {
  connection = { ...DISCONNECTED };
  busy = false;
  error = null;
  fileDialog = null;
  writeDialog = false;
  activeAction = null;
  requestSequence += 1;
  setModalOpen(false);
}

function acceptConnection(next: ConnectionSnapshot, resetDialogs = true): void {
  requestSequence += 1;
  connection = { ...next };
  error = null;
  if (resetDialogs) {
    fileDialog = null;
    writeDialog = false;
    setModalOpen(false);
  }
  render();
}

async function openFileBrowser(mode: FileDialog['mode'], openerAction: string): Promise<void> {
  await runAction(async (token) => {
    const recentPaths = await requestCore<string[]>('getRecentDatabases');
    if (!isCurrentActionResult(token)) return;
    const initialPath = recentPaths[0]?.replace(/[\\/][^\\/]+$/, '') || '.';
    const listing = await listDirectory(initialPath, false);
    if (!isCurrentActionResult(token)) return;
    fileDialog = {
      mode,
      ...listing,
      selectedPath: mode === 'open' ? recentPaths[0] ?? null : null,
      fileName: 'database.sqlite',
      recentPaths,
      showAll: false,
      manualPath: '',
      openerAction,
    };
    writeDialog = false;
    setModalOpen(true);
  });
}

async function browseDirectory(path: string): Promise<void> {
  if (!fileDialog) return;
  const currentDialog = fileDialog;
  await runAction(async (token) => {
    const listing = await listDirectory(path, currentDialog.showAll);
    if (!isCurrentActionResult(token) || fileDialog !== currentDialog) return;
    fileDialog = { ...currentDialog, ...listing, selectedPath: null };
  });
}

async function confirmFileDialog(): Promise<void> {
  const dialog = fileDialog;
  if (!dialog) return;
  const target = dialog.manualPath.trim() || (dialog.mode === 'open'
    ? dialog.selectedPath
    : joinDisplayPath(dialog.currentPath, dialog.fileName.trim()));
  if (!target) {
    error = {
      message: dialog.mode === 'open'
        ? '请选择 SQLite 数据库文件或手动输入路径。'
        : '请输入数据库文件名。',
    };
    render();
    return;
  }
  await runAction(async (token) => {
    const next = await requestCore<ConnectionSnapshot>('openDatabase', {
      path: target,
      create: dialog.mode === 'create',
    });
    if (!isCurrentActionResult(token) || fileDialog !== dialog) return;
    token.focusAction = dialog.openerAction;
    acceptConnection(next);
  });
}

async function confirmWriteMode(): Promise<void> {
  await runAction(async (token) => {
    const next = await requestCore<ConnectionSnapshot>('setConnectionMode', {
      mode: 'readwrite',
    });
    if (!isCurrentActionResult(token) || !writeDialog) return;
    token.focusAction = 'close';
    acceptConnection(next);
  });
}

async function refreshObjects(): Promise<void> {
  await runAction(async (token) => {
    await requestExplorer('refreshObjects');
    if (!isCurrentActionResult(token)) return;
  });
}

async function closeDatabase(): Promise<void> {
  await runAction(async (token) => {
    const next = await requestCore<ConnectionSnapshot>('closeDatabase');
    if (!isCurrentActionResult(token)) return;
    acceptConnection(next);
  });
}

async function runAction(action: (token: ActionToken) => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  error = null;
  const token: ActionToken = {
    mountGeneration,
    actionSequence: ++actionSequence,
    requestSequence: ++requestSequence,
    focusAction: null,
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
    busy = false;
    render();
    if (token.focusAction) queueMicrotask(() => focusAction(token.focusAction!));
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

async function listDirectory(path: string, showAll: boolean): Promise<{
  currentPath: string;
  parentPath: string | null;
  entries: FileEntry[];
}> {
  return requestCore('listDirectory', { path, showAll });
}

async function requestCore<T>(method: string, input?: unknown): Promise<T> {
  if (!context) throw new Error('SQLite 连接栏尚未挂载。');
  return unwrapSqliteResponse<T>(await context.message.request(SQLITE_CORE, method, input));
}

async function requestExplorer(method: string, input?: unknown): Promise<unknown> {
  if (!context) throw new Error('SQLite 连接栏尚未挂载。');
  return context.message.request(SQLITE_EXPLORER, method, input);
}

function render(): void {
  if (!root) return;
  const modalOpen = fileDialog !== null || writeDialog;
  root.innerHTML = `
    <main class="connection-shell">
      <header class="connection-bar"${modalOpen ? ' inert aria-hidden="true"' : ''}>
        <div class="brand-block" aria-label="SQLite 工作台">
          <span class="database-mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <span><strong>SQLite</strong><small>工作台</small></span>
        </div>
        <div class="connection-form" aria-label="数据库连接操作">
          <button type="button" data-action="browse-open" class="primary">打开数据库</button>
          <button type="button" data-action="browse-create">新建数据库</button>
          <button type="button" data-action="refresh"${connection.connected ? '' : ' disabled'}>刷新</button>
          <button type="button" data-action="close"${connection.connected ? '' : ' disabled'}>关闭</button>
        </div>
        <div class="connection-state" data-connection="${connection.connected ? 'connected' : 'disconnected'}">
          ${renderConnectionState()}
        </div>
      </header>
      ${fileDialog ? renderFileDialog(fileDialog) : ''}
      ${writeDialog ? renderWriteDialog() : ''}
    </main>
  `;

  bindAction('browse-open', () => openFileBrowser('open', 'browse-open'));
  bindAction('browse-create', () => openFileBrowser('create', 'browse-create'));
  bindAction('refresh', refreshObjects);
  bindAction('close', closeDatabase);
  bindAction('unlock-writes', () => {
    writeDialog = true;
    writeDialogOpener = 'unlock-writes';
    error = null;
    setModalOpen(true);
    render();
  });
  bindAction('cancel-write-mode', () => closeDialogs(writeDialogOpener));
  bindAction('confirm-write-mode', confirmWriteMode);
  bindAction('cancel-file', () => closeDialogs(fileDialog?.openerAction));
  bindAction('confirm-file', confirmFileDialog);
  bindAction('parent-directory', () => {
    if (fileDialog?.parentPath) return browseDirectory(fileDialog.parentPath);
  });

  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-file-path]'))) {
    button.addEventListener('click', () => {
      if (!fileDialog) return;
      if (button.dataset.kind === 'directory') void browseDirectory(button.dataset.filePath!);
      else {
        fileDialog.selectedPath = button.dataset.filePath!;
        render();
      }
    });
  }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-recent-path]'))) {
    button.addEventListener('click', () => {
      if (!fileDialog) return;
      fileDialog.selectedPath = button.dataset.recentPath!;
      fileDialog.manualPath = button.dataset.recentPath!;
      render();
    });
  }
  root.querySelector<HTMLInputElement>('[data-field="show-all-files"]')?.addEventListener('change', (event) => {
    if (!fileDialog) return;
    fileDialog.showAll = (event.currentTarget as HTMLInputElement).checked;
    void browseDirectory(fileDialog.currentPath);
  });
  root.querySelector<HTMLInputElement>('[data-field="manual-path"]')?.addEventListener('input', (event) => {
    if (!fileDialog) return;
    fileDialog.manualPath = (event.currentTarget as HTMLInputElement).value;
    syncConfirmFileDisabled();
  });
  root.querySelector<HTMLInputElement>('[data-field="create-name"]')?.addEventListener('input', (event) => {
    if (!fileDialog) return;
    fileDialog.fileName = (event.currentTarget as HTMLInputElement).value;
    syncConfirmFileDisabled();
  });

  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('button'))) {
    if (busy) button.disabled = true;
  }
  if (modalOpen) queueMicrotask(focusModal);
}

function renderConnectionState(): string {
  if (error && !fileDialog && !writeDialog) {
    return `<div class="connection-error" role="alert">${escapeHtml(error.message)}</div>`;
  }
  if (!connection.connected) {
    return '<span class="signal"></span><span>尚未连接</span>';
  }
  const summary = `${connection.mode === 'readonly' ? '只读' : '可写'} · ${fileName(connection.path ?? 'SQLite')}`;
  return `<span class="signal"></span>
    <span class="connection-summary">${escapeHtml(summary)}</span>
    <code data-current-path title="${escapeHtml(connection.path ?? '')}">${escapeHtml(connection.path ?? '')}</code>
    ${connection.mode === 'readonly' ? '<button type="button" data-action="unlock-writes">启用写入</button>' : ''}`;
}

function renderFileDialog(dialog: FileDialog): string {
  const title = dialog.mode === 'open' ? '打开 SQLite 数据库' : '新建 SQLite 数据库';
  const recent = dialog.mode === 'open' && dialog.recentPaths.length > 0
    ? `<details class="recent-paths"><summary>最近使用 · ${dialog.recentPaths.length}</summary>${dialog.recentPaths.map((path) => `<button type="button" data-recent-path="${escapeHtml(path)}">${escapeHtml(path)}</button>`).join('')}</details>`
    : '';
  return `<div class="modal-backdrop">
    <section class="modal" data-file-dialog role="dialog" aria-modal="true" aria-labelledby="file-dialog-title" tabindex="-1">
      <h2 id="file-dialog-title">${title}</h2>
      <code>${escapeHtml(dialog.currentPath)}</code>
      ${recent}
      <label class="show-all"><input type="checkbox" data-field="show-all-files"${dialog.showAll ? ' checked' : ''}> 显示全部文件</label>
      <div class="file-list">
        ${dialog.parentPath ? '<button type="button" data-action="parent-directory">← 上一级</button>' : ''}
        ${dialog.entries.map((entry) => `<button type="button" data-file-path="${escapeHtml(entry.path)}" data-kind="${entry.kind}" class="${entry.path === dialog.selectedPath ? 'selected' : ''}">${entry.kind === 'directory' ? '▸' : '◫'} ${escapeHtml(entry.name)}</button>`).join('') || '<div class="empty-state">这个文件夹中没有可选项目。</div>'}
      </div>
      ${dialog.mode === 'create' ? `<input data-field="create-name" aria-label="数据库文件名" value="${escapeHtml(dialog.fileName)}">` : ''}
      <details class="manual-path"><summary>手动输入路径</summary><input data-field="manual-path" aria-label="手动数据库路径" placeholder="${dialog.mode === 'open' ? '/path/to/database.sqlite' : '/path/to/new-database.sqlite'}" value="${escapeHtml(dialog.manualPath)}"></details>
      ${error ? renderDialogError(error) : ''}
      <footer>
        <button type="button" data-action="cancel-file">取消</button>
        <button type="button" class="primary" data-action="confirm-file"${isFileConfirmationDisabled(dialog) ? ' disabled' : ''}>${dialog.mode === 'open' ? '打开' : '新建'}</button>
      </footer>
    </section>
  </div>`;
}

function renderWriteDialog(): string {
  return `<div class="modal-backdrop">
    <section class="modal" data-write-dialog role="dialog" aria-modal="true" aria-labelledby="write-dialog-title" tabindex="-1">
      <h2 id="write-dialog-title">启用数据库写入</h2>
      <p>启用后可新增、编辑、删除记录并执行写 SQL。系统对象仍保持只读。</p>
      ${error ? renderDialogError(error) : ''}
      <footer>
        <button type="button" data-action="cancel-write-mode">保持只读</button>
        <button type="button" class="danger" data-action="confirm-write-mode">启用写入</button>
      </footer>
    </section>
  </div>`;
}

function renderDialogError(panelErrorValue: PanelError): string {
  return `<div class="dialog-error" role="alert">${escapeHtml(panelErrorValue.message)}${panelErrorValue.detail ? `<details><summary>技术详情</summary><pre>${escapeHtml(panelErrorValue.detail)}</pre></details>` : ''}</div>`;
}

function bindAction(action: string, handler: () => void | Promise<void>): void {
  root?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.addEventListener('click', () => {
    void handler();
  });
}

function closeDialogs(openerAction?: string): void {
  if (busy) return;
  fileDialog = null;
  writeDialog = false;
  error = null;
  setModalOpen(false);
  render();
  if (openerAction) {
    queueMicrotask(() => root?.querySelector<HTMLElement>(`[data-action="${openerAction}"]`)?.focus());
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (!fileDialog && !writeDialog) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (busy) return;
    closeDialogs(fileDialog?.openerAction ?? writeDialogOpener);
    return;
  }
  if (event.key === 'Tab') trapModalFocus(event);
}

function focusAction(action: string): void {
  const preferred = root?.querySelector<HTMLElement>(`[data-action="${action}"]`);
  const fallback = root?.querySelector<HTMLElement>('[data-action="close"]');
  (preferred ?? fallback)?.focus();
}

function focusModal(): void {
  const modal = root?.querySelector<HTMLElement>('.modal');
  if (!modal || modal.contains(document.activeElement)) return;
  getModalFocusable(modal)[0]?.focus();
  if (!modal.contains(document.activeElement)) modal.focus();
}

function trapModalFocus(event: KeyboardEvent): void {
  const modal = root?.querySelector<HTMLElement>('.modal');
  if (!modal) return;
  const focusable = getModalFocusable(modal);
  const first = focusable[0] ?? modal;
  const last = focusable.at(-1) ?? modal;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !modal.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !modal.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function getModalFocusable(modal: HTMLElement): HTMLElement[] {
  return Array.from(modal.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
  ));
}

function setModalOpen(open: boolean): void {
  context?.panel.setModalOpen(open);
}

function syncConfirmFileDisabled(): void {
  const button = root?.querySelector<HTMLButtonElement>('[data-action="confirm-file"]');
  if (button && fileDialog) button.disabled = isFileConfirmationDisabled(fileDialog);
}

function isFileConfirmationDisabled(dialog: FileDialog): boolean {
  if (dialog.manualPath.trim()) return false;
  return dialog.mode === 'open' ? !dialog.selectedPath : !dialog.fileName.trim();
}

function joinDisplayPath(directory: string, name: string): string | null {
  if (!name) return null;
  return `${directory.replace(/[\\/]$/, '')}/${name}`;
}

function fileName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
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
    && (value.path === null || typeof value.path === 'string')
    && (value.mode === null || value.mode === 'readonly' || value.mode === 'readwrite')
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
