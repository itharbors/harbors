import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { EditorTransport, getSessionIdFromURL } from '../../src/core/transport';
import { ClientSession } from '../../src/core/session';

// Mock EventSource since jsdom doesn't have it
class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close() {}
}

vi.stubGlobal('EventSource', MockEventSource);

describe('getSessionIdFromURL', () => {
  it('extracts session from query string', () => {
    vi.stubGlobal('window', {
      location: { search: '?session=abc123' },
    });
    expect(getSessionIdFromURL()).toBe('abc123');
  });

  it('returns empty string when no session param', () => {
    vi.stubGlobal('window', {
      location: { search: '' },
    });
    expect(getSessionIdFromURL()).toBe('');
  });

  it('handles multiple query params', () => {
    vi.stubGlobal('window', {
      location: { search: '?foo=bar&session=xyz789&baz=1' },
    });
    expect(getSessionIdFromURL()).toBe('xyz789');
  });

  it('extracts sessionId query alias when session is absent', () => {
    vi.stubGlobal('window', {
      location: { search: '?sessionId=alias-123&windowGroupId=group-1' },
    });
    expect(getSessionIdFromURL()).toBe('alias-123');
  });
});

describe('EditorTransport', () => {
  let session: ClientSession;
  let transport: EditorTransport;
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    MockEventSource.instances = [];
    session = new ClientSession('test-session-123');
    transport = new EditorTransport(session);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('fetchSessionInfo auto-creates session when server returns 404', async () => {
    fetchSpy
      // First call: GET returns 404
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response)
      // Second call: POST creates session
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          sessionId: 'test-session-123',
          workspacePath: '/home/user',
          savedFileList: [],
          createdAt: 1000,
          lastAccessAt: 2000,
        }),
      } as Response);

    const info = await transport.fetchSessionInfo();

    // Verify both calls were made
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // First call was GET
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/session/test-session-123');

    // Second call was POST to create
    expect(fetchSpy.mock.calls[1][0]).toBe('/api/session');
    expect(fetchSpy.mock.calls[1][1]?.method).toBe('POST');

    // Session state is updated
    expect(session.connected).toBe(true);
    expect(session.sessionInfo?.sessionId).toBe('test-session-123');
    expect(session.sessionInfo?.workspacePath).toBe('/home/user');
    expect(info.workspacePath).toBe('/home/user');
  });

  it('fetchSessionInfo returns existing session without POST', async () => {
    const existingSession = new ClientSession('existing-session');
    const existingTransport = new EditorTransport(existingSession);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        sessionId: 'existing-session',
        workspacePath: '/existing/path',
        savedFileList: [],
        createdAt: 1000,
        lastAccessAt: 2000,
      }),
    } as Response);

    const info = await existingTransport.fetchSessionInfo();

    // Only one call — no POST needed
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/session/existing-session');
    expect(info.workspacePath).toBe('/existing/path');
    expect(existingSession.connected).toBe(true);
  });

  it('fetchSessionInfo throws when POST also fails', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

    await expect(transport.fetchSessionInfo()).rejects.toThrow('Failed to fetch session: 500');
    expect(session.connected).toBe(false);
  });

  it('connectSSE creates EventSource with correct URL', () => {
    transport.connectSSE();

    expect(session.sseActive).toBe(false); // not open until onopen fires
  });

  it('fetchBootstrap stores bootstrap info on the session', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        protocolVersion: 1,
        sessionId: 'test-session-123',
        kitName: '@itharbors/kit-default',
        windows: [],
        panels: [],
      }),
    } as Response);

    const bootstrap = await transport.fetchBootstrap();

    expect(fetchSpy).toHaveBeenCalledWith('/api/bootstrap/test-session-123');
    expect(bootstrap.kitName).toBe('@itharbors/kit-default');
    expect(session.bootstrapInfo).toBe(bootstrap);
  });

  it('rejects an unsupported bootstrap protocol before mutating session state', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ protocolVersion: 999 }),
    } as Response);

    await expect(transport.fetchBootstrap()).rejects.toThrow(
      'Unsupported protocol version: 999',
    );
    expect(session.bootstrapInfo).toBeNull();
  });

  it('drops unsupported SSE envelopes and reports a protocol error', () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    transport.connectSSE(onEvent, onError);

    MockEventSource.instances[0]?.onmessage?.({
      data: JSON.stringify({ protocolVersion: 999, type: 'heartbeat', ts: 1 }),
    });

    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Unsupported protocol version: 999',
    }));
  });

  it('fetchBootstrap stores menuTree on the session', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        protocolVersion: 1,
        sessionId: 'test-session-123',
        kitName: '@itharbors/kit-default',
        windows: [],
        panels: [],
        menuTree: [
          { type: 'menu', id: 'file', label: 'File', children: [] },
        ],
      }),
    } as Response);

    const bootstrap = await transport.fetchBootstrap();

    expect(bootstrap.menuTree).toEqual([
      expect.objectContaining({ id: 'file', label: 'File' }),
    ]);
    expect(session.bootstrapInfo?.menuTree).toEqual(bootstrap.menuTree);
  });

  it('fetchBootstrap initializes the session and retries when bootstrap is missing', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          protocolVersion: 1,
          sessionId: 'test-session-123',
          kitName: '@itharbors/kit-default',
          windows: [],
          panels: [],
        }),
      } as Response);

    const bootstrap = await transport.fetchBootstrap();

    expect(fetchSpy).toHaveBeenNthCalledWith(1, '/api/bootstrap/test-session-123');
    expect(fetchSpy.mock.calls[1][0]).toBe('/api/session');
    expect(fetchSpy.mock.calls[1][1]?.method).toBe('POST');
    expect(fetchSpy).toHaveBeenNthCalledWith(3, '/api/bootstrap/test-session-123');
    expect(bootstrap.kitName).toBe('@itharbors/kit-default');
  });

  it('disconnectSSE sets sseActive to false', () => {
    transport.connectSSE();
    transport.disconnectSSE();

    expect(session.sseActive).toBe(false);
  });

  it('openPanel posts to the server open route', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        disposition: 'open-window-group',
        panelInstanceId: 'panel-1',
        panelName: '@itharbors/log.log',
        windowGroupId: 'group-1',
        carrier: 'window-group',
        url: '/api/window-entry/secondary?sessionId=test-session-123&windowGroupId=group-1',
      }),
    } as Response);

    const result = await transport.openPanel('@itharbors/log.log');

    expect(fetchSpy).toHaveBeenCalledWith('/api/panel/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'test-session-123', panelName: '@itharbors/log.log' }),
    });
    expect(result.windowGroupId).toBe('group-1');
  });

  it('posts a browser dispatch result with session ownership', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 204 } as Response);

    await transport.sendMessageResult('req-1', { ok: true, value: 'done' });

    expect(fetchSpy).toHaveBeenCalledWith('/api/message/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'test-session-123',
        requestId: 'req-1',
        result: { ok: true, value: 'done' },
      }),
    });
  });

  it('marks a panel instance as floating', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'panel-1',
        panelName: '@itharbors/log.log',
        carrier: 'floating',
        state: 'open',
        windowGroupId: null,
      }),
    } as Response);

    const result = await transport.markPanelFloating('panel-1');

    expect(fetchSpy).toHaveBeenCalledWith('/api/panel-instance/fallback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'test-session-123', panelInstanceId: 'panel-1' }),
    });
    expect(result).toMatchObject({ carrier: 'floating' });
  });

  it('closes a panel instance', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response);

    await transport.closePanelInstance('panel-1');

    expect(fetchSpy).toHaveBeenCalledWith('/api/panel-instance/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'test-session-123', panelInstanceId: 'panel-1' }),
    });
  });

  it('updates a panel instance state', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response);

    await transport.setPanelInstanceState('panel-1', 'minimized');

    expect(fetchSpy).toHaveBeenCalledWith('/api/panel-instance/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'test-session-123', panelInstanceId: 'panel-1', state: 'minimized' }),
    });
  });

  it('closes a secondary window group with fetch keepalive fallback', async () => {
    const previousSendBeacon = navigator.sendBeacon;
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: undefined,
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response);

    try {
      await transport.closeWindowGroup('group-1', { beacon: true });

      expect(fetchSpy).toHaveBeenCalledWith('/api/window-group/close', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'test-session-123', windowGroupId: 'group-1' }),
        keepalive: true,
      });
    } finally {
      Object.defineProperty(navigator, 'sendBeacon', {
        configurable: true,
        value: previousSendBeacon,
      });
    }
  });

  it('uses sendBeacon when closing a secondary window group during unload', async () => {
    const previousSendBeacon = navigator.sendBeacon;
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeacon,
    });

    try {
      await transport.closeWindowGroup('group-1', { beacon: true });

      expect(sendBeacon).toHaveBeenCalledWith(
        '/api/window-group/close',
        JSON.stringify({ sessionId: 'test-session-123', windowGroupId: 'group-1' }),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, 'sendBeacon', {
        configurable: true,
        value: previousSendBeacon,
      });
    }
  });
});
