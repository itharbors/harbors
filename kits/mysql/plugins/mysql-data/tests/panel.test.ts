// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): void;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

const connection = {
  connected: true,
  endpoint: 'db.local:3306',
  database: 'app',
  mysqlVersion: '8.4.1',
  tls: false,
  connectionRevision: 1,
  schemaRevision: 2,
  dataRevision: 3,
};
const usersSchema = {
  name: 'users', type: 'table', insertable: true, rowEditable: true,
  columns: [
    { name: 'id', type: 'bigint', nullable: false, defaultValue: null, extra: 'auto_increment', generatedExpression: '', generated: false, autoIncrement: true, binary: false },
    { name: 'email', type: 'varchar(255)', nullable: false, defaultValue: null, extra: '', generatedExpression: '', generated: false, autoIncrement: false, binary: false },
    { name: 'score', type: 'decimal(5,2)', nullable: true, defaultValue: null, extra: '', generatedExpression: '', generated: false, autoIncrement: false, binary: false },
  ],
  primaryKey: ['id'], indexes: [], foreignKeys: [], sql: 'CREATE TABLE users',
};
const identity = { kind: 'primary-key', values: { id: { type: 'integer', mysqlType: 'BIGINT', value: '1' } } };
const usersRows = {
  name: 'users', page: 1, pageSize: 100, total: 150, insertable: true, rowEditable: true,
  columns: ['id', 'email', 'score'],
  rows: [{ values: [
    { type: 'integer', mysqlType: 'BIGINT', value: '1' },
    'a@example.com',
    { type: 'decimal', value: '3.50' },
  ], identity }],
};

describe('MySQL Data panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('loads selection, paginates, and performs explicit CRUD payloads', async () => {
    const request = createRequest();
    const definition = (await import('../panel.data/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    expect(document.querySelector('[data-view="data"]')?.textContent).toContain('a@example.com');
    (document.querySelector('[data-action="next-page"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/mysql-core', 'getRows', {
      name: 'users', page: 2, pageSize: 100,
    }));
    await vi.waitFor(() => expect(
      (document.querySelector('[data-action="add-row"]') as HTMLButtonElement).disabled,
    ).toBe(false));

    (document.querySelector('[data-action="add-row"]') as HTMLButtonElement).click();
    let dialog = document.querySelector<HTMLDialogElement>('dialog[data-record-dialog]')!;
    setDialogValue(dialog, 'email', 'new@example.com');
    (dialog.querySelector('[data-action="save-record"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/mysql-core', 'insertRow', {
      name: 'users', values: { email: { type: 'text', value: 'new@example.com' } },
    }));
    await waitForReady();

    (document.querySelector('[data-row-index="0"]') as HTMLElement).click();
    await vi.waitFor(() => expect(
      (document.querySelector('[data-action="edit-row"]') as HTMLButtonElement).disabled,
    ).toBe(false));
    (document.querySelector('[data-action="edit-row"]') as HTMLButtonElement).click();
    dialog = document.querySelector<HTMLDialogElement>('dialog[data-record-dialog]')!;
    setDialogValue(dialog, 'score', '4.50');
    (dialog.querySelector('[data-action="save-record"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/mysql-core', 'updateRow', {
      name: 'users', identity, values: { score: { type: 'decimal', value: '4.50' } },
    }));
    await waitForReady();

    (document.querySelector('[data-row-index="0"]') as HTMLElement).click();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    (document.querySelector('[data-action="delete-row"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/mysql-core', 'deleteRow', {
      name: 'users', identity,
    }));
  });

  it('disables unsafe actions and reloads only relevant data changes', async () => {
    const request = createRequest({ rowEditable: false, insertable: true });
    const definition = (await import('../panel.data/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    expect((document.querySelector('[data-action="add-row"]') as HTMLButtonElement).disabled).toBe(false);
    expect((document.querySelector('[data-action="edit-row"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-capability-notice]')?.textContent).toContain('主键');
    const before = request.mock.calls.filter((call) => call[1] === 'getRows').length;

    await definition.methods.onDataChanged({ ...connection, dataRevision: 4, objectName: 'orders' });
    expect(request.mock.calls.filter((call) => call[1] === 'getRows')).toHaveLength(before);
    await definition.methods.onDataChanged({ ...connection, dataRevision: 5, objectName: 'users' });
    expect(request.mock.calls.filter((call) => call[1] === 'getRows')).toHaveLength(before + 1);
  });

  it('restores the historical workspace hierarchy and data grid styling contract', async () => {
    const request = createRequest();
    const definition = (await import('../panel.data/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    const workspace = document.querySelector<HTMLElement>('#panel-root > .workspace');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-identity > .object-kind')?.textContent)
      .toBe('表');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-identity > h1.object-title')?.textContent)
      .toBe('users');
    expect(workspace?.querySelector(':scope > .workspace-heading > .data-actions [data-action="add-row"]'))
      .not.toBeNull();
    expect(workspace?.querySelector(':scope > .capability-slot')).not.toBeNull();
    expect(workspace?.querySelector(':scope > .view-host > .data-view > .table-shell > table > thead + tbody'))
      .not.toBeNull();
    expect(workspace?.querySelector(':scope > .view-host > .data-view > .pager[aria-label="数据分页"]'))
      .not.toBeNull();
    expect(workspace?.querySelector(':scope > .status-deck > [role="status"] + .error-slot')).not.toBeNull();

    const css = readFileSync(resolve(process.cwd(), 'plugins/mysql-data/panel.data/src/index.css'), 'utf8');
    expect(css).toMatch(/--ink:\s*#07111d/);
    expect(css).toMatch(/--blue:\s*#4d9bd3/);
    expect(css).toMatch(/--cyan:\s*#76d0ec/);
    expect(css).toMatch(/--amber:\s*#f0ba57/);
    expect(css).toMatch(/h1\.object-title\s*\{[^}]*margin:\s*0/s);
    expect(css).toMatch(/\.workspace\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0,\s*1fr\) auto/s);
    expect(css).toMatch(/\.view-host\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.data-view\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\) auto/s);
    expect(css).toMatch(/\.table-shell\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/th\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/s);
  });

  it('renders the historical record dialog regions with a constrained scrolling body', async () => {
    const dialogMethods = patchDialogMethods();
    try {
      const request = createRequest();
      const definition = (await import('../panel.data/src/index')).default as PanelDefinition;
      await definition.mount({ message: { request } });

      (document.querySelector('[data-action="add-row"]') as HTMLButtonElement).click();
      let dialog = document.querySelector<HTMLDialogElement>('dialog[data-record-dialog]')!;
      expect(dialogMethods.showModal).toHaveBeenCalledTimes(1);
      expect(dialog.open).toBe(true);
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.getAttribute('aria-labelledby')).toBe(dialog.querySelector('h2')?.id);
      expect(dialog.querySelector(':scope > .dialog-header > .dialog-mode + h2[id]')?.textContent).toBe('新增记录');
      expect(dialog.querySelector(':scope > .record-form > .record-form-body > .record-field')).not.toBeNull();
      expect(dialog.querySelector(':scope > .record-form > .record-form-body + .dialog-actions')).not.toBeNull();
      expect(dialog.querySelector('[data-field-include][aria-label="包含 email"]')).not.toBeNull();
      expect(dialog.querySelector('[data-field-type][aria-label="email 值类型"]')).not.toBeNull();

      (dialog.querySelector('[data-action="cancel-record"]') as HTMLButtonElement).click();
      expect(dialogMethods.close).toHaveBeenCalledTimes(1);
      expect(dialog.open).toBe(false);
      expect(document.querySelector('dialog[data-record-dialog]')).toBeNull();

      (document.querySelector('[data-row-index="0"]') as HTMLElement).click();
      (document.querySelector('[data-action="edit-row"]') as HTMLButtonElement).click();
      dialog = document.querySelector<HTMLDialogElement>('dialog[data-record-dialog]')!;
      expect(dialogMethods.showModal).toHaveBeenCalledTimes(2);
      expect(dialog.open).toBe(true);
      expect(dialog.querySelector('.dialog-header h2')?.textContent).toBe('编辑所选记录');
      (dialog.querySelector('[data-action="cancel-record"]') as HTMLButtonElement).click();
      expect(dialogMethods.close).toHaveBeenCalledTimes(2);
      expect(dialog.open).toBe(false);

      const css = readFileSync(resolve(process.cwd(), 'plugins/mysql-data/panel.data/src/index.css'), 'utf8');
      expect(css).toMatch(/dialog\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)[^}]*max-height:[^;}]+[^}]*overflow:\s*hidden/s);
      expect(css).toMatch(/\.record-form\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\) auto[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
      expect(css).toMatch(/\.record-form-body\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/s);
      expect(css).toMatch(/\.dialog-actions\s*\{[^}]*display:\s*flex/s);
    } finally {
      dialogMethods.restore();
    }
  });

  it('clears record dialog state when the native cancel event dismisses it', async () => {
    const dialogMethods = patchDialogMethods();
    try {
      const request = createRequest();
      const definition = (await import('../panel.data/src/index')).default as PanelDefinition;
      await definition.mount({ message: { request } });

      (document.querySelector('[data-action="add-row"]') as HTMLButtonElement).click();
      const dialog = document.querySelector<HTMLDialogElement>('dialog[data-record-dialog]')!;
      const cancelEvent = new Event('cancel', { cancelable: true });

      expect(dialog.dispatchEvent(cancelEvent)).toBe(false);
      expect(cancelEvent.defaultPrevented).toBe(true);
      expect(dialogMethods.close).toHaveBeenCalledTimes(1);
      expect(dialog.open).toBe(false);
      expect(document.querySelector('dialog[data-record-dialog]')).toBeNull();

      await definition.methods.onDataChanged({ ...connection, dataRevision: 4, objectName: 'users' });
      expect(document.querySelector('dialog[data-record-dialog]')).toBeNull();
    } finally {
      dialogMethods.restore();
    }
  });
});

function createRequest(capabilities?: { rowEditable: boolean; insertable: boolean }) {
  return vi.fn(async (plugin: string, method: string, input?: any) => {
    if (plugin === '@itharbors/mysql-core' && method === 'getConnectionState') return connection;
    if (plugin === '@itharbors/mysql-explorer' && method === 'getSelection') return { connectionRevision: 1, objectName: 'users' };
    if (plugin === '@itharbors/mysql-core' && method === 'getObjectSchema') return { ...usersSchema, ...capabilities };
    if (plugin === '@itharbors/mysql-core' && method === 'getRows') return { ...usersRows, ...capabilities, page: input.page };
    if (plugin === '@itharbors/mysql-core' && ['insertRow', 'updateRow', 'deleteRow'].includes(method)) return { changes: 1 };
    throw new Error(`Unexpected request ${plugin}:${method}`);
  });
}

function setDialogValue(dialog: HTMLDialogElement, name: string, value: string): void {
  const input = dialog.querySelector<HTMLInputElement>(`[data-field-name="${name}"] [data-field-value]`)!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function waitForReady(): Promise<void> {
  await vi.waitFor(() => expect(
    (document.querySelector('[data-action="add-row"]') as HTMLButtonElement).disabled,
  ).toBe(false));
}

function patchDialogMethods() {
  const prototype = HTMLDialogElement.prototype;
  const showModalDescriptor = Object.getOwnPropertyDescriptor(prototype, 'showModal');
  const closeDescriptor = Object.getOwnPropertyDescriptor(prototype, 'close');
  const showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true; });
  const close = vi.fn(function close(this: HTMLDialogElement) { this.open = false; });
  Object.defineProperty(prototype, 'showModal', { configurable: true, value: showModal });
  Object.defineProperty(prototype, 'close', { configurable: true, value: close });
  return {
    showModal,
    close,
    restore() {
      if (showModalDescriptor) Object.defineProperty(prototype, 'showModal', showModalDescriptor);
      else Reflect.deleteProperty(prototype, 'showModal');
      if (closeDescriptor) Object.defineProperty(prototype, 'close', closeDescriptor);
      else Reflect.deleteProperty(prototype, 'close');
    },
  };
}
