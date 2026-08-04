// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): void;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

type FileRuntime = {
  openLocal: ReturnType<typeof vi.fn>;
};

const closed = {
  connectionRevision: 0, phase: 'closed', path: null, fileName: null,
  encoding: null, delimiter: null, hasHeader: null, progress: null, error: null,
  byteSize: null, rowCount: null, columnCount: null, irregularRowCount: null,
};
const sampled = {
  path: '/data/people.csv', fileName: 'people.csv', size: 128,
  modifiedAt: '2026-07-24T00:00:00.000Z',
  suggestion: { encoding: 'utf8' as const, delimiter: ',' as const, hasHeader: true },
  preview: { cells: ['name', 'city'], truncated: false },
};
const ready = {
  connectionRevision: 2, phase: 'ready' as const, path: '/data/people.csv',
  fileName: 'people.csv', encoding: 'utf8' as const, delimiter: ',' as const,
  hasHeader: true, progress: 1, error: null, byteSize: 128, rowCount: 2,
  columnCount: 2, irregularRowCount: 1,
};

describe('CSV connection panel', () => {
  let mountedDefinition: PanelDefinition | undefined;

  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  afterEach(() => {
    mountedDefinition?.unmount();
    mountedDefinition = undefined;
  });

  async function mountPanel(options: {
    request: ReturnType<typeof vi.fn>;
    file?: FileRuntime;
    setModalOpen?: ReturnType<typeof vi.fn>;
  }): Promise<PanelDefinition> {
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    mountedDefinition = definition;
    await definition.mount({
      message: { request: options.request },
      file: options.file ?? createFileRuntime(),
      panel: { setModalOpen: options.setModalOpen ?? vi.fn() },
    });
    return definition;
  }

  it('samples a native file selection then explicitly opens the chosen parse configuration', async () => {
    const file = createFileRuntime('/data/people.csv');
    const setModalOpen = vi.fn();
    const request = vi.fn(async (_plugin: string, method: string, input?: unknown) => {
      if (method === 'getConnectionState') return closed;
      if (method === 'sampleFile') return sampled;
      if (method === 'openFile') return ready;
      throw new Error(`Unexpected request ${method}:${JSON.stringify(input)}`);
    });
    await mountPanel({ request, file, setModalOpen });

    (document.querySelector('[data-action="browse"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(file.openLocal).toHaveBeenCalledWith({
        accept: '.csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain',
      });
      expect(request).toHaveBeenCalledWith('@itharbors/csv-core', 'sampleFile', {
        path: '/data/people.csv',
      });
      expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain(',');
    });
    expect(setModalOpen).not.toHaveBeenCalledWith(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    (document.querySelector('[data-action="open"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/csv-core', 'openFile', {
      path: '/data/people.csv', encoding: 'utf8', delimiter: ',', hasHeader: true,
    }));
    await vi.waitFor(() => expect(document.body.textContent).toContain('2 行'));
    expect(document.body.textContent).toContain('不规则记录 1');
  });

  it('treats native picker cancellation as a no-op and restores the browse control', async () => {
    const file = createFileRuntime(null);
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return closed;
      throw new Error(`Unexpected request ${method}`);
    });
    await mountPanel({ request, file });
    const browse = document.querySelector<HTMLButtonElement>('[data-action="browse"]')!;
    browse.focus();
    browse.click();

    await vi.waitFor(() => {
      expect(file.openLocal).toHaveBeenCalledOnce();
      expect((document.querySelector('[data-action="browse"]') as HTMLButtonElement).disabled)
        .toBe(false);
      expect(document.activeElement).toBe(document.querySelector('[data-action="browse"]'));
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows the shared local-only error without calling a legacy directory API', async () => {
    const file = createFileRuntime();
    file.openLocal.mockRejectedValue(Object.assign(new Error(
      '该功能只能读取运行 Harbors 的本机文件，请在桌面版中使用。',
    ), { code: 'LOCAL_FILE_PATH_UNAVAILABLE' }));
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return closed;
      throw new Error(`Unexpected request ${method}`);
    });
    await mountPanel({ request, file });

    (document.querySelector('[data-action="browse"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      '该功能只能读取运行 Harbors 的本机文件，请在桌面版中使用。',
    ));
    expect(document.querySelector('[role="alert"]')?.closest('.instrument-strip')).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('renders indexing progress, cancels with its current revision, and ignores stale broadcasts', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getConnectionState' ? closed : undefined
    ));
    const definition = await mountPanel({ request });
    await definition.methods.onConnectionChanged({
      ...ready, phase: 'indexing', connectionRevision: 8, progress: 0.2,
    });
    await definition.methods.onProgressChanged({ connectionRevision: 8, progress: 0.6 });
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('60');
    (document.querySelector('[data-action="cancel"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/csv-core', 'cancelOpen', { connectionRevision: 8 },
    ));

    await definition.methods.onConnectionChanged({
      ...ready, connectionRevision: 7, fileName: 'stale.csv',
    });
    expect(document.body.textContent).not.toContain('stale.csv');
  });

  it('keeps prior ready data and form inputs visible when a replacement fails', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getConnectionState' ? ready : undefined
    ));
    const definition = await mountPanel({ request });
    await definition.methods.onConnectionChanged({
      ...ready,
      connectionRevision: 3,
      phase: 'ready',
      error: { code: 'CSV_PARSE_FAILED', message: 'CSV 格式无效。' },
    });

    expect(document.body.textContent).toContain('people.csv');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('CSV 格式无效');
    expect((document.querySelector('[data-field="encoding"]') as HTMLSelectElement).value)
      .toBe('utf8');
  });

  it('cancels an indexing attempt while its open request is still pending', async () => {
    let resolveOpen: ((value: unknown) => void) | undefined;
    const pendingOpen = new Promise<unknown>((resolve) => { resolveOpen = resolve; });
    const file = createFileRuntime('/data/people.csv');
    const request = vi.fn(async (_plugin: string, method: string, input?: unknown) => {
      if (method === 'getConnectionState') return closed;
      if (method === 'sampleFile') return sampled;
      if (method === 'openFile') return pendingOpen;
      if (method === 'cancelOpen') return undefined;
      throw new Error(`Unexpected request ${method}:${JSON.stringify(input)}`);
    });
    const definition = await mountPanel({ request, file });
    (document.querySelector('[data-action="browse"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-action="open"]')).not.toBeNull());
    (document.querySelector('[data-action="open"]') as HTMLButtonElement).click();
    await definition.methods.onConnectionChanged({
      ...ready, connectionRevision: 8, phase: 'indexing', progress: 0.1,
    });
    (document.querySelector('[data-action="cancel"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/csv-core', 'cancelOpen', { connectionRevision: 8 },
    ));
    resolveOpen?.({ ...ready, connectionRevision: 8 });
  });

  it('accepts a correlated ready rollback after replacement indexing and clears state after close', async () => {
    const file = createFileRuntime('/data/replacement.csv');
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return ready;
      if (method === 'sampleFile') {
        return { ...sampled, path: '/data/replacement.csv', fileName: 'replacement.csv' };
      }
      return undefined;
    });
    const definition = await mountPanel({ request, file });
    (document.querySelector('[data-action="browse"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('#csv-path')?.textContent).toContain(
      'replacement.csv',
    ));
    await definition.methods.onConnectionChanged({
      ...ready, connectionRevision: 3, phase: 'indexing',
      fileName: 'replacement.csv', progress: 0.2,
    });
    await definition.methods.onConnectionChanged(ready);
    expect(document.body.textContent).toContain('people.csv');
    expect(document.querySelector('#csv-path')?.textContent).toContain('replacement.csv');
    (document.querySelector('[data-action="close"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/csv-core', 'getConnectionState', undefined,
    ));
    await definition.methods.onConnectionChanged({ ...closed, connectionRevision: 4 });
    expect(document.body.textContent).not.toContain('people.csv');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('uses actual sampled preview values and restores controls after a deferred sample', async () => {
    let resolveSample: ((value: unknown) => void) | undefined;
    const pendingSample = new Promise<unknown>((resolve) => { resolveSample = resolve; });
    const file = createFileRuntime('/data/quoted.csv');
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return closed;
      if (method === 'sampleFile') return pendingSample;
      throw new Error(`Unexpected request ${method}`);
    });
    await mountPanel({ request, file });
    const browse = document.querySelector<HTMLButtonElement>('[data-action="browse"]')!;
    browse.focus();
    browse.click();
    await vi.waitFor(() => expect(file.openLocal).toHaveBeenCalledOnce());
    resolveSample?.({
      ...sampled,
      path: '/data/quoted.csv',
      fileName: 'quoted.csv',
      preview: { cells: ['a,b', 'line one\nline two'], truncated: false },
    });

    await vi.waitFor(() => {
      expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain('a,b');
      expect((document.querySelector('[data-action="open"]') as HTMLButtonElement).disabled)
        .toBe(false);
      expect(document.activeElement).toBe(document.querySelector('[data-action="browse"]'));
    });
    expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain('line one');
  });

  it('does not let a deferred mount state overwrite a newer connection broadcast', async () => {
    let resolveState: ((value: unknown) => void) | undefined;
    const pending = new Promise<unknown>((resolve) => { resolveState = resolve; });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    mountedDefinition = definition;
    const mounting = definition.mount({
      message: {
        request: vi.fn(async (_plugin: string, method: string) => (
          method === 'getConnectionState' ? pending : undefined
        )),
      },
      file: createFileRuntime(),
      panel: { setModalOpen: vi.fn() },
    });
    await definition.methods.onConnectionChanged({
      ...ready, connectionRevision: 3, fileName: 'newer.csv',
    });
    resolveState?.(ready);
    await mounting;
    expect(document.body.textContent).toContain('newer.csv');
  });

  it('refreshes the ruler with the selected parse configuration and ignores stale responses', async () => {
    const requests: Array<{ input: unknown; resolve: (value: unknown) => void }> = [];
    const file = createFileRuntime('/data/people.csv');
    const request = vi.fn(async (_plugin: string, method: string, input?: unknown) => {
      if (method === 'getConnectionState') return closed;
      if (method === 'sampleFile' && !(input as { encoding?: string }).encoding) {
        return {
          ...sampled,
          preview: { cells: ['name', 'city'], truncated: false },
          suggestion: { encoding: 'utf8', delimiter: ';', hasHeader: true },
        };
      }
      if (method === 'sampleFile') {
        return new Promise((resolve) => requests.push({ input, resolve }));
      }
      throw new Error(`Unexpected request ${method}`);
    });
    await mountPanel({ request, file });
    (document.querySelector('[data-action="browse"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent)
      .toContain('name'));
    const delimiter = document.querySelector<HTMLSelectElement>('[data-field="delimiter"]')!;
    delimiter.value = ',';
    delimiter.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].input).toEqual({
      path: '/data/people.csv', encoding: 'utf8', delimiter: ',',
    });
    requests[0].resolve({ ...sampled, preview: { cells: ['name;city'], truncated: false } });
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent)
      .toContain('name;city'));

    delimiter.value = '\t';
    delimiter.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    delimiter.value = ',';
    delimiter.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    requests[1].resolve({ ...sampled, preview: { cells: ['stale'], truncated: false } });
    requests[2].resolve({ ...sampled, preview: { cells: ['comma latest'], truncated: false } });
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent)
      .toContain('comma latest'));
    expect(document.querySelector('[data-delimiter-ruler]')?.textContent).not.toContain('stale');
  });

  it('rejects a deferred preview for file A after file B replaces its sample', async () => {
    let resolvePreviewA: ((value: unknown) => void) | undefined;
    const previewA = new Promise<unknown>((resolve) => { resolvePreviewA = resolve; });
    const file = createFileRuntime('/data/a.csv', '/data/b.csv');
    const request = vi.fn(async (_plugin: string, method: string, input?: unknown) => {
      if (method === 'getConnectionState') return closed;
      const requested = input as { path: string; encoding?: string };
      if (method === 'sampleFile' && requested.path === '/data/a.csv' && requested.encoding) {
        return previewA;
      }
      if (method === 'sampleFile' && requested.path === '/data/a.csv') {
        return {
          ...sampled, path: '/data/a.csv', fileName: 'a.csv',
          preview: { cells: ['A initial'], truncated: false },
        };
      }
      if (method === 'sampleFile' && requested.path === '/data/b.csv') {
        return {
          ...sampled, path: '/data/b.csv', fileName: 'b.csv',
          preview: { cells: ['B current'], truncated: false },
        };
      }
      throw new Error(`Unexpected request ${method}`);
    });
    await mountPanel({ request, file });
    (document.querySelector('[data-action="browse"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent)
      .toContain('A initial'));
    const delimiter = document.querySelector<HTMLSelectElement>('[data-field="delimiter"]')!;
    delimiter.value = ';';
    delimiter.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/csv-core', 'sampleFile',
      { path: '/data/a.csv', encoding: 'utf8', delimiter: ';' },
    ));
    (document.querySelector('[data-action="browse"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent)
      .toContain('B current'));
    resolvePreviewA?.({
      ...sampled, path: '/data/a.csv', fileName: 'a.csv',
      preview: { cells: ['A stale'], truncated: false },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('[data-delimiter-ruler]')?.textContent).toContain('B current');
    expect(document.querySelector('[data-delimiter-ruler]')?.textContent).not.toContain('A stale');
  });

  it('withholds a failed current preview until a later exact-config preview succeeds', async () => {
    let resolveRecovery: ((value: unknown) => void) | undefined;
    const recovery = new Promise<unknown>((resolve) => { resolveRecovery = resolve; });
    let refreshes = 0;
    const file = createFileRuntime('/data/a.csv');
    const request = vi.fn(async (_plugin: string, method: string, input?: unknown) => {
      if (method === 'getConnectionState') return closed;
      if (method === 'sampleFile' && !(input as { encoding?: string }).encoding) {
        return {
          ...sampled, path: '/data/a.csv', fileName: 'a.csv',
          preview: { cells: ['old cells'], truncated: false },
        };
      }
      if (method === 'sampleFile' && ++refreshes === 1) throw new Error('预览读取失败');
      if (method === 'sampleFile') return recovery;
      throw new Error(`Unexpected request ${method}`);
    });
    await mountPanel({ request, file });
    (document.querySelector('[data-action="browse"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent)
      .toContain('old cells'));
    const delimiter = document.querySelector<HTMLSelectElement>('[data-field="delimiter"]')!;
    delimiter.value = ';';
    delimiter.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('预览读取失败'));
    expect(document.querySelector('[data-delimiter-ruler]')).toBeNull();
    delimiter.value = ',';
    delimiter.dispatchEvent(new Event('change', { bubbles: true }));
    resolveRecovery?.({
      ...sampled, path: '/data/a.csv', fileName: 'a.csv',
      preview: { cells: ['recovered'], truncated: false },
    });
    await vi.waitFor(() => expect(document.querySelector('[data-delimiter-ruler]')?.textContent)
      .toContain('recovered'));
  });
});

function createFileRuntime(...paths: Array<string | null>): FileRuntime {
  const queue = [...paths];
  return {
    openLocal: vi.fn(async () => queue.shift() ?? null),
  };
}
