// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as panelAsset from '../../src/routes/panel-asset';

interface TestWindow extends Window {
  harborsFiles?: {
    getPathForFile(file: File): string;
  };
  showSaveFilePicker?: (options: unknown) => Promise<{ getFile(): Promise<File> }>;
}

interface TestPanelFileRuntime {
  openLocal(options?: { accept?: string }): Promise<string | null>;
  saveLocal(options?: { accept?: string; suggestedName?: string }): Promise<string | null>;
}

type RuntimeFactory = (windowObject: TestWindow, documentObject: Document) => TestPanelFileRuntime;

function getRuntimeFactory(): RuntimeFactory {
  const factory = (panelAsset as unknown as { createPanelFileRuntime?: RuntimeFactory }).createPanelFileRuntime;
  expect(factory).toBeTypeOf('function');
  if (!factory) throw new Error('createPanelFileRuntime is not implemented');
  return factory;
}

function createRuntime(windowObject: TestWindow = window as unknown as TestWindow): TestPanelFileRuntime {
  return getRuntimeFactory()(windowObject, document);
}

function defineWindowValue(name: keyof TestWindow, value: unknown): void {
  Object.defineProperty(window, name, { configurable: true, value });
}

describe('panel file runtime', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'harborsFiles');
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });

  it('can execute the exact factory source that is injected into a Panel', () => {
    const factorySource = (panelAsset as unknown as {
      PANEL_FILE_RUNTIME_FACTORY_SOURCE?: string;
    }).PANEL_FILE_RUNTIME_FACTORY_SOURCE;
    expect(factorySource).toBeTypeOf('string');
    if (!factorySource) return;

    const reconstructed = Function(`return (${factorySource});`)() as RuntimeFactory;
    expect(() => reconstructed(window as unknown as TestWindow, document)).not.toThrow();
  });

  it('opens one native file input and resolves the selected local path', async () => {
    const file = new File(['name,age'], 'data.csv', { type: 'text/csv' });
    const getPathForFile = vi.fn(() => '/tmp/data.csv');
    defineWindowValue('harborsFiles', { getPathForFile });
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      expect(this.accept).toBe('.csv,text/csv');
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.dispatchEvent(new Event('change'));
    });

    await expect(createRuntime().openLocal({ accept: '.csv,text/csv' })).resolves.toBe('/tmp/data.csv');

    expect(getPathForFile).toHaveBeenCalledOnce();
    expect(getPathForFile).toHaveBeenCalledWith(file);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('returns null and removes the temporary input when native selection is cancelled', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      this.dispatchEvent(new Event('cancel'));
    });

    await expect(createRuntime().openLocal()).resolves.toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('reports the stable local-only error after a Web user selects a file', async () => {
    const file = new File(['x'], 'data.csv');
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.dispatchEvent(new Event('change'));
    });

    await expect(createRuntime().openLocal()).rejects.toMatchObject({
      code: 'LOCAL_FILE_PATH_UNAVAILABLE',
      message: '该功能只能读取运行 Harbors 的本机文件，请在桌面版中使用。',
    });
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('rejects an empty path returned by the desktop bridge', async () => {
    const file = new File(['x'], 'data.csv');
    defineWindowValue('harborsFiles', { getPathForFile: vi.fn(() => '') });
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.dispatchEvent(new Event('change'));
    });

    await expect(createRuntime().openLocal()).rejects.toMatchObject({
      code: 'LOCAL_FILE_PATH_UNAVAILABLE',
    });
  });

  it('normalizes missing and throwing desktop bridge methods to the stable local-only error', async () => {
    const file = new File(['x'], 'data.csv');
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.dispatchEvent(new Event('change'));
    });

    defineWindowValue('harborsFiles', {});
    await expect(createRuntime().openLocal()).rejects.toMatchObject({
      code: 'LOCAL_FILE_PATH_UNAVAILABLE',
    });

    defineWindowValue('harborsFiles', {
      getPathForFile: vi.fn(() => { throw new Error('electron detail'); }),
    });
    await expect(createRuntime().openLocal()).rejects.toMatchObject({
      code: 'LOCAL_FILE_PATH_UNAVAILABLE',
      message: '该功能只能读取运行 Harbors 的本机文件，请在桌面版中使用。',
    });
  });

  it('resolves the desktop bridge from a Panel parent window and normalizes inaccessible parents', async () => {
    const file = new File(['x'], 'data.csv');
    const getPathForFile = vi.fn(() => '/tmp/parent.csv');
    const panelWindow = { parent: { harborsFiles: { getPathForFile } } } as unknown as TestWindow;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.dispatchEvent(new Event('change'));
    });

    await expect(createRuntime(panelWindow).openLocal()).resolves.toBe('/tmp/parent.csv');
    expect(getPathForFile).toHaveBeenCalledWith(file);

    const inaccessibleParent = {} as TestWindow;
    Object.defineProperty(inaccessibleParent, 'parent', {
      get() { throw new DOMException('cross origin', 'SecurityError'); },
    });
    await expect(createRuntime(inaccessibleParent).openLocal()).rejects.toMatchObject({
      code: 'LOCAL_FILE_PATH_UNAVAILABLE',
    });
  });

  it('rejects save before opening a picker when no desktop path bridge exists', async () => {
    const showSaveFilePicker = vi.fn();
    defineWindowValue('showSaveFilePicker', showSaveFilePicker);

    await expect(createRuntime().saveLocal({ suggestedName: 'new.sqlite' })).rejects.toMatchObject({
      code: 'LOCAL_FILE_PATH_UNAVAILABLE',
      message: '该功能只能读取运行 Harbors 的本机文件，请在桌面版中使用。',
    });
    expect(showSaveFilePicker).not.toHaveBeenCalled();
  });

  it('resolves a save handle File through the same desktop path bridge', async () => {
    const file = new File([], 'data.csv', { type: 'text/csv' });
    const getPathForFile = vi.fn(() => '/tmp/data.csv');
    const getFile = vi.fn(async () => file);
    const showSaveFilePicker = vi.fn(async () => ({ getFile }));
    defineWindowValue('harborsFiles', { getPathForFile });
    defineWindowValue('showSaveFilePicker', showSaveFilePicker);

    await expect(createRuntime().saveLocal({
      accept: 'text/csv,.csv',
      suggestedName: 'data.csv',
    })).resolves.toBe('/tmp/data.csv');

    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: 'data.csv',
      types: [{
        description: 'Supported files',
        accept: { 'text/csv': ['.csv'] },
      }],
    });
    expect(getFile).toHaveBeenCalledOnce();
    expect(getPathForFile).toHaveBeenCalledWith(file);
  });

  it('returns null for native save cancellation and preserves other picker failures', async () => {
    defineWindowValue('harborsFiles', { getPathForFile: vi.fn(() => '/tmp/data.csv') });
    const showSaveFilePicker = vi.fn()
      .mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'))
      .mockRejectedValueOnce(new Error('picker failed'));
    defineWindowValue('showSaveFilePicker', showSaveFilePicker);
    const runtime = createRuntime();

    await expect(runtime.saveLocal()).resolves.toBeNull();
    await expect(runtime.saveLocal()).rejects.toThrow('picker failed');
  });

  it('does not mistake save handle or bridge AbortErrors for picker cancellation', async () => {
    const file = new File([], 'data.csv');
    const getFile = vi.fn()
      .mockRejectedValueOnce(new DOMException('handle failed', 'AbortError'))
      .mockResolvedValueOnce(file);
    const showSaveFilePicker = vi.fn(async () => ({ getFile }));
    defineWindowValue('showSaveFilePicker', showSaveFilePicker);
    defineWindowValue('harborsFiles', {
      getPathForFile: vi.fn(() => { throw new DOMException('bridge failed', 'AbortError'); }),
    });
    const runtime = createRuntime();

    await expect(runtime.saveLocal()).rejects.toThrow('handle failed');
    await expect(runtime.saveLocal()).rejects.toMatchObject({
      code: 'LOCAL_FILE_PATH_UNAVAILABLE',
    });
  });
});
