// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): void;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

const connection = {
  connectionRevision: 2, phase: 'ready', path: '/data/people.csv', fileName: 'people.csv',
  encoding: 'utf8', delimiter: ',', hasHeader: true, progress: 1, error: null,
  byteSize: 1024, rowCount: 42, columnCount: 2, irregularRowCount: 2,
};
const schema = {
  connectionRevision: 2, irregularRecordCount: 2,
  columns: [{ id: 'column-1', index: 0, name: '姓名' }, { id: 'column-2', index: 1, name: '城市' }],
};

describe('CSV explorer panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('shows a dense file ledger and lets keyboard users choose stable field ids', async () => {
    const broadcast = vi.fn();
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return connection;
      if (method === 'getSchema') return schema;
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request, broadcast } });

    expect(document.body.textContent).toContain('people.csv');
    expect(document.body.textContent).toContain('42 行');
    expect(document.body.textContent).toContain('2 列');
    expect(document.body.textContent).toContain('UTF-8 · 逗号');
    expect(document.body.textContent).toContain('不规则记录 2');
    const field = document.querySelector<HTMLButtonElement>('[data-column-id="column-2"]')!;
    field.focus();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.querySelector('[data-column-id="column-2"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(broadcast).toHaveBeenCalledWith('@itharbors/csv.selection.changed', {
      connectionRevision: 2, columnId: 'column-2',
    });
  });

  it('renders schema display names and one-based field positions', async () => {
    const displaySchema = {
      connectionRevision: 2,
      irregularRecordCount: 0,
      columns: [
        { id: 'column-1', index: 0, name: '' },
        { id: 'column-2', index: 1, name: 'name' },
        { id: 'column-3', index: 2, name: 'name' },
      ],
    };
    const request = vi.fn(async (_plugin: string, method: string) => method === 'getConnectionState' ? connection : displaySchema);
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request, broadcast: vi.fn() } });

    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-column-id]'));
    expect(rows.map(row => row.querySelector('span')?.textContent)).toEqual(['未命名列 1', 'name', 'name (2)']);
    expect(rows.map(row => row.querySelector('small')?.textContent)).toEqual(['1', '2', '3']);
  });

  it('keeps newer schema state when stale revisions arrive and has an empty state', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => method === 'getConnectionState' ? connection : schema);
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request, broadcast: vi.fn() } });
    await definition.methods.onSchemaChanged({ connectionRevision: 3, irregularRecordCount: 0, columns: [] });
    expect(document.body.textContent).toContain('姓名');
    await definition.methods.onSchemaChanged(schema);
    expect(document.body.textContent).toContain('姓名');
  });

  it('preserves old schema during replacement, ignores mismatched schemas, and bounds a 10k field ledger', async () => {
    const many = { connectionRevision: 2, irregularRecordCount: 0, columns: Array.from({ length: 10_000 }, (_, index) => ({ id: `column-${index + 1}`, index, name: `列 ${index + 1}` })) };
    const request = vi.fn(async (_plugin: string, method: string) => method === 'getConnectionState' ? connection : schema);
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request, broadcast: vi.fn() } });
    await definition.methods.onExplorerConnectionChanged({ ...connection, connectionRevision: 3, phase: 'indexing', progress: .1 });
    expect(document.body.textContent).toContain('姓名');
    await definition.methods.onExplorerConnectionChanged(connection);
    await definition.methods.onSchemaChanged({ ...many, connectionRevision: 99 });
    expect(document.querySelectorAll('[data-column-id]').length).toBeLessThan(200);
    await definition.methods.onSchemaChanged(many);
    expect(document.querySelectorAll('[data-column-id]').length).toBeLessThan(200);
    const first = document.querySelector<HTMLButtonElement>('[data-column-id="column-1"]')!;
    first.focus(); first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-column-id')).toBe('column-10000');
  });

  it('does not let a deferred mount request overwrite a newer connection broadcast', async () => {
    let resolveConnection: ((value: unknown) => void) | undefined;
    const pending = new Promise<unknown>((resolve) => { resolveConnection = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => method === 'getConnectionState' ? pending : schema);
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    const mounting = definition.mount({ message: { request, broadcast: vi.fn() } });
    await definition.methods.onExplorerConnectionChanged({ ...connection, connectionRevision: 3, fileName: 'newer.csv' });
    resolveConnection?.(connection);
    await mounting;
    expect(document.body.textContent).toContain('newer.csv');
  });
});
