import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mountMenuRuntime } from '../../src/menu/runtime';

describe('mountMenuRuntime', () => {
  const syncMenu = vi.fn();
  const dispose = vi.fn();
  const openExternalUrl = vi.fn();
  let handler: ((payload: { sessionId: string; menuId: string }) => void | Promise<void>) | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;
  let windowOpenSpy: {
    mockRestore(): void;
    mockReturnValue(value: Window | null): unknown;
    mockReturnValueOnce(value: Window | null): unknown;
  };
  let postMessageSpy: {
    mockRestore(): void;
  };
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    syncMenu.mockClear();
    dispose.mockClear();
    openExternalUrl.mockReset();
    openExternalUrl.mockResolvedValue(undefined);
    handler = null;
    fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response));
    windowOpenSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.stubGlobal('fetch', fetchMock);
    (window as typeof window & {
      electronMenu?: {
        syncMenu: typeof syncMenu;
        onMenuAction(next: typeof handler): () => void;
        openExternalUrl(url: string): Promise<void>;
      };
    }).electronMenu = {
      syncMenu,
      onMenuAction(next) {
        handler = next;
        return dispose;
      },
      openExternalUrl,
    };
  });

  afterEach(() => {
    delete (window as typeof window & { electronMenu?: unknown }).electronMenu;
    windowOpenSpy.mockRestore();
    postMessageSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('syncs menu tree and forwards menuId to /api/menu/trigger', async () => {
    const menuTree = [{ type: 'menu' as const, id: 'file', label: 'File', children: [] }];
    const runtime = mountMenuRuntime({
      sessionId: 's1',
      menuTree,
    });

    expect(syncMenu).toHaveBeenCalledWith({
      sessionId: 's1',
      menuTree,
    });

    await handler?.({ sessionId: 's1', menuId: 'file/new-session' });

    expect(fetchMock).toHaveBeenCalledWith('/api/menu/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', menuId: 'file/new-session' }),
    });

    runtime.dispose();
    expect(dispose).toHaveBeenCalled();
  });

  it('opens a panel window from menu trigger openPanel results', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          disposition: 'open-window-group',
          panelInstanceId: 'panel-1',
          panelName: '@itharbors/log.log',
          windowGroupId: 'wg-1',
          carrier: 'window-group',
          url: '/api/window-entry/secondary?sessionId=s1&windowGroupId=wg-1',
        },
      }),
    } as Response);
    mountMenuRuntime({
      sessionId: 's1',
      menuTree: [],
    });

    await handler?.({ sessionId: 's1', menuId: 'view/panels/ce-log-log' });

    expect(windowOpenSpy).toHaveBeenCalledWith(
      '/api/window-entry/secondary?sessionId=s1&windowGroupId=wg-1',
      '_ce_wg-1',
    );
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: 'ce-open-panel-result',
      payload: expect.objectContaining({
        panelInstanceId: 'panel-1',
        panelName: '@itharbors/log.log',
      }),
    }, '*');
  });

  it('falls back to a floating panel when menu-triggered window open is blocked', async () => {
    windowOpenSpy.mockReturnValueOnce(null);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            disposition: 'open-window-group',
            panelInstanceId: 'panel-1',
            panelName: '@itharbors/log.log',
            windowGroupId: 'wg-1',
            carrier: 'window-group',
            url: '/api/window-entry/secondary?sessionId=s1&windowGroupId=wg-1',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'panel-1',
          panelName: '@itharbors/log.log',
          state: 'open',
          carrier: 'floating',
          windowGroupId: null,
        }),
      } as Response);
    mountMenuRuntime({
      sessionId: 's1',
      menuTree: [],
    });

    await handler?.({ sessionId: 's1', menuId: 'view/panels/ce-log-log' });

    expect(fetchMock).toHaveBeenLastCalledWith('/api/panel-instance/fallback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', panelInstanceId: 'panel-1' }),
    });
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: 'ce-open-panel-floating',
      payload: expect.objectContaining({
        id: 'panel-1',
        panelName: '@itharbors/log.log',
      }),
    }, '*');
  });

  it('opens the current page externally from menu trigger results', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          type: 'open-current-url',
        },
      }),
    } as Response);
    mountMenuRuntime({
      sessionId: 's1',
      menuTree: [],
    });

    await handler?.({ sessionId: 's1', menuId: 'file/open-current-page-in-browser' });

    expect(openExternalUrl).toHaveBeenCalledWith(window.location.href);
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });

  it('falls back to opening a new tab when external browser bridge is unavailable', async () => {
    delete (window as typeof window & { electronMenu?: { openExternalUrl?: unknown } }).electronMenu?.openExternalUrl;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          type: 'open-current-url',
        },
      }),
    } as Response);
    mountMenuRuntime({
      sessionId: 's1',
      menuTree: [],
    });

    await handler?.({ sessionId: 's1', menuId: 'file/open-current-page-in-browser' });

    expect(windowOpenSpy).toHaveBeenCalledWith(window.location.href, '_blank', 'noopener,noreferrer');
  });

  it('ignores Electron menu actions for another session', async () => {
    mountMenuRuntime({
      sessionId: 's1',
      menuTree: [],
    });

    await handler?.({ sessionId: 's2', menuId: 'file/new-session' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('catches failed menu trigger responses', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);
    mountMenuRuntime({
      sessionId: 's1',
      menuTree: [],
    });

    await expect(handler?.({ sessionId: 's1', menuId: 'file/new-session' })).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to trigger menu action',
      expect.objectContaining({ message: 'Failed to trigger menu action: 500' }),
    );
  });

  it('catches rejected menu trigger requests', async () => {
    const error = new Error('network unavailable');
    fetchMock.mockRejectedValueOnce(error);
    mountMenuRuntime({
      sessionId: 's1',
      menuTree: [],
    });

    await expect(handler?.({ sessionId: 's1', menuId: 'file/new-session' })).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to trigger menu action', error);
  });
});
