// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  CsvConnectionSnapshot,
  CsvQuery,
  CsvRowsResult,
  CsvSchema,
} from '@itharbors/csv-contracts';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): void;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

const ready: CsvConnectionSnapshot = {
  connectionRevision: 7, phase: 'ready', path: '/data/people.csv', fileName: 'people.csv',
  encoding: 'utf8', delimiter: ',', hasHeader: true, progress: 1, error: null,
  byteSize: 120, rowCount: 61, columnCount: 3, irregularRowCount: 0,
};
const schema: CsvSchema = {
  connectionRevision: 7, irregularRecordCount: 0,
  columns: [
    { id: 'column-1', index: 0, name: '编号' },
    { id: 'column-2', index: 1, name: '姓名' },
    { id: 'column-3', index: 2, name: '备注' },
  ],
};

describe('CSV data panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it.each([
    ['closed', '请先打开 CSV 文件'],
    ['sampling', '正在读取文件样本'],
    ['indexing', '正在建立索引'],
  ] as const)('renders the %s connection state', async (phase, copy) => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return { ...ready, phase, progress: phase === 'indexing' ? .4 : null };
      throw new Error(`Unexpected ${method}`);
    });
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    expect(document.body.textContent).toContain(copy);
    expect(request).not.toHaveBeenCalledWith(expect.anything(), 'getRows', expect.anything());
  });

  it('requests only the current page and preserves exact values including empty strings', async () => {
    const request = standardRequest();
    const panel = await loadPanel();
    await panel.mount({ message: { request } });

    expect(request).toHaveBeenCalledWith('@itharbors/csv-core', 'getRows', {
      connectionRevision: 7, page: 1, pageSize: 50, search: '', filters: [], sort: null,
    });
    expect(document.body.textContent).toContain('001');
    expect(document.querySelector('[data-cell-row="0"][data-column-id="column-3"]')?.innerHTML).toContain('empty-cell');
    expect(document.body.textContent).toContain('共 61 条记录');
    expect(document.querySelectorAll('[data-row-index][tabindex="0"], [data-cell-row][tabindex="0"]')).toHaveLength(1);
  });

  it('renders a ready empty file without creating table rows', async () => {
    const emptyReady = { ...ready, rowCount: 0, columnCount: 0, byteSize: 0 };
    const emptySchema = { connectionRevision: 7, irregularRecordCount: 0, columns: [] };
    const request = vi.fn(async (_plugin: string, method: string, input?: CsvQuery) => {
      if (method === 'getConnectionState') return emptyReady;
      if (method === 'getSchema') return emptySchema;
      if (method === 'getRows') return {
        connectionRevision: 7,
        page: input?.page ?? 1,
        pageSize: input?.pageSize ?? 50,
        totalRows: 0,
        rows: [],
      };
      throw new Error(`Unexpected ${method}`);
    });
    const panel = await loadPanel();
    await panel.mount({ message: { request } });

    expect(document.body.textContent).toContain('当前结果没有记录');
    expect(document.body.textContent).toContain('共 0 条记录');
    expect(document.querySelector('[data-row-index]')).toBeNull();
  });

  it('searches on Enter, combines filters, cycles sort, paginates, and changes page size', async () => {
    const request = standardRequest();
    const panel = await loadPanel();
    await panel.mount({ message: { request } });

    const search = document.querySelector<HTMLInputElement>('[data-field="search"]')!;
    search.value = ' 001 ';
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(lastRowsInput(request)).toMatchObject({ page: 1, search: ' 001 ' }));

    (document.querySelector('[data-action="open-filter"]') as HTMLButtonElement).click();
    setFilter('column-1', 'equals', '001');
    (document.querySelector('[data-action="apply-filter"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(lastRowsInput(request).filters).toEqual([
      { columnId: 'column-1', operator: 'equals', value: '001' },
    ]));
    (document.querySelector('[data-action="open-filter"]') as HTMLButtonElement).click();
    setFilter('column-3', 'is-empty', 'ignored');
    (document.querySelector('[data-action="apply-filter"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(lastRowsInput(request).filters).toHaveLength(2));

    (document.querySelector('[data-sort-column="column-2"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(lastRowsInput(request).sort).toEqual({ columnId: 'column-2', direction: 'asc' }));
    expect(document.querySelector('th[data-column-id="column-2"]')?.getAttribute('aria-sort')).toBe('ascending');
    expect(document.querySelector('[data-sort-column="column-2"]')?.textContent).toContain('↑');

    (document.querySelector('[data-action="next-page"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(lastRowsInput(request).page).toBe(2));
    const pageSize = document.querySelector<HTMLSelectElement>('[data-field="page-size"]')!;
    pageSize.value = '25';
    pageSize.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(lastRowsInput(request)).toMatchObject({ page: 1, pageSize: 25 }));
  });

  it('selects rows by keyboard and opens cell detail by double-click or keyboard', async () => {
    const panel = await loadPanel();
    await panel.mount({ message: { request: standardRequest() } });
    const row = document.querySelector<HTMLTableRowElement>('[data-row-index="0"]')!;
    row.focus();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-row-index')).toBe('1');
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');

    const cell = document.querySelector<HTMLElement>('[data-cell-row="0"][data-column-id="column-3"]')!;
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(document.querySelector('[role="dialog"] pre')?.textContent).toBe('');
    expect(document.activeElement?.getAttribute('data-action')).toBe('close-cell-detail');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement?.getAttribute('data-column-id')).toBe('column-3');
    const restored = document.activeElement as HTMLElement;
    expect(restored.tabIndex).toBe(0);
    expect(document.querySelectorAll('[data-row-index][tabindex="0"], [data-cell-row][tabindex="0"]')).toHaveLength(1);
    restored.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('confirms an export path, reports progress, cancels, and restores dialog focus', async () => {
    let releaseExport!: (value: unknown) => void;
    const request = standardRequest((_plugin, method, input) => {
      if (method === 'exportRows') return new Promise(resolve => { releaseExport = resolve; });
      if (method === 'cancelExport') return null;
      return undefined;
    });
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    const opener = document.querySelector<HTMLButtonElement>('[data-action="open-export"]')!;
    opener.focus(); opener.click();
    expect(document.activeElement?.getAttribute('data-field')).toBe('export-path');
    const path = document.querySelector<HTMLInputElement>('[data-field="export-path"]')!;
    path.value = '/data/result.csv';
    path.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('[data-action="confirm-export"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/csv-core', 'exportRows', expect.objectContaining({
      connectionRevision: 7, outputPath: '/data/result.csv', page: 1, pageSize: 50,
    })));
    const exportInput = request.mock.calls.find(call => call[1] === 'exportRows')![2] as { exportId: string };
    await panel.methods.onExportProgress({ connectionRevision: 7, exportId: exportInput.exportId, outputPath: '/data/result.csv', writtenRows: 20, totalRows: 61 });
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('20');
    (document.querySelector('[data-action="cancel-export"]') as HTMLButtonElement).click();
    expect(request).toHaveBeenCalledWith('@itharbors/csv-core', 'cancelExport', { connectionRevision: 7, exportId: exportInput.exportId });
    releaseExport({ $csvError: { code: 'EXPORT_CANCELLED', message: '导出已取消。' } });
    await vi.waitFor(() => expect(document.body.textContent).toContain('导出已取消'));
  });

  it('keeps a filter dialog usable through replacement progress and clears it on close', async () => {
    const request = standardRequest();
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    (document.querySelector('[data-action="open-filter"]') as HTMLButtonElement).click();
    const draftColumn = document.querySelector<HTMLSelectElement>('[data-field="filter-column"]')!;
    draftColumn.value = 'column-3';
    draftColumn.dispatchEvent(new Event('change', { bubbles: true }));
    const draftOperator = document.querySelector<HTMLSelectElement>('[data-field="filter-operator"]')!;
    draftOperator.value = 'equals';
    draftOperator.dispatchEvent(new Event('change', { bubbles: true }));
    const draftValue = document.querySelector<HTMLInputElement>('[data-field="filter-value"]')!;
    draftValue.value = 'draft-note';
    draftValue.dispatchEvent(new Event('input', { bubbles: true }));
    draftValue.focus();
    draftValue.setSelectionRange(2, 7);

    for (const progress of [.2, .7]) {
      await panel.methods.onDataConnectionChanged({ ...ready, connectionRevision: 8, phase: 'indexing', fileName: 'next.csv', progress });
      expect(document.querySelector('.filter-dialog')).not.toBeNull();
      expect((document.querySelector('[data-field="filter-column"]') as HTMLSelectElement).value).toBe('column-3');
      expect((document.querySelector('[data-field="filter-operator"]') as HTMLSelectElement).value).toBe('equals');
      const restoredValue = document.querySelector<HTMLInputElement>('[data-field="filter-value"]')!;
      expect(restoredValue.value).toBe('draft-note');
      expect(document.activeElement).toBe(restoredValue);
      expect([restoredValue.selectionStart, restoredValue.selectionEnd]).toEqual([2, 7]);
    }

    const search = document.querySelector<HTMLInputElement>('[data-field="search"]')!;
    search.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-field')).toBe('filter-column');
    search.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement?.getAttribute('data-action')).toBe('apply-filter');

    (document.querySelector('[data-action="apply-filter"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(lastRowsInput(request).filters).toEqual([
      { columnId: 'column-3', operator: 'equals', value: 'draft-note' },
    ]));

    (document.querySelector('[data-action="open-filter"]') as HTMLButtonElement).click();
    await panel.methods.onDataConnectionChanged({ ...ready, connectionRevision: 9, phase: 'closed', fileName: null, path: null, progress: null });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps cell detail interactive through replacement progress and clears it for new ready data', async () => {
    let activeSchema = schema;
    const request = vi.fn(async (_plugin: string, method: string, input?: any) => {
      if (method === 'getConnectionState') return ready;
      if (method === 'getSchema') return activeSchema;
      if (method === 'getRows') return { ...rows(input), connectionRevision: input.connectionRevision };
      throw new Error(`Unexpected ${method}`);
    });
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    const openDetail = () => document.querySelector<HTMLElement>('[data-cell-row="0"][data-column-id="column-1"]')
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    openDetail();
    expect(document.activeElement?.getAttribute('data-action')).toBe('close-cell-detail');

    for (const progress of [.15, .8]) {
      await panel.methods.onDataConnectionChanged({ ...ready, connectionRevision: 8, phase: 'indexing', fileName: 'next.csv', progress });
      expect(document.querySelector('[data-cell-detail-value]')?.textContent).toBe('001');
      expect(document.activeElement?.getAttribute('data-action')).toBe('close-cell-detail');
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    openDetail();
    activeSchema = { ...schema, connectionRevision: 8 };
    await panel.methods.onDataConnectionChanged({ ...ready, connectionRevision: 8, fileName: 'next.csv' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps old-ready export progress and cancel usable through replacement progress until new ready', async () => {
    let releaseExport!: (value: unknown) => void;
    let activeSchema = schema;
    const request = vi.fn(async (_plugin: string, method: string, input?: any) => {
      if (method === 'getConnectionState') return ready;
      if (method === 'getSchema') return activeSchema;
      if (method === 'getRows') return { ...rows(input), connectionRevision: input.connectionRevision };
      if (method === 'exportRows') return new Promise(resolve => { releaseExport = resolve; });
      if (method === 'cancelExport') return null;
      throw new Error(`Unexpected ${method}`);
    });
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    (document.querySelector('[data-action="open-export"]') as HTMLButtonElement).click();
    const path = document.querySelector<HTMLInputElement>('[data-field="export-path"]')!;
    path.value = '/data/result.csv';
    path.dispatchEvent(new Event('input', { bubbles: true }));
    path.focus();
    path.setSelectionRange(6, 12);

    for (const progress of [.1, .65]) {
      await panel.methods.onDataConnectionChanged({ ...ready, connectionRevision: 8, phase: 'indexing', fileName: 'next.csv', progress });
      const restoredPath = document.querySelector<HTMLInputElement>('[data-field="export-path"]')!;
      expect(restoredPath.value).toBe('/data/result.csv');
      expect(document.activeElement).toBe(restoredPath);
      expect([restoredPath.selectionStart, restoredPath.selectionEnd]).toEqual([6, 12]);
      expect((document.querySelector('[data-action="open-export"]') as HTMLButtonElement).disabled).toBe(false);
    }
    (document.querySelector('[data-action="confirm-export"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(releaseExport).toBeTypeOf('function'));
    const exportInput = request.mock.calls.find(call => call[1] === 'exportRows')![2] as CsvQuery & { exportId: string; outputPath: string };
    expect(exportInput).toMatchObject({ connectionRevision: 7, page: 1, pageSize: 50, search: '', filters: [], sort: null, outputPath: '/data/result.csv' });
    await panel.methods.onExportProgress({ connectionRevision: 7, exportId: exportInput.exportId, outputPath: '/data/result.csv', writtenRows: 23, totalRows: 61 });
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('23');
    (document.querySelector('[data-action="cancel-export"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/csv-core', 'cancelExport', {
      connectionRevision: 7, exportId: exportInput.exportId,
    }));
    expect(document.querySelector('[data-action="cancel-export"]')).not.toBeNull();
    releaseExport({ $csvError: { code: 'EXPORT_CANCELLED', message: '导出已取消。' } });
    await vi.waitFor(() => expect(document.querySelector('[data-action="close-export"]')).not.toBeNull());
    expect(document.body.textContent).toContain('导出已取消');

    activeSchema = { ...schema, connectionRevision: 8 };
    await panel.methods.onDataConnectionChanged({ ...ready, connectionRevision: 8, fileName: 'next.csv' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('preserves query controls after request errors and suppresses stale rows', async () => {
    let releaseOld!: (value: unknown) => void;
    const request = vi.fn(async (_plugin: string, method: string, input?: any) => {
      if (method === 'getConnectionState') return ready;
      if (method === 'getSchema') return schema;
      if (method === 'getRows' && input.search === '') return rows(input);
      if (method === 'getRows' && input.search === 'old') return new Promise(resolve => { releaseOld = resolve; });
      if (method === 'getRows' && input.search === 'new') return { $csvError: { code: 'QUERY_FAILED', message: '查询失败' } };
      throw new Error(`Unexpected ${method}`);
    });
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    const search = document.querySelector<HTMLInputElement>('[data-field="search"]')!;
    search.value = 'old'; search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    search.value = 'new'; search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('查询失败'));
    expect((document.querySelector('[data-field="search"]') as HTMLInputElement).value).toBe('new');
    releaseOld({ ...rows({ page: 1, pageSize: 50 }), rows: [{ record: 99, values: ['stale', 'stale', 'stale'] }] });
    await Promise.resolve();
    expect(document.body.textContent).not.toContain('stale');
    expect(document.body.textContent).not.toContain('正在加载当前页');
  });

  it('keeps an old-ready query alive through repeated replacement progress without sticking loading', async () => {
    let releaseSearch!: (value: CsvRowsResult) => void;
    const request = vi.fn(async (_plugin: string, method: string, input?: any) => {
      if (method === 'getConnectionState') return ready;
      if (method === 'getSchema') return schema;
      if (method === 'getRows' && input.search === '') return rows(input);
      if (method === 'getRows' && input.search === 'kept') return new Promise<CsvRowsResult>(resolve => { releaseSearch = resolve; });
      throw new Error(`Unexpected ${method}`);
    });
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    const search = document.querySelector<HTMLInputElement>('[data-field="search"]')!;
    search.value = 'kept';
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(releaseSearch).toBeTypeOf('function'));

    for (const progress of [.1, .45, .9]) {
      await panel.methods.onDataConnectionChanged({ ...ready, connectionRevision: 8, phase: 'indexing', fileName: 'next.csv', progress });
    }
    releaseSearch({ ...rows(), rows: [{ record: 12, values: ['kept-result', 'Ada', ''] }] });
    await vi.waitFor(() => expect(document.body.textContent).toContain('kept-result'));

    await panel.methods.onDataConnectionChanged(ready);
    expect(document.body.textContent).not.toContain('正在加载当前页');
  });

  it('bounds both axes for a 250 by 10,000 result and roves one focus target to its far corner', async () => {
    const manySchema: CsvSchema = {
      connectionRevision: 7, irregularRecordCount: 0,
      columns: Array.from({ length: 10_000 }, (_, index) => ({ id: `column-${index + 1}`, index, name: `列 ${index + 1}` })),
    };
    const sharedValues = ['value'];
    const row249Values = Array(10_000).fill('value'); row249Values[9_999] = 'r249c10000';
    const row250Values = Array(10_000).fill('value'); row250Values[9_999] = 'r250c10000';
    const manyRows = Array.from({ length: 250 }, (_, rowIndex) => ({
      record: rowIndex + 1,
      values: rowIndex === 248 ? row249Values : rowIndex === 249 ? row250Values : sharedValues,
    }));
    const request = vi.fn(async (_plugin: string, method: string, input?: any) => {
      if (method === 'getConnectionState') return { ...ready, columnCount: 10_000 };
      if (method === 'getSchema') return manySchema;
      if (method === 'getRows') return { ...rows(input), pageSize: 250, totalRows: 250, rows: manyRows };
      throw new Error(`Unexpected ${method}`);
    });
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    expect(document.querySelector('[data-table-scroller]')?.getAttribute('aria-rowcount')).toBe('251');
    expect(document.querySelector('[data-table-scroller]')?.getAttribute('aria-colcount')).toBe('10001');
    expect(document.querySelector('.grid-header tr')?.getAttribute('aria-rowindex')).toBe('1');
    expect(document.querySelector('.grid-header .record-column')?.getAttribute('aria-colindex')).toBe('1');
    expect(document.querySelector('[data-column-id="column-1"]')?.getAttribute('aria-colindex')).toBe('2');
    expect(document.querySelector('[data-row-index="0"]')?.getAttribute('aria-rowindex')).toBe('2');
    expect(document.querySelectorAll('th[data-column-id]').length).toBeLessThan(100);
    expect(document.querySelectorAll('[data-row-index]').length).toBeLessThanOrEqual(40);
    expect(document.querySelectorAll('td[data-column-id]').length).toBeLessThanOrEqual(40 * 36);
    expect(document.querySelectorAll('[data-row-index][tabindex="0"], [data-cell-row][tabindex="0"]')).toHaveLength(1);
    const firstRow = document.querySelector<HTMLElement>('[data-row-index="0"]')!;
    firstRow.focus();
    firstRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-row-index')).toBe('249');
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-column-id')).toBe('column-1');
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-column-id')).toBe('column-10000');
    expect(document.activeElement?.getAttribute('data-cell-row')).toBe('249');
    expect(document.activeElement?.textContent).toBe('r250c10000');
    expect(document.querySelector('.grid-header [data-column-id="column-10000"]')?.getAttribute('aria-colindex')).toBe('10001');
    expect(document.activeElement?.getAttribute('aria-colindex')).toBe('10001');
    expect(document.activeElement?.closest('tr')?.getAttribute('aria-rowindex')).toBe('251');
    expect(document.activeElement?.closest('tr')?.querySelector('.record-column')?.getAttribute('aria-colindex')).toBe('1');
    const header = document.querySelector<HTMLElement>('.grid-header')!;
    const body = document.querySelector<HTMLElement>('.grid-body')!;
    expect(header.style.left).toBe(body.style.left);
    expect(header.style.left).not.toBe('0px');
    expect(header.style.transform).toBe('');
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement?.textContent).toBe('r249c10000');
    expect(document.querySelectorAll('[data-row-index]').length).toBeLessThanOrEqual(40);
    expect(document.querySelectorAll('[data-row-index][tabindex="0"], [data-cell-row][tabindex="0"]')).toHaveLength(1);
  });

  it('keeps the ready page browsable while a replacement indexes and accepts rollback', async () => {
    const request = standardRequest();
    const panel = await loadPanel();
    await panel.mount({ message: { request } });
    await panel.methods.onDataConnectionChanged({ ...ready, connectionRevision: 8, phase: 'indexing', fileName: 'next.csv', progress: .5 });
    expect(document.body.textContent).toContain('people.csv');
    expect(document.body.textContent).toContain('001');
    expect(document.body.textContent).toContain('正在建立新文件索引');
    await panel.methods.onDataConnectionChanged(ready);
    expect(document.body.textContent).toContain('people.csv');
    expect(document.body.textContent).toContain('001');
  });

  it('declares both panels and the dense accessible workbench styling contract', () => {
    const csvRoot = process.cwd().endsWith('/kits/csv') ? process.cwd() : resolve(process.cwd(), 'kits/csv');
    const pluginRoot = resolve(csvRoot, 'plugins/csv-data');
    const packageJson = JSON.parse(readFileSync(resolve(pluginRoot, 'package.json'), 'utf8'));
    expect(packageJson['ce-editor'].contribute.panel).toMatchObject({
      data: { entry: './panel.data/dist/index.html', multiInstance: false },
      schema: { entry: './panel.schema/dist/index.html', multiInstance: false },
    });
    expect(packageJson['ce-editor'].contribute.message.broadcast).toMatchObject({
      '@itharbors/csv.connection.changed': expect.arrayContaining(['panel.onDataConnectionChanged', 'panel.onSchemaConnectionChanged']),
      '@itharbors/csv.export.progress': ['panel.onExportProgress'],
    });
    for (const panel of ['panel.data', 'panel.schema']) {
      const css = readFileSync(resolve(pluginRoot, `${panel}/src/index.css`), 'utf8');
      expect(css).toMatch(/--csv-brass:\s*#d6a84b/);
      expect(css).toMatch(/:focus-visible/);
      expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
      expect(css).not.toMatch(/gradient\s*\(/);
    }
    const dataCss = readFileSync(resolve(pluginRoot, 'panel.data/src/index.css'), 'utf8');
    expect(dataCss).toMatch(/\.table-scroller\s*\{[^}]*overflow:\s*auto/s);
    expect(dataCss).toMatch(/thead th\s*\{[^}]*position:\s*sticky/s);
    expect(dataCss).not.toMatch(/\.grid-header\s*\{[^}]*left:\s*0/s);
    expect(dataCss).toMatch(/@media\s*\(max-width:\s*720px\)/);
  });

  it('assembles actual zero-based core schema with exact first, middle, last cells and human positions', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'csv-data-contract-'));
    const indexRoot = join(temporaryRoot, 'index');
    mkdirSync(indexRoot);
    const source = join(temporaryRoot, 'actual.csv');
    writeFileSync(source, '编号,,编号\n001,middle,last\n', 'utf8');
    const { CsvService } = await import('../../csv-core/main/src/csv-service.js');
    const service = new CsvService({ temporaryRoot: indexRoot });
    try {
      const actualReady = await service.openFile({ path: source, encoding: 'utf8', delimiter: ',', hasHeader: true });
      const actualSchema = service.getSchema();
      const actualRows = service.getRows({ connectionRevision: actualReady.connectionRevision, page: 1, pageSize: 50, search: '', filters: [], sort: null });
      expect(actualSchema.columns.map(column => column.index)).toEqual([0, 1, 2]);
      const request = vi.fn(async (_plugin: string, method: string) => {
        if (method === 'getConnectionState') return actualReady;
        if (method === 'getSchema') return actualSchema;
        if (method === 'getRows') return actualRows;
        throw new Error(`Unexpected ${method}`);
      });
      const dataPanel = await loadPanel();
      await dataPanel.mount({ message: { request } });
      expect(document.querySelector('[data-cell-row="0"][data-column-id="column-1"]')?.textContent).toBe('001');
      expect(document.querySelector('[data-cell-row="0"][data-column-id="column-2"]')?.textContent).toBe('middle');
      const last = document.querySelector<HTMLElement>('[data-cell-row="0"][data-column-id="column-3"]')!;
      expect(last.textContent).toBe('last');
      expect(document.querySelector('[data-sort-column="column-2"]')?.textContent).toContain('未命名列 2');
      expect(document.querySelector('[data-sort-column="column-3"]')?.textContent).toContain('编号 (2)');
      last.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      expect(document.querySelector('[data-cell-detail-value]')?.textContent).toBe('last');
      dataPanel.unmount();

      document.body.innerHTML = '<div id="panel-root"></div>';
      const schemaPanel = (await import('../panel.schema/src/index.js')).default as PanelDefinition;
      await schemaPanel.mount({ message: { request } });
      expect(Array.from(document.querySelectorAll('[data-column-id] > code:first-child')).map(element => element.textContent)).toEqual(['1', '2', '3']);
      expect(document.querySelector('[data-column-id="column-2"]')?.textContent).toContain('未命名列 2');
      expect(document.querySelector('[data-column-id="column-3"]')?.textContent).toContain('编号 (2)');
    } finally {
      await service.dispose();
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

async function loadPanel(): Promise<PanelDefinition> {
  return (await import('../panel.data/src/index.js')).default as PanelDefinition;
}

function rows(input: { page?: number; pageSize?: 25 | 50 | 100 | 250 } = {}): CsvRowsResult {
  return {
    connectionRevision: 7, page: input.page ?? 1, pageSize: input.pageSize ?? 50, totalRows: 61,
    rows: [
      { record: 1, values: ['001', 'Ada', ''] },
      { record: 2, values: ['002', 'Lin', 'note'] },
    ],
  };
}

function standardRequest(extra?: (plugin: string, method: string, input?: any) => unknown) {
  return vi.fn(async (plugin: string, method: string, input?: any) => {
    const custom = extra?.(plugin, method, input);
    if (custom !== undefined) return custom;
    if (method === 'getConnectionState') return ready;
    if (method === 'getSchema') return schema;
    if (method === 'getRows') return rows(input);
    throw new Error(`Unexpected ${plugin}:${method}`);
  });
}

function lastRowsInput(request: ReturnType<typeof vi.fn>): any {
  return request.mock.calls.filter(call => call[1] === 'getRows').at(-1)?.[2];
}

function setFilter(columnId: string, operator: string, value: string) {
  const column = document.querySelector<HTMLSelectElement>('[data-field="filter-column"]')!;
  column.value = columnId;
  column.dispatchEvent(new Event('change', { bubbles: true }));
  const operation = document.querySelector<HTMLSelectElement>('[data-field="filter-operator"]')!;
  operation.value = operator;
  operation.dispatchEvent(new Event('change', { bubbles: true }));
  const input = document.querySelector<HTMLInputElement>('[data-field="filter-value"]')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
