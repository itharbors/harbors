// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): void;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

const closed = {
  connectionRevision: 0, phase: 'closed', path: null, fileName: null,
  encoding: null, delimiter: null, hasHeader: null, progress: null, error: null,
  byteSize: null, rowCount: null, columnCount: null, irregularRowCount: null,
};
const sampled = {
  path: '/data/people.csv', fileName: 'people.csv', size: 128, modifiedAt: '2026-07-24T00:00:00.000Z',
  suggestion: { encoding: 'utf8' as const, delimiter: ',' as const, hasHeader: true },
  preview: { cells: ['name', 'city'], truncated: false },
};
const ready = {
  connectionRevision: 2, phase: 'ready' as const, path: '/data/people.csv', fileName: 'people.csv',
  encoding: 'utf8' as const, delimiter: ',' as const, hasHeader: true,
  progress: 1, error: null, byteSize: 128, rowCount: 2, columnCount: 2, irregularRowCount: 1,
};

describe('CSV connection panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('samples a controlled file selection then explicitly opens the chosen parse configuration', async () => {
    const request = vi.fn(async (_plugin: string, method: string, input?: unknown) => {
      if (method === 'getConnectionState') return closed;
      if (method === 'getDefaultDirectory') return '/data';
      if (method === 'listDirectory') return {
        currentPath: '/data', parentPath: '/',
        entries: [{ name: 'people.csv', path: '/data/people.csv', kind: 'file', size: 128, modifiedAt: null }],
      };
      if (method === 'sampleFile') return sampled;
      if (method === 'openFile') return ready;
      throw new Error(`Unexpected request ${method}:${JSON.stringify(input)}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen: vi.fn() } });

    expect(document.querySelector('label[for="csv-path"]')?.textContent).toContain('文件');
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    (document.querySelector('[data-action="browse"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-file-path="/data/people.csv"]')).not.toBeNull());
    (document.querySelector('[data-file-path="/data/people.csv"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/csv-core', 'sampleFile', { path: '/data/people.csv' }));

    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain(','));
    expect(document.querySelector('[data-field="encoding"]')).not.toBeNull();
    expect(document.querySelector('[data-field="delimiter"]')).not.toBeNull();
    (document.querySelector('[data-action="open"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/csv-core', 'openFile', {
      path: '/data/people.csv', encoding: 'utf8', delimiter: ',', hasHeader: true,
    }));
    await vi.waitFor(() => expect(document.body.textContent).toContain('2 行'));
    expect(document.body.textContent).toContain('不规则记录 1');
  });

  it('renders indexing progress, cancels with its current revision, and ignores stale broadcasts', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => method === 'getConnectionState' ? closed : undefined);
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen: vi.fn() } });
    await definition.methods.onConnectionChanged({ ...ready, phase: 'indexing', connectionRevision: 8, progress: 0.2 });
    await definition.methods.onProgressChanged({ connectionRevision: 8, progress: 0.6 });
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('60');
    expect(document.querySelector('[data-action="cancel"]')).not.toBeNull();
    (document.querySelector('[data-action="cancel"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/csv-core', 'cancelOpen', { connectionRevision: 8 }));

    await definition.methods.onConnectionChanged({ ...ready, connectionRevision: 7, fileName: 'stale.csv' });
    expect(document.body.textContent).not.toContain('stale.csv');
  });

  it('keeps prior ready data and form inputs visible when a replacement fails', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return ready;
      if (method === 'getDefaultDirectory') return '/data';
      if (method === 'listDirectory') return { currentPath: '/data', parentPath: '/', entries: [{ name: 'replacement.csv', path: '/data/replacement.csv', kind: 'file', size: 99, modifiedAt: null }] };
      if (method === 'sampleFile') return { ...sampled, path: '/data/replacement.csv', fileName: 'replacement.csv' };
      return undefined;
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen: vi.fn() } });
    await definition.methods.onConnectionChanged({
      ...ready, connectionRevision: 3, phase: 'ready', error: { code: 'CSV_PARSE_FAILED', message: 'CSV 格式无效。' },
    });
    expect(document.body.textContent).toContain('people.csv');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('CSV 格式无效');
    expect((document.querySelector('[data-field="encoding"]') as HTMLSelectElement).value).toBe('utf8');
  });

  it('cancels an indexing attempt while its open request is still pending', async () => {
    let resolveOpen: ((value: unknown) => void) | undefined;
    const pendingOpen = new Promise<unknown>((resolve) => { resolveOpen = resolve; });
    const request = vi.fn(async (_plugin: string, method: string, input?: unknown) => {
      if (method === 'getConnectionState') return closed;
      if (method === 'getDefaultDirectory') return '/data';
      if (method === 'listDirectory') return { currentPath: '/data', parentPath: '/', entries: [{ name: 'people.csv', path: '/data/people.csv', kind: 'file', size: 128, modifiedAt: null }] };
      if (method === 'sampleFile') return sampled;
      if (method === 'openFile') return pendingOpen;
      if (method === 'cancelOpen') return undefined;
      throw new Error(`Unexpected request ${method}:${JSON.stringify(input)}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen: vi.fn() } });
    (document.querySelector('[data-action="browse"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-file-path]')).not.toBeNull());
    (document.querySelector('[data-file-path]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-action="open"]')).not.toBeNull());
    (document.querySelector('[data-action="open"]') as HTMLButtonElement).click();
    await definition.methods.onConnectionChanged({ ...ready, connectionRevision: 8, phase: 'indexing', progress: 0.1 });
    (document.querySelector('[data-action="cancel"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/csv-core', 'cancelOpen', { connectionRevision: 8 }));
    resolveOpen?.({ ...ready, connectionRevision: 8 });
  });

  it('accepts a correlated ready rollback after replacement indexing and clears state after close', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return ready;
      if (method === 'getDefaultDirectory') return '/data';
      if (method === 'listDirectory') return { currentPath: '/data', parentPath: '/', entries: [{ name: 'replacement.csv', path: '/data/replacement.csv', kind: 'file', size: 99, modifiedAt: null }] };
      if (method === 'sampleFile') return { ...sampled, path: '/data/replacement.csv', fileName: 'replacement.csv' };
      return undefined;
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen: vi.fn() } });
    (document.querySelector('[data-action="browse"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-file-path]')).not.toBeNull());
    (document.querySelector('[data-file-path]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('#csv-path')?.textContent).toContain('replacement.csv'));
    await definition.methods.onConnectionChanged({ ...ready, connectionRevision: 3, phase: 'indexing', fileName: 'replacement.csv', progress: .2 });
    await definition.methods.onConnectionChanged(ready);
    expect(document.body.textContent).toContain('people.csv');
    expect(document.querySelector('#csv-path')?.textContent).toContain('replacement.csv');
    (document.querySelector('[data-action="close"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/csv-core', 'getConnectionState', undefined));
    await definition.methods.onConnectionChanged({ ...closed, connectionRevision: 4 });
    expect(document.body.textContent).not.toContain('people.csv');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('uses actual sampled preview values and gives its file dialog keyboard focus management', async () => {
    const setModalOpen = vi.fn();
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return closed;
      if (method === 'getDefaultDirectory') return '/data';
      if (method === 'listDirectory') return { currentPath: '/data', parentPath: '/', entries: [{ name: 'quoted.csv', path: '/data/quoted.csv', kind: 'file', size: 10, modifiedAt: null }] };
      if (method === 'sampleFile') return { ...sampled, path: '/data/quoted.csv', fileName: 'quoted.csv', preview: { cells: ['a,b', 'line one\nline two'], truncated: false } };
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen } });
    const invoker = document.querySelector<HTMLButtonElement>('[data-action="browse"]')!;
    invoker.focus(); invoker.click();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(document.querySelector('[data-action="dismiss"]'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(document.querySelector('[data-action="parent"]'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector('[data-action="browse"]')));
    invoker.click(); await vi.waitFor(() => expect(document.querySelector('[data-file-path]')).not.toBeNull());
    (document.querySelector('[data-file-path]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain('a,b'));
    expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain('line one');
  });

  it('does not let a deferred mount state overwrite a newer connection broadcast', async () => {
    let resolveState: ((value: unknown) => void) | undefined;
    const pending = new Promise<unknown>((resolve) => { resolveState = resolve; });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    const mounting = definition.mount({ message: { request: vi.fn(async (_plugin: string, method: string) => method === 'getConnectionState' ? pending : undefined) }, panel: { setModalOpen: vi.fn() } });
    await definition.methods.onConnectionChanged({ ...ready, connectionRevision: 3, fileName: 'newer.csv' });
    resolveState?.(ready);
    await mounting;
    expect(document.body.textContent).toContain('newer.csv');
  });

  it('closes the sampled file dialog after its deferred request settles and restores usable controls', async () => {
    let resolveSample: ((value: unknown) => void) | undefined;
    const pendingSample = new Promise<unknown>((resolve) => { resolveSample = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return closed;
      if (method === 'getDefaultDirectory') return '/data';
      if (method === 'listDirectory') return { currentPath: '/data', parentPath: null, entries: [{ name: 'people.csv', path: '/data/people.csv', kind: 'file', size: 10, modifiedAt: null }] };
      if (method === 'sampleFile') return pendingSample;
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen: vi.fn() } });
    const browse = document.querySelector<HTMLButtonElement>('[data-action="browse"]')!;
    browse.focus(); browse.click();
    await vi.waitFor(() => expect(document.querySelector('[data-file-path]')).not.toBeNull());
    (document.querySelector('[data-file-path]') as HTMLButtonElement).click();
    resolveSample?.(sampled);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector('[data-action="browse"]')));
    expect((document.querySelector('[data-action="open"]') as HTMLButtonElement).disabled).toBe(false);
    expect((document.querySelector('[data-action="browse"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('refreshes the ruler with the selected parse configuration and ignores stale preview responses', async () => {
    const requests: Array<{ input: unknown; resolve: (value: unknown) => void }> = [];
    const request = vi.fn(async (_plugin: string, method: string, input?: unknown) => {
      if (method === 'getConnectionState') return closed;
      if (method === 'getDefaultDirectory') return '/data';
      if (method === 'listDirectory') return { currentPath: '/data', parentPath: null, entries: [{ name: 'people.csv', path: '/data/people.csv', kind: 'file', size: 10, modifiedAt: null }] };
      if (method === 'sampleFile' && !(input as { encoding?: string }).encoding) return { ...sampled, preview: { cells: ['name', 'city'], truncated: false }, suggestion: { encoding: 'utf8', delimiter: ';', hasHeader: true } };
      if (method === 'sampleFile') return new Promise((resolve) => requests.push({ input, resolve }));
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen: vi.fn() } });
    (document.querySelector('[data-action="browse"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-file-path]')).not.toBeNull());
    (document.querySelector('[data-file-path]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain('name'));
    expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain(';');
    const delimiter = document.querySelector<HTMLSelectElement>('[data-field="delimiter"]')!;
    delimiter.value = ','; delimiter.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].input).toEqual({ path: '/data/people.csv', encoding: 'utf8', delimiter: ',' });
    requests[0].resolve({ ...sampled, preview: { cells: ['name;city'], truncated: false } });
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain('name;city'));
    delimiter.value = '\t'; delimiter.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    delimiter.value = ','; delimiter.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    requests[1].resolve({ ...sampled, preview: { cells: ['stale'], truncated: false } });
    requests[2].resolve({ ...sampled, preview: { cells: ['comma latest'], truncated: false } });
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain('comma latest'));
    expect(document.querySelector('[data-delimiter-ruler]')?.textContent).not.toContain('stale');
    const encoding = document.querySelector<HTMLSelectElement>('[data-field="encoding"]')!;
    encoding.value = 'gb18030'; encoding.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    expect(requests[3].input).toEqual({ path: '/data/people.csv', encoding: 'gb18030', delimiter: ',' });
    requests[3].resolve({ ...sampled, preview: { cells: ['编码列', '值'], truncated: false } });
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain('编码列'));
  });

  it('rejects a deferred preview for file A after file B replaces its sample', async () => {
    let resolvePreviewA: ((value: unknown) => void) | undefined;
    const previewA = new Promise<unknown>((resolve) => { resolvePreviewA = resolve; });
    const request = vi.fn(async (_plugin: string, method: string, input?: unknown) => {
      if (method === 'getConnectionState') return closed;
      if (method === 'getDefaultDirectory') return '/data';
      if (method === 'listDirectory') return { currentPath: '/data', parentPath: null, entries: [
        { name: 'a.csv', path: '/data/a.csv', kind: 'file', size: 10, modifiedAt: null },
        { name: 'b.csv', path: '/data/b.csv', kind: 'file', size: 10, modifiedAt: null },
      ] };
      const requested = input as { path: string; encoding?: string };
      if (method === 'sampleFile' && requested.path === '/data/a.csv' && requested.encoding) return previewA;
      if (method === 'sampleFile' && requested.path === '/data/a.csv') return { ...sampled, path: '/data/a.csv', fileName: 'a.csv', preview: { cells: ['A initial'], truncated: false } };
      if (method === 'sampleFile' && requested.path === '/data/b.csv') return { ...sampled, path: '/data/b.csv', fileName: 'b.csv', preview: { cells: ['B current'], truncated: false } };
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen: vi.fn() } });
    (document.querySelector('[data-action="browse"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-file-path="/data/a.csv"]')).not.toBeNull());
    (document.querySelector('[data-file-path="/data/a.csv"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain('A initial'));
    const delimiter = document.querySelector<HTMLSelectElement>('[data-field="delimiter"]')!;
    delimiter.value = ';'; delimiter.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/csv-core', 'sampleFile', { path: '/data/a.csv', encoding: 'utf8', delimiter: ';' }));
    (document.querySelector('[data-action="browse"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-file-path="/data/b.csv"]')).not.toBeNull());
    (document.querySelector('[data-file-path="/data/b.csv"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain('B current'));
    resolvePreviewA?.({ ...sampled, path: '/data/a.csv', fileName: 'a.csv', preview: { cells: ['A stale'], truncated: false } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain('B current');
    expect(document.querySelector('[data-delimiter-ruler]')?.textContent).not.toContain('A stale');
  });

  it('withholds a failed current preview until a later exact-config preview succeeds', async () => {
    let resolveRecovery: ((value: unknown) => void) | undefined;
    const recovery = new Promise<unknown>((resolve) => { resolveRecovery = resolve; });
    let refreshes = 0;
    const request = vi.fn(async (_plugin: string, method: string, input?: unknown) => {
      if (method === 'getConnectionState') return closed;
      if (method === 'getDefaultDirectory') return '/data';
      if (method === 'listDirectory') return { currentPath: '/data', parentPath: null, entries: [{ name: 'a.csv', path: '/data/a.csv', kind: 'file', size: 10, modifiedAt: null }] };
      if (method === 'sampleFile' && !(input as { encoding?: string }).encoding) return { ...sampled, path: '/data/a.csv', fileName: 'a.csv', preview: { cells: ['old cells'], truncated: false } };
      if (method === 'sampleFile' && ++refreshes === 1) throw new Error('预览读取失败');
      if (method === 'sampleFile') return recovery;
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen: vi.fn() } });
    (document.querySelector('[data-action="browse"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-file-path]')).not.toBeNull());
    (document.querySelector('[data-file-path]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain('old cells'));
    const delimiter = document.querySelector<HTMLSelectElement>('[data-field="delimiter"]')!;
    delimiter.value = ';'; delimiter.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('预览读取失败'));
    expect(document.querySelector('[data-delimiter-ruler]')).toBeNull();
    delimiter.value = ','; delimiter.dispatchEvent(new Event('change', { bubbles: true }));
    resolveRecovery?.({ ...sampled, path: '/data/a.csv', fileName: 'a.csv', preview: { cells: ['recovered'], truncated: false } });
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain('recovered'));
  });
});
