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
  file: {
    openLocal(options?: { accept?: string }): Promise<string | null>;
    saveLocal(options?: { accept?: string; suggestedName?: string }): Promise<string | null>;
  };
  panel: {
    setModalOpen(open: boolean): void;
  };
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
  fileIdentity: null,
  fileName: null,
  mode: null,
  sqliteVersion: null,
  foreignKeys: null,
  busyTimeout: null,
  connectionRevision: 0,
  schemaRevision: 0,
  dataRevision: 0,
};

const SQLITE_FILE_ACCEPT = '.sqlite,.sqlite3,.db,application/vnd.sqlite3';

let context: PanelContext | undefined;
let root: HTMLElement | null = null;
let connection: ConnectionSnapshot = { ...DISCONNECTED };
let busy = false;
let error: PanelError | null = null;
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
    writeDialog = false;
  },

  methods: {
    onConnectionChanged(payload: unknown) {
      if (
        !isConnectionSnapshot(payload)
        || payload.connectionRevision < connection.connectionRevision
      ) return;
      const focusTarget = writeDialog ? 'close' : null;
      if (focusTarget && activeAction && isCurrentAction(activeAction)) {
        activeAction.focusAction = focusTarget;
      }
      acceptConnection(payload);
      if (focusTarget && !busy) queueMicrotask(() => focusAction(focusTarget));
    },
  },
};

export default definition;

function resetState(): void {
  connection = { ...DISCONNECTED };
  busy = false;
  error = null;
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
    writeDialog = false;
    setModalOpen(false);
  }
  render();
}

async function selectDatabase(create: boolean, openerAction: string): Promise<void> {
  await runAction(async (token) => {
    token.focusAction = openerAction;
    if (!context) throw new Error('SQLite 连接栏尚未挂载。');
    const target = create
      ? await context.file.saveLocal({
        accept: SQLITE_FILE_ACCEPT,
        suggestedName: 'database.sqlite',
      })
      : await context.file.openLocal({ accept: SQLITE_FILE_ACCEPT });
    if (!isCurrentActionResult(token) || target === null) return;
    const next = await requestCore<ConnectionSnapshot>('openDatabase', {
      path: target,
      create,
    });
    if (!isCurrentActionResult(token)) return;
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
  const modalOpen = writeDialog;
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
      ${writeDialog ? renderWriteDialog() : ''}
    </main>
  `;

  bindAction('browse-open', () => selectDatabase(false, 'browse-open'));
  bindAction('browse-create', () => selectDatabase(true, 'browse-create'));
  bindAction('refresh', refreshObjects);
  bindAction('close', closeDatabase);
  bindAction('unlock-writes', () => {
    writeDialog = true;
    writeDialogOpener = 'unlock-writes';
    error = null;
    setModalOpen(true);
    render();
  });
  bindAction('cancel-write-mode', () => closeWriteDialog(writeDialogOpener));
  bindAction('confirm-write-mode', confirmWriteMode);

  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('button'))) {
    if (busy) button.disabled = true;
  }
  if (modalOpen) queueMicrotask(focusModal);
}

function renderConnectionState(): string {
  if (error && !writeDialog) {
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

function closeWriteDialog(openerAction?: string): void {
  if (busy) return;
  writeDialog = false;
  error = null;
  setModalOpen(false);
  render();
  if (openerAction) {
    queueMicrotask(() => root?.querySelector<HTMLElement>(`[data-action="${openerAction}"]`)?.focus());
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (!writeDialog) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (busy) return;
    closeWriteDialog(writeDialogOpener);
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
