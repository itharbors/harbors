// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CsvConnectionSnapshot, CsvSchema } from '@itharbors/csv-contracts';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

const ready: CsvConnectionSnapshot = {
  connectionRevision: 8, phase: 'ready', path: '/data/odd.csv', fileName: 'odd.csv',
  encoding: 'utf8', delimiter: ',', hasHeader: true, progress: 1, error: null,
  byteSize: 20, rowCount: 3, columnCount: 3, irregularRowCount: 2,
};
const schema: CsvSchema = {
  connectionRevision: 8, irregularRecordCount: 2,
  columns: [
    { id: 'column-1', index: 0, name: '值' },
    { id: 'column-2', index: 1, name: '' },
    { id: 'column-3', index: 2, name: '值' },
  ],
};

describe('CSV schema panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('renders stable ids, source and display names, positions, and irregular width summary', async () => {
    const request = baseRequest();
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    expect(document.body.textContent).toContain('不规则记录 2');
    expect(document.body.textContent).toContain('column-2');
    expect(document.body.textContent).toContain('未命名列 2');
    expect(document.body.textContent).toContain('值 (2)');
    expect(document.querySelector('[data-column-id="column-3"]')?.textContent).toContain('3');
    expect(request).not.toHaveBeenCalledWith(expect.anything(), 'getColumnStats', expect.anything());
    expect(document.querySelectorAll('[data-column-id][tabindex="0"]')).toHaveLength(1);
  });

  it('loads statistics lazily on field activation and retries an error', async () => {
    let fail = true;
    const request = baseRequest((_plugin, method, input) => {
      if (method === 'getColumnStats') {
        if (fail) { fail = false; return { $csvError: { code: 'STATS_FAILED', message: '统计失败' } }; }
        return { connectionRevision: 8, columnId: input.columnId, emptyCount: 1, nonEmptyCount: 2, maxLength: 18 };
      }
      return undefined;
    });
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    const field = document.querySelector<HTMLButtonElement>('[data-column-id="column-2"]')!;
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('统计失败'));
    (document.querySelector('[data-action="retry-stats"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('最大长度'));
    expect(document.querySelector('.stats-panel')?.textContent).toContain('18');
    expect(request).toHaveBeenCalledWith('@itharbors/csv-core', 'getColumnStats', { connectionRevision: 8, columnId: 'column-2' });
    expect(document.body.textContent).not.toMatch(/数字|日期/);
  });

  it('suppresses stale statistics and schema revisions', async () => {
    let release!: (value: unknown) => void;
    const request = baseRequest((_plugin, method) => method === 'getColumnStats'
      ? new Promise(resolve => { release = resolve; })
      : undefined);
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    (document.querySelector('[data-column-id="column-1"]') as HTMLButtonElement).click();
    await panel.methods.onSchemaChanged({ ...schema, connectionRevision: 9, columns: [{ id: 'column-1', index: 0, name: '新值' }] });
    release({ connectionRevision: 8, columnId: 'column-1', emptyCount: 0, nonEmptyCount: 3, maxLength: 999 });
    await Promise.resolve();
    expect(document.body.textContent).not.toContain('999');
    expect(document.body.textContent).not.toContain('新值');
  });

  it('bounds a 10,000-field ledger, follows manual scroll, and restores keyboard selection-follow', async () => {
    const many: CsvSchema = {
      connectionRevision: 8, irregularRecordCount: 0,
      columns: Array.from({ length: 10_000 }, (_, index) => ({ id: `column-${index + 1}`, index, name: `列 ${index + 1}` })),
    };
    const request = baseRequest((_plugin, method, input) => {
      if (method === 'getSchema') return many;
      if (method === 'getColumnStats') return { connectionRevision: 8, columnId: input.columnId, emptyCount: 0, nonEmptyCount: 3, maxLength: 12 };
      return undefined;
    });
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    expect(document.querySelectorAll('[data-column-id]').length).toBeLessThan(200);
    const first = document.querySelector<HTMLButtonElement>('[data-column-id="column-1"]')!;
    expect(document.querySelectorAll('[data-column-id][tabindex="0"]')).toHaveLength(1);
    first.click();
    await vi.waitFor(() => expect(document.querySelector('.stats-panel')?.textContent).toContain('12'));
    const viewport = document.querySelector<HTMLElement>('[data-schema-viewport]')!;
    viewport.scrollTop = 9_000 * 44;
    viewport.dispatchEvent(new Event('scroll'));
    const scrolled = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-column-id]'));
    expect(Number(scrolled[0].dataset.columnId?.slice('column-'.length))).toBeGreaterThan(8_000);
    expect(scrolled).toHaveLength(72);
    expect(document.querySelector('[data-column-id="column-1"]')).toBeNull();
    expect(document.querySelectorAll('[data-column-id][tabindex="0"]')).toHaveLength(1);

    const manualTarget = document.querySelector<HTMLButtonElement>('[data-column-id][tabindex="0"]')!;
    const manualIndex = Number(manualTarget.dataset.columnId?.slice('column-'.length));
    manualTarget.focus();
    manualTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-column-id')).toBe(`column-${manualIndex + 1}`));
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-column-id')).toBe('column-10000');
    expect(document.querySelectorAll('[data-column-id][tabindex="0"]')).toHaveLength(1);
  });

  it('keeps the ready ledger while a replacement indexes and accepts rollback', async () => {
    const panel = await loadPanel();
    await panel.mount({ message: { request: baseRequest() } });
    await panel.methods.onSchemaConnectionChanged({ ...ready, connectionRevision: 9, phase: 'indexing', fileName: 'next.csv', progress: .4 });
    expect(document.body.textContent).toContain('odd.csv');
    expect(document.body.textContent).toContain('column-1');
    expect(document.body.textContent).toContain('正在建立新文件索引');
    await panel.methods.onSchemaConnectionChanged(ready);
    expect(document.body.textContent).toContain('column-1');
  });

  it('binds old-field statistics to the ready schema through replacement, rollback, and new ready', async () => {
    let activeSchema = schema;
    const calls: Array<{ connectionRevision: number; columnId: string }> = [];
    const request = vi.fn(async (_plugin: string, method: string, input?: any) => {
      if (method === 'getConnectionState') return ready;
      if (method === 'getSchema') return activeSchema;
      if (method === 'getColumnStats') {
        calls.push(input);
        return { connectionRevision: input.connectionRevision, columnId: input.columnId, emptyCount: 1, nonEmptyCount: 2, maxLength: input.columnId === 'column-1' ? 11 : 22 };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    (document.querySelector('[data-column-id="column-1"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('.stats-panel')?.textContent).toContain('11'));
    await panel.methods.onSchemaConnectionChanged({ ...ready, connectionRevision: 9, phase: 'indexing', fileName: 'next.csv', progress: .4 });
    expect(document.querySelector('.stats-panel')?.textContent).toContain('11');
    (document.querySelector('[data-column-id="column-2"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('.stats-panel')?.textContent).toContain('22'));
    expect(calls.at(-1)).toEqual({ connectionRevision: 8, columnId: 'column-2' });
    await panel.methods.onSchemaConnectionChanged(ready);
    expect(document.querySelector('.stats-panel')?.textContent).toContain('22');

    activeSchema = { connectionRevision: 9, irregularRecordCount: 0, columns: [{ id: 'column-1', index: 0, name: '新字段' }] };
    await panel.methods.onSchemaConnectionChanged({ ...ready, connectionRevision: 9, fileName: 'next.csv' });
    expect(document.body.textContent).toContain('新字段');
    expect(document.querySelector('.stats-panel')?.textContent).not.toContain('22');
  });

  it('ignores an old-schema statistics response after the replacement becomes ready', async () => {
    let resolveOld!: (value: unknown) => void;
    let activeSchema = schema;
    const request = vi.fn(async (_plugin: string, method: string, input?: any) => {
      if (method === 'getConnectionState') return ready;
      if (method === 'getSchema') return activeSchema;
      if (method === 'getColumnStats') return new Promise(resolve => { resolveOld = resolve; });
      throw new Error(`Unexpected ${method}:${JSON.stringify(input)}`);
    });
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    await panel.methods.onSchemaConnectionChanged({ ...ready, connectionRevision: 9, phase: 'indexing', fileName: 'next.csv', progress: .4 });
    (document.querySelector('[data-column-id="column-1"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    activeSchema = { connectionRevision: 9, irregularRecordCount: 0, columns: [{ id: 'column-1', index: 0, name: '新字段' }] };
    await panel.methods.onSchemaConnectionChanged({ ...ready, connectionRevision: 9, fileName: 'next.csv' });
    resolveOld({ connectionRevision: 8, columnId: 'column-1', emptyCount: 0, nonEmptyCount: 3, maxLength: 999 });
    await Promise.resolve();
    expect(document.body.textContent).toContain('新字段');
    expect(document.body.textContent).not.toContain('999');
  });

  it('accepts an in-flight old-schema statistics response while replacement is only indexing', async () => {
    let resolveOld!: (value: unknown) => void;
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return ready;
      if (method === 'getSchema') return schema;
      if (method === 'getColumnStats') return new Promise(resolve => { resolveOld = resolve; });
      throw new Error(`Unexpected ${method}`);
    });
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    (document.querySelector('[data-column-id="column-1"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    await panel.methods.onSchemaConnectionChanged({ ...ready, connectionRevision: 9, phase: 'indexing', fileName: 'next.csv', progress: .4 });
    resolveOld({ connectionRevision: 8, columnId: 'column-1', emptyCount: 0, nonEmptyCount: 3, maxLength: 77 });
    await vi.waitFor(() => expect(document.querySelector('.stats-panel')?.textContent).toContain('77'));
  });
});

async function loadPanel(): Promise<PanelDefinition> {
  return (await import('../panel.schema/src/index.js')).default as PanelDefinition;
}

function baseRequest(extra?: (plugin: string, method: string, input?: any) => unknown) {
  return vi.fn(async (plugin: string, method: string, input?: any) => {
    const custom = extra?.(plugin, method, input);
    if (custom !== undefined) return custom;
    if (method === 'getConnectionState') return ready;
    if (method === 'getSchema') return schema;
    throw new Error(`Unexpected ${plugin}:${method}`);
  });
}
