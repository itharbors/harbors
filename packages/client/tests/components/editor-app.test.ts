import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
}

vi.stubGlobal('EventSource', MockEventSource);
vi.stubGlobal('crypto', { randomUUID: () => 'mock-uuid-1234' });

// Mock location
Object.defineProperty(window, 'location', {
  value: {
    search: '?session=existing-id',
    href: 'http://localhost:8080/?session=existing-id',
  },
  writable: true,
  configurable: true,
});

// Mock history
vi.stubGlobal('history', { replaceState: vi.fn() });

const bootstrapPayload = {
  protocolVersion: 1,
  sessionId: 'existing-id',
  kitName: '@itharbors/kit-default',
  menuTree: [
    {
      type: 'menu',
      id: 'file',
      label: 'File',
      children: [],
    },
  ],
  i18n: {
    locale: 'zh-CN',
    defaultLocale: 'zh-CN',
    version: 1,
    currentMessages: {},
    defaultMessages: {},
  },
  windows: [{
    id: 'default-main',
    kind: 'main',
    type: 'panel-area',
    entry: 'main.html',
    state: 'open',
    panelInstanceIds: [],
    layout: {
      type: 'vsplit',
      sizes: [40, 1],
      children: [
        { type: 'leaf', panel: '@ce/status-bar.status', panelType: 'simple' },
        {
          type: 'hsplit',
          sizes: [260, 1],
          children: [
            { type: 'leaf', panel: '@ce/plugin-list.list' },
            {
              type: 'tab',
              activeIndex: 0,
              children: [
                { type: 'leaf', panel: '@ce/log.log' },
                { type: 'leaf', panel: '@ce/message-debug.debug' },
              ],
            },
          ],
        },
      ],
    },
  }],
  panelInstances: [],
  panels: [
    {
      name: '@ce/status-bar.status',
      entry: '/api/assets/panel/%40ce%2Fstatus-bar.status/index.html',
    },
    {
      name: '@ce/plugin-list.list',
      entry: '/api/assets/panel/%40ce%2Fplugin-list.list/index.html',
    },
    {
      name: '@ce/log.log',
      entry: '/api/assets/panel/%40ce%2Flog.log/index.html',
    },
    {
      name: '@ce/message-debug.debug',
      entry: '/api/assets/panel/%40ce%2Fmessage-debug.debug/index.html',
    },
  ],
};

const sessionPayload = {
  sessionId: 'existing-id',
  workspacePath: '/test/workspace',
  savedFileList: [],
  createdAt: 1000,
  lastAccessAt: 2000,
};

function createJsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let bootstrapResponse = () => Promise.resolve(createJsonResponse(bootstrapPayload));

// Mock fetch to return session + bootstrap data.
const mockFetch = vi.fn((url: string) => {
  if (url.startsWith('/api/bootstrap/')) {
    return bootstrapResponse();
  }

  return Promise.resolve(createJsonResponse(sessionPayload));
});
vi.stubGlobal('fetch', mockFetch);

// Register layout components before importing editor-app
import '../../src/layout/split-pane';
import '../../src/layout/divider';
import '../../src/layout/panel';
import '../../src/layout/panel-group';
import '../../src/components/editor-app';
import '../../src/components/window-group-app';
import type { EditorApp } from '../../src/components/editor-app';

const PointerEventCtor = window.PointerEvent ?? MouseEvent;

describe('EditorApp default layout', () => {
  let el: EditorApp;

  beforeEach(() => {
    mockFetch.mockClear();
    MockEventSource.instances.length = 0;
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.location.search = '?session=existing-id';
    window.location.href = 'http://localhost:8080/?session=existing-id';
    bootstrapResponse = () => Promise.resolve(createJsonResponse(bootstrapPayload));
  });

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });

  async function waitForBootstrap() {
    for (let i = 0; i < 10; i += 1) {
      if (
        mockFetch.mock.calls.some((call) => call[0] === '/api/bootstrap/existing-id')
        && el?.querySelector('ce-panel-group')
      ) {
        await Promise.resolve();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('bootstrap was not fetched');
  }

  function mockRect(element: Element, rect: Partial<DOMRect>) {
    (element as HTMLElement).getBoundingClientRect = () => ({
      x: rect.left ?? 0,
      y: rect.top ?? 0,
      top: rect.top ?? 0,
      left: rect.left ?? 0,
      right: rect.right ?? 0,
      bottom: rect.bottom ?? 0,
      width: (rect.right ?? 0) - (rect.left ?? 0),
      height: (rect.bottom ?? 0) - (rect.top ?? 0),
      toJSON: () => ({}),
    } as DOMRect);
  }

  it('renders outer column split-pane', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const outer = el.querySelector('ce-split-pane') as HTMLElement | null;
    expect(outer).not.toBeNull();
    expect(outer!.getAttribute('direction')).toBe('column');
    expect(outer!.style.getPropertyValue('--ce-workbench-bg')).toBe('var(--ce-surface)');
    expect(outer!.style.padding).toBe('var(--ce-workbench-padding, 0)');
    expect(outer!.style.getPropertyValue('--split-gap')).toBe('var(--ce-workbench-gap, 0)');
    expect(outer!.style.background).toBe('var(--ce-workbench-bg, var(--ce-surface, #1a1a1a))');
  });

  it('applies kit theme tokens to layout chrome', async () => {
    bootstrapResponse = () => Promise.resolve(createJsonResponse({
      ...bootstrapPayload,
      theme: {
        '--ce-workbench-bg': 'radial-gradient(circle at 18% 10%, rgba(34,211,238,0.13), transparent 30%), radial-gradient(circle at 78% 6%, rgba(59,130,246,0.11), transparent 34%), linear-gradient(180deg, #07101d 0%, #050913 56%, #030711 100%)',
        '--ce-workbench-padding': '8px',
        '--ce-workbench-gap': '8px',
        '--ce-tabbar-bg': 'transparent',
        '--ce-tab-bg-active': 'rgba(8,17,31,0.46)',
        '--ce-tab-active-indicator': '#22d3ee',
      },
    }));

    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const outer = el.querySelector('ce-split-pane') as HTMLElement;
    expect(outer.style.getPropertyValue('--ce-workbench-bg')).toContain('radial-gradient(circle at 18% 10%');
    expect(outer.style.getPropertyValue('--ce-workbench-padding')).toBe('8px');
    expect(outer.style.getPropertyValue('--ce-workbench-gap')).toBe('8px');
    expect(outer.style.getPropertyValue('--ce-tabbar-bg')).toBe('transparent');
    expect(outer.style.getPropertyValue('--ce-tab-bg-active')).toBe('rgba(8,17,31,0.46)');
    expect(outer.style.getPropertyValue('--ce-tab-active-indicator')).toBe('#22d3ee');
  });

  it('only toggles full-workspace modality for the panel iframe that sent the message', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const firstPanel = el.querySelector<HTMLElement>('ce-panel[data-panel-name="@ce/plugin-list.list"]')!;
    const secondPanel = el.querySelector<HTMLElement>('ce-panel[data-panel-name="@ce/log.log"]')!;
    const firstFrame = firstPanel.shadowRoot!.querySelector('iframe')!;
    const secondFrame = secondPanel.shadowRoot!.querySelector('iframe')!;
    const firstSource = {} as WindowProxy;
    const secondSource = {} as WindowProxy;
    Object.defineProperty(firstFrame, 'contentWindow', { configurable: true, value: firstSource });
    Object.defineProperty(secondFrame, 'contentWindow', { configurable: true, value: secondSource });

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'ce-panel-modal-state', open: true },
      source: secondSource,
    }));

    expect(firstPanel.hasAttribute('modal-open')).toBe(false);
    expect(secondPanel.hasAttribute('modal-open')).toBe(true);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'ce-panel-modal-state', open: true },
      source: {} as WindowProxy,
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'ce-panel-modal-state', open: false },
      source: window,
    }));

    expect(firstPanel.hasAttribute('modal-open')).toBe(false);
    expect(secondPanel.hasAttribute('modal-open')).toBe(true);
  });

  it('renders the window group selected by windowGroupId from a secondary URL', async () => {
    window.location.search = '?sessionId=existing-id&windowGroupId=secondary-window';
    window.location.href = 'http://localhost:8080/?sessionId=existing-id&windowGroupId=secondary-window';
    bootstrapResponse = () => Promise.resolve(createJsonResponse({
      ...bootstrapPayload,
      windows: [
        bootstrapPayload.windows[0],
        {
          id: 'secondary-window',
          kind: 'secondary',
          type: 'panel-area',
          entry: 'secondary.html',
          state: 'open',
          panelInstanceIds: [],
          layout: { type: 'leaf', panel: '@ce/log.log' },
        },
      ],
    }));

    el = document.createElement('window-group-app') as unknown as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const group = el.querySelector('ce-panel-group') as HTMLElement | null;
    expect(group?.dataset.windowId).toBe('secondary-window');
    expect(group?.querySelector('ce-panel')?.getAttribute('data-panel-name')).toBe('@ce/log.log');
  });

  it('renders floating fallback instances from BroadcastChannel messages in main mode', async () => {
    const previousBroadcastChannel = globalThis.BroadcastChannel;
    const listeners: Array<(event: MessageEvent) => void> = [];
    class MockChannel {
      name: string;

      constructor(name: string) {
        this.name = name;
      }

      addEventListener(_type: string, listener: (event: MessageEvent) => void) {
        listeners.push(listener);
      }

      removeEventListener() {}

      close() {}
    }
    vi.stubGlobal('BroadcastChannel', MockChannel);

    try {
      el = document.createElement('editor-app') as EditorApp;
      document.body.appendChild(el);
      await waitForBootstrap();

      listeners[0](new MessageEvent('message', {
        data: {
          type: 'ce-open-panel-floating',
          payload: {
            id: 'panel-floating-1',
            panelName: '@ce/log.log',
            carrier: 'floating',
            state: 'open',
            windowGroupId: null,
          },
        },
      }));
      await Promise.resolve();

      const layer = el.querySelector('floating-panel-layer');
      expect(layer).not.toBeNull();
      expect(layer?.getAttribute('data-count')).toBe('1');
      expect(layer?.shadowRoot?.querySelector('.floating-window')).not.toBeNull();
    } finally {
      if (previousBroadcastChannel) {
        vi.stubGlobal('BroadcastChannel', previousBroadcastChannel);
      } else {
        Reflect.deleteProperty(globalThis, 'BroadcastChannel');
      }
    }
  });

  it('removes the source tab when a same-window ce-tab-drag-close-source message arrives', async () => {
    const previousBroadcastChannel = globalThis.BroadcastChannel;
    const listeners: Array<(event: MessageEvent) => void> = [];
    class MockChannel {
      constructor(public name: string) {}
      addEventListener(_type: string, listener: (event: MessageEvent) => void) {
        listeners.push(listener);
      }
      removeEventListener() {}
      close() {}
      postMessage() {}
    }
    vi.stubGlobal('BroadcastChannel', MockChannel);

    try {
      el = document.createElement('editor-app') as EditorApp;
      document.body.appendChild(el);
      await waitForBootstrap();

      listeners[0](new MessageEvent('message', {
        data: {
          type: 'ce-tab-drag-close-source',
          payload: {
            sessionId: 'existing-id',
            sourceWindowId: 'default-main',
            sourceGroupId: 'group-0-1-0',
            sourceTabId: 'tab-0-1-0-0',
          },
        },
      }));
      await Promise.resolve();

      expect(Array.from(el.querySelectorAll('ce-panel')).some((panel) => (
        panel.getAttribute('data-panel-name') === '@ce/plugin-list.list'
      ))).toBe(false);
    } finally {
      if (previousBroadcastChannel) {
        vi.stubGlobal('BroadcastChannel', previousBroadcastChannel);
      } else {
        Reflect.deleteProperty(globalThis, 'BroadcastChannel');
      }
    }
  });

  it('ignores ce-tab-drag-close-source for another window id', async () => {
    const previousBroadcastChannel = globalThis.BroadcastChannel;
    const listeners: Array<(event: MessageEvent) => void> = [];
    class MockChannel {
      constructor(public name: string) {}
      addEventListener(_type: string, listener: (event: MessageEvent) => void) {
        listeners.push(listener);
      }
      removeEventListener() {}
      close() {}
      postMessage() {}
    }
    vi.stubGlobal('BroadcastChannel', MockChannel);

    try {
      el = document.createElement('editor-app') as EditorApp;
      document.body.appendChild(el);
      await waitForBootstrap();

      listeners[0](new MessageEvent('message', {
        data: {
          type: 'ce-tab-drag-close-source',
          payload: {
            sessionId: 'existing-id',
            sourceWindowId: 'secondary-window',
            sourceGroupId: 'group-0-1-0',
            sourceTabId: 'tab-0-1-0-0',
          },
        },
      }));
      await Promise.resolve();

      expect(Array.from(el.querySelectorAll('ce-panel')).some((panel) => (
        panel.getAttribute('data-panel-name') === '@ce/plugin-list.list'
      ))).toBe(true);
    } finally {
      if (previousBroadcastChannel) {
        vi.stubGlobal('BroadcastChannel', previousBroadcastChannel);
      } else {
        Reflect.deleteProperty(globalThis, 'BroadcastChannel');
      }
    }
  });

  it('ignores ce-tab-drag-close-source from another session even when ids match', async () => {
    const previousBroadcastChannel = globalThis.BroadcastChannel;
    const listeners: Array<(event: MessageEvent) => void> = [];
    class MockChannel {
      constructor(public name: string) {}
      addEventListener(_type: string, listener: (event: MessageEvent) => void) {
        listeners.push(listener);
      }
      removeEventListener() {}
      close() {}
      postMessage() {}
    }
    vi.stubGlobal('BroadcastChannel', MockChannel);

    try {
      el = document.createElement('editor-app') as EditorApp;
      document.body.appendChild(el);
      await waitForBootstrap();

      listeners[0](new MessageEvent('message', {
        data: {
          type: 'ce-tab-drag-close-source',
          payload: {
            sessionId: 'other-session',
            sourceWindowId: 'default-main',
            sourceGroupId: 'group-0-1-0',
            sourceTabId: 'tab-0-1-0-0',
          },
        },
      }));
      await Promise.resolve();

      expect(Array.from(el.querySelectorAll('ce-panel')).some((panel) => (
        panel.getAttribute('data-panel-name') === '@ce/plugin-list.list'
      ))).toBe(true);
    } finally {
      if (previousBroadcastChannel) {
        vi.stubGlobal('BroadcastChannel', previousBroadcastChannel);
      } else {
        Reflect.deleteProperty(globalThis, 'BroadcastChannel');
      }
    }
  });

  it('removes the source tab for a secondary window close-source message', async () => {
    const previousBroadcastChannel = globalThis.BroadcastChannel;
    const listeners: Array<(event: MessageEvent) => void> = [];
    class MockChannel {
      constructor(public name: string) {}
      addEventListener(_type: string, listener: (event: MessageEvent) => void) {
        listeners.push(listener);
      }
      removeEventListener() {}
      close() {}
      postMessage() {}
    }
    vi.stubGlobal('BroadcastChannel', MockChannel);
    window.location.search = '?sessionId=existing-id&windowGroupId=secondary-window';
    window.location.href = 'http://localhost:8080/?sessionId=existing-id&windowGroupId=secondary-window';
    bootstrapResponse = () => Promise.resolve(createJsonResponse({
      ...bootstrapPayload,
      windows: [
        bootstrapPayload.windows[0],
        {
          id: 'secondary-window',
          kind: 'secondary',
          type: 'panel-area',
          entry: 'secondary.html',
          state: 'open',
          panelInstanceIds: [],
          layout: {
            type: 'tab',
            activeIndex: 0,
            children: [
              { type: 'leaf', panel: '@ce/log.log' },
              { type: 'leaf', panel: '@ce/message-debug.debug' },
            ],
          },
        },
      ],
    }));

    try {
      el = document.createElement('editor-app') as EditorApp;
      el.setAttribute('window-group-kind', 'secondary');
      document.body.appendChild(el);
      await waitForBootstrap();

      listeners[0](new MessageEvent('message', {
        data: {
          type: 'ce-tab-drag-close-source',
          payload: {
            sessionId: 'existing-id',
            sourceWindowId: 'secondary-window',
            sourceGroupId: 'group-0',
            sourceTabId: 'tab-0-0',
          },
        },
      }));
      await Promise.resolve();

      const remaining = Array.from(el.querySelectorAll('ce-panel')).map((panel) => panel.getAttribute('data-panel-name'));
      expect(remaining).toEqual(['@ce/message-debug.debug']);
    } finally {
      if (previousBroadcastChannel) {
        vi.stubGlobal('BroadcastChannel', previousBroadcastChannel);
      } else {
        Reflect.deleteProperty(globalThis, 'BroadcastChannel');
      }
    }
  });

  it('reclaims a secondary window group on pagehide and beforeunload only once', async () => {
    const previousSendBeacon = navigator.sendBeacon;
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: undefined,
    });
    window.location.search = '?sessionId=existing-id&windowGroupId=secondary-window';
    window.location.href = 'http://localhost:8080/?sessionId=existing-id&windowGroupId=secondary-window';
    bootstrapResponse = () => Promise.resolve(createJsonResponse({
      ...bootstrapPayload,
      windows: [
        bootstrapPayload.windows[0],
        {
          id: 'secondary-window',
          kind: 'secondary',
          type: 'panel-area',
          entry: 'secondary.html',
          state: 'open',
          panelInstanceIds: ['panel-secondary'],
          layout: { type: 'leaf', panel: '@ce/log.log' },
        },
      ],
    }));

    try {
      el = document.createElement('editor-app') as EditorApp;
      el.setAttribute('window-group-kind', 'secondary');
      document.body.appendChild(el);
      await waitForBootstrap();
      mockFetch.mockClear();

      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('beforeunload'));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith('/api/window-group/close', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'existing-id', windowGroupId: 'secondary-window' }),
        keepalive: true,
      });
    } finally {
      Object.defineProperty(navigator, 'sendBeacon', {
        configurable: true,
        value: previousSendBeacon,
      });
    }
  });

  it('restores open and minimized floating panel instances from bootstrap', async () => {
    bootstrapResponse = () => Promise.resolve(createJsonResponse({
      ...bootstrapPayload,
      i18n: {
        locale: 'zh-CN',
        defaultLocale: 'zh-CN',
        version: 1,
        currentMessages: { 'panel.log.title': '日志' },
        defaultMessages: { 'panel.log.title': '日志' },
      },
      panelInstances: [
        {
          id: 'floating-open',
          panelName: '@ce/log.log',
          carrier: 'floating',
          state: 'open',
          windowGroupId: null,
        },
        {
          id: 'floating-minimized',
          panelName: '@ce/log.log',
          carrier: 'floating',
          state: 'minimized',
          windowGroupId: null,
        },
        {
          id: 'floating-closed',
          panelName: '@ce/log.log',
          carrier: 'floating',
          state: 'closed',
          windowGroupId: null,
        },
      ],
      panels: bootstrapPayload.panels.map((panel) => panel.name === '@ce/log.log'
        ? { ...panel, titleKey: 'panel.log.title' }
        : panel),
    }));

    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();
    await Promise.resolve();

    const layer = el.querySelector('floating-panel-layer')!;
    expect(layer.getAttribute('data-count')).toBe('2');
    expect(layer.shadowRoot?.querySelectorAll('.floating-window')).toHaveLength(1);
    expect(layer.shadowRoot?.querySelectorAll('.edge-chip')).toHaveLength(1);
    expect(layer.shadowRoot?.querySelector('ce-panel')?.getAttribute('title-i18n')).toBe('panel.log.title');
    expect(layer.shadowRoot?.querySelector('.edge-chip')?.textContent?.trim()).toBe('日志');
  });

  it('minimizes, restores, and closes floating panels from layer controls', async () => {
    bootstrapResponse = () => Promise.resolve(createJsonResponse({
      ...bootstrapPayload,
      panelInstances: [
        {
          id: 'floating-open',
          panelName: '@ce/log.log',
          carrier: 'floating',
          state: 'open',
          windowGroupId: null,
        },
      ],
    }));

    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();
    await Promise.resolve();
    mockFetch.mockClear();

    const layer = el.querySelector('floating-panel-layer')!;
    layer.shadowRoot?.querySelector<HTMLElement>('[data-floating-action="minimize"]')?.click();
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledWith('/api/panel-instance/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'existing-id', panelInstanceId: 'floating-open', state: 'minimized' }),
    });
    expect(el.querySelector('floating-panel-layer')?.shadowRoot?.querySelector('.edge-chip')).not.toBeNull();

    mockFetch.mockClear();
    el.querySelector('floating-panel-layer')?.shadowRoot?.querySelector<HTMLElement>('[data-floating-action="restore"]')?.click();
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledWith('/api/panel-instance/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'existing-id', panelInstanceId: 'floating-open', state: 'open' }),
    });

    mockFetch.mockClear();
    el.querySelector('floating-panel-layer')?.shadowRoot?.querySelector<HTMLElement>('[data-floating-action="close"]')?.click();
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledWith('/api/panel-instance/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'existing-id', panelInstanceId: 'floating-open' }),
    });
    expect(el.querySelector('floating-panel-layer')?.getAttribute('data-count')).toBe('0');
  });

  it('shows a reused floating panel from an openPanel result message', async () => {
    const previousBroadcastChannel = globalThis.BroadcastChannel;
    const listeners: Array<(event: MessageEvent) => void> = [];
    class MockChannel {
      name: string;

      constructor(name: string) {
        this.name = name;
      }

      addEventListener(_type: string, listener: (event: MessageEvent) => void) {
        listeners.push(listener);
      }

      removeEventListener() {}

      close() {}
    }
    vi.stubGlobal('BroadcastChannel', MockChannel);

    try {
      el = document.createElement('editor-app') as EditorApp;
      document.body.appendChild(el);
      await waitForBootstrap();

      listeners[0](new MessageEvent('message', {
        data: {
          type: 'ce-open-panel-result',
          payload: {
            disposition: 'reuse',
            panelInstanceId: 'panel-floating-reuse',
            panelName: '@ce/log.log',
            carrier: 'floating',
            windowGroupId: null,
            url: null,
          },
        },
      }));
      await Promise.resolve();

      const layer = el.querySelector('floating-panel-layer');
      expect(layer?.getAttribute('data-count')).toBe('1');
      expect(layer?.shadowRoot?.querySelector('.floating-window')).not.toBeNull();
    } finally {
      if (previousBroadcastChannel) {
        vi.stubGlobal('BroadcastChannel', previousBroadcastChannel);
      } else {
        Reflect.deleteProperty(globalThis, 'BroadcastChannel');
      }
    }
  });

  it('shows a reused floating panel from a window message when BroadcastChannel is unavailable', async () => {
    const previousBroadcastChannel = globalThis.BroadcastChannel;
    Reflect.deleteProperty(globalThis, 'BroadcastChannel');

    try {
      el = document.createElement('editor-app') as EditorApp;
      document.body.appendChild(el);
      await waitForBootstrap();

      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'ce-open-panel-result',
          payload: {
            disposition: 'reuse',
            panelInstanceId: 'panel-floating-window-message',
            panelName: '@ce/log.log',
            carrier: 'floating',
            windowGroupId: null,
            url: null,
          },
        },
      }));
      await Promise.resolve();

      const layer = el.querySelector('floating-panel-layer');
      expect(layer?.getAttribute('data-count')).toBe('1');
      expect(layer?.shadowRoot?.querySelector('.floating-window')).not.toBeNull();
    } finally {
      if (previousBroadcastChannel) {
        vi.stubGlobal('BroadcastChannel', previousBroadcastChannel);
      } else {
        Reflect.deleteProperty(globalThis, 'BroadcastChannel');
      }
    }
  });

  it('docks a floating fallback panel back into the main layout', async () => {
    const previousBroadcastChannel = globalThis.BroadcastChannel;
    const listeners: Array<(event: MessageEvent) => void> = [];
    const postMessage = vi.fn();
    class MockChannel {
      name: string;

      constructor(name: string) {
        this.name = name;
      }

      addEventListener(_type: string, listener: (event: MessageEvent) => void) {
        listeners.push(listener);
      }

      removeEventListener() {}

      close() {}

      postMessage = postMessage;
    }
    vi.stubGlobal('BroadcastChannel', MockChannel);

    try {
      el = document.createElement('editor-app') as EditorApp;
      document.body.appendChild(el);
      await waitForBootstrap();

      listeners[0](new MessageEvent('message', {
        data: {
          type: 'ce-open-panel-floating',
          payload: {
            id: 'panel-floating-1',
            panelName: '@ce/log.log',
            carrier: 'floating',
            state: 'open',
            windowGroupId: null,
          },
        },
      }));
      await Promise.resolve();

      const targetGroup = Array.from(el.querySelectorAll('ce-panel-group') as NodeListOf<HTMLElement>)
        .find((group) => group.dataset.groupId === 'group-0-1-0') as HTMLElement;
      const targetTab = targetGroup.shadowRoot!.querySelector('.tab-item') as HTMLElement;
      const tabBar = targetGroup.shadowRoot!.querySelector('.tab-bar') as HTMLElement;
      const content = targetGroup.shadowRoot!.querySelector('.content') as HTMLElement;
      mockRect(tabBar, { left: 80, right: 240, top: 0, bottom: 32 });
      mockRect(targetTab, { left: 80, right: 160, top: 0, bottom: 32 });
      mockRect(content, { left: 80, right: 240, top: 32, bottom: 232 });

      const layer = el.querySelector('floating-panel-layer')!;
      const floatingTab = layer.shadowRoot!
        .querySelector('ce-panel-group')!
        .shadowRoot!
        .querySelector('.tab-item') as HTMLElement;
      floatingTab.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 16, clientY: 16, bubbles: true, composed: true }));
      document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 88, clientY: 16, bubbles: true }));
      document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 88, clientY: 16, bubbles: true }));
      await Promise.resolve();

      expect(el.querySelector('floating-panel-layer')?.getAttribute('data-count')).toBe('0');
      expect(Array.from(el.querySelectorAll('ce-panel')).filter((panel) => (
        panel.getAttribute('data-panel-name') === '@ce/log.log'
      ))).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledWith('/api/panel-instance/close', expect.objectContaining({
        method: 'POST',
      }));
      expect(postMessage).toHaveBeenCalledWith({
        type: 'ce-panel-docked',
        payload: { panelInstanceId: 'panel-floating-1' },
      });
    } finally {
      if (previousBroadcastChannel) {
        vi.stubGlobal('BroadcastChannel', previousBroadcastChannel);
      } else {
        Reflect.deleteProperty(globalThis, 'BroadcastChannel');
      }
    }
  });

  it('renders floating fallback instances from window messages when BroadcastChannel construction fails', async () => {
    const previousBroadcastChannel = globalThis.BroadcastChannel;
    class ThrowingChannel {
      constructor() {
        throw new Error('BroadcastChannel unavailable');
      }
    }
    vi.stubGlobal('BroadcastChannel', ThrowingChannel);

    try {
      el = document.createElement('editor-app') as EditorApp;
      document.body.appendChild(el);
      await waitForBootstrap();

      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'ce-open-panel-floating',
          payload: {
            id: 'panel-floating-post-message',
            panelName: '@ce/log.log',
            carrier: 'floating',
            state: 'open',
            windowGroupId: null,
          },
        },
      }));
      await Promise.resolve();

      const layer = el.querySelector('floating-panel-layer');
      expect(layer).not.toBeNull();
      expect(layer?.getAttribute('data-count')).toBe('1');
      expect(layer?.shadowRoot?.querySelector('.floating-window')).not.toBeNull();
    } finally {
      if (previousBroadcastChannel) {
        vi.stubGlobal('BroadcastChannel', previousBroadcastChannel);
      } else {
        Reflect.deleteProperty(globalThis, 'BroadcastChannel');
      }
    }
  });

  it('ignores malformed channel-compatible window messages without throwing', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    expect(() => {
      window.dispatchEvent(new MessageEvent('message', { data: null }));
      window.dispatchEvent(new MessageEvent('message', { data: 'not-an-object' }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'ce-open-panel-floating', payload: null } }));
    }).not.toThrow();

    const layer = el.querySelector('floating-panel-layer');
    expect(layer?.getAttribute('data-count')).toBe('0');
  });

  it('ignores floating fallback messages and omits the layer in secondary mode', async () => {
    const previousBroadcastChannel = globalThis.BroadcastChannel;
    const listeners: Array<(event: MessageEvent) => void> = [];
    class MockChannel {
      name: string;

      constructor(name: string) {
        this.name = name;
      }

      addEventListener(_type: string, listener: (event: MessageEvent) => void) {
        listeners.push(listener);
      }

      removeEventListener() {}

      close() {}
    }
    vi.stubGlobal('BroadcastChannel', MockChannel);
    bootstrapResponse = () => Promise.resolve(createJsonResponse({
      ...bootstrapPayload,
      windows: [
        bootstrapPayload.windows[0],
        {
          id: 'secondary-window',
          kind: 'secondary',
          type: 'panel-area',
          entry: 'secondary.html',
          state: 'open',
          panelInstanceIds: [],
          layout: { type: 'leaf', panel: '@ce/log.log' },
        },
      ],
    }));

    try {
      el = document.createElement('editor-app') as EditorApp;
      el.setAttribute('window-group-kind', 'secondary');
      document.body.appendChild(el);
      await waitForBootstrap();

      expect(el.querySelector('floating-panel-layer')).toBeNull();
      listeners[0](new MessageEvent('message', {
        data: {
          type: 'ce-open-panel-floating',
          payload: {
            id: 'panel-floating-1',
            panelName: '@ce/log.log',
            carrier: 'floating',
            state: 'open',
            windowGroupId: null,
          },
        },
      }));
      await Promise.resolve();

      expect(el.querySelector('floating-panel-layer')).toBeNull();
      expect(el.querySelector('[data-window-id="secondary-window"]')).not.toBeNull();
    } finally {
      if (previousBroadcastChannel) {
        vi.stubGlobal('BroadcastChannel', previousBroadcastChannel);
      } else {
        Reflect.deleteProperty(globalThis, 'BroadcastChannel');
      }
    }
  });

  it('sends menuTree to Electron bridge after bootstrap', async () => {
    const syncMenu = vi.fn();
    (window as typeof window & {
      electronMenu?: { syncMenu: typeof syncMenu; onMenuAction: ReturnType<typeof vi.fn> };
    }).electronMenu = {
      syncMenu,
      onMenuAction: vi.fn(() => () => {}),
    };

    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    expect(syncMenu).toHaveBeenCalledWith({
      sessionId: 'existing-id',
      menuTree: bootstrapPayload.menuTree,
    });

    delete (window as typeof window & { electronMenu?: unknown }).electronMenu;
  });

  it('syncs Electron menu again when an i18n SSE event carries a translated menu tree', async () => {
    const syncMenu = vi.fn();
    (window as typeof window & {
      electronMenu?: { syncMenu: typeof syncMenu; onMenuAction: ReturnType<typeof vi.fn> };
    }).electronMenu = {
      syncMenu,
      onMenuAction: vi.fn(() => () => {}),
    };

    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const source = MockEventSource.instances.at(-1)!;
    source.onmessage?.({
      data: JSON.stringify({
        protocolVersion: 1,
        type: 'messages-changed',
        version: 2,
        changedKeys: ['menu.file'],
        affectsFallback: false,
        i18n: {
          locale: 'en-US',
          defaultLocale: 'zh-CN',
          version: 2,
          currentMessages: { 'menu.file': 'File' },
          defaultMessages: { 'menu.file': '文件' },
        },
        menuTree: [
          { type: 'menu', id: 'file', label: 'File', labelKey: 'menu.file', children: [] },
        ],
      }),
    });

    expect(syncMenu).toHaveBeenLastCalledWith({
      sessionId: 'existing-id',
      menuTree: [
        { type: 'menu', id: 'file', label: 'File', labelKey: 'menu.file', children: [] },
      ],
    });

    delete (window as typeof window & { electronMenu?: unknown }).electronMenu;
  });

  it('syncs Electron menu again when a menu-changed SSE event arrives', async () => {
    const syncMenu = vi.fn();
    (window as typeof window & {
      electronMenu?: { syncMenu: typeof syncMenu; onMenuAction: ReturnType<typeof vi.fn> };
    }).electronMenu = {
      syncMenu,
      onMenuAction: vi.fn(() => () => {}),
    };

    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const source = MockEventSource.instances.at(-1)!;
    source.onmessage?.({
      data: JSON.stringify({
        protocolVersion: 1,
        type: 'menu-changed',
        menuTree: [
          {
            type: 'menu',
            id: 'view',
            label: 'View',
            children: [
              {
                type: 'menu',
                id: 'view/panels',
                label: 'Panels',
                children: [
                  { type: 'menu', id: 'view/panels/ce-log-log', label: 'Log', children: [] },
                ],
              },
            ],
          },
        ],
      }),
    });

    expect(syncMenu).toHaveBeenLastCalledWith({
      sessionId: 'existing-id',
      menuTree: [
        {
          type: 'menu',
          id: 'view',
          label: 'View',
          children: [
            {
              type: 'menu',
              id: 'view/panels',
              label: 'Panels',
              children: [
                { type: 'menu', id: 'view/panels/ce-log-log', label: 'Log', children: [] },
              ],
            },
          ],
        },
      ],
    });

    delete (window as typeof window & { electronMenu?: unknown }).electronMenu;
  });

  it('forwards Electron menu actions to the menu trigger route', async () => {
    const syncMenu = vi.fn();
    let handler: ((payload: { sessionId: string; menuId: string }) => void) | undefined;
    (window as typeof window & {
      electronMenu?: {
        syncMenu: typeof syncMenu;
        onMenuAction: (next: typeof handler) => () => void;
      };
    }).electronMenu = {
      syncMenu,
      onMenuAction(next) {
        handler = next;
        return vi.fn();
      },
    };
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/bootstrap/')) {
        return bootstrapResponse();
      }
      if (url.startsWith('/api/menu/trigger')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ sessionId: 'existing-id', menuId: 'file/new-session' });
        return Promise.resolve(createJsonResponse({ result: { ok: true } }));
      }
      return Promise.resolve(createJsonResponse(sessionPayload));
    });

    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();
    handler?.({ sessionId: 'existing-id', menuId: 'file/new-session' });
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/menu/trigger',
      expect.objectContaining({ method: 'POST' }),
    );

    delete (window as typeof window & { electronMenu?: unknown }).electronMenu;
  });

  it('renders status-bar panel from bootstrap', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const panels = el.querySelectorAll('ce-panel');
    const statusBar = Array.from(panels).find(
      (p) => p.getAttribute('src') === '/api/assets/panel/%40ce%2Fstatus-bar.status/index.html?sessionId=existing-id'
    ) as HTMLElement | undefined;
    expect(statusBar).not.toBeNull();
    expect(statusBar!.getAttribute('type')).toBe('simple');
    expect(statusBar!.dataset.layoutFixed).toBe('true');
    expect(statusBar!.style.flex).toBe('0 0 40px');
  });

  it('renders plugin-list panel from bootstrap', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const panels = el.querySelectorAll('ce-panel');
    const pluginList = Array.from(panels).find(
      (p) => p.getAttribute('src') === '/api/assets/panel/%40ce%2Fplugin-list.list/index.html?sessionId=existing-id'
    );
    expect(pluginList).not.toBeNull();
  });

  it('refreshes a tab title when an i18n SSE event changes its title key', async () => {
    bootstrapResponse = () => Promise.resolve(createJsonResponse({
      ...bootstrapPayload,
      i18n: {
        locale: 'zh-CN',
        defaultLocale: 'zh-CN',
        version: 1,
        currentMessages: { 'panel.plugin-list.title': '插件列表' },
        defaultMessages: { 'panel.plugin-list.title': '插件列表' },
      },
      panels: bootstrapPayload.panels.map((panel) => panel.name === '@ce/plugin-list.list'
        ? { ...panel, titleKey: 'panel.plugin-list.title' }
        : panel),
    }));

    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const group = Array.from(el.querySelectorAll('ce-panel-group')).find((candidate) => {
      return candidate.shadowRoot!.textContent?.includes('插件列表');
    })!;
    expect(group).toBeDefined();

    MockEventSource.instances.at(-1)!.onmessage?.({
      data: JSON.stringify({
        protocolVersion: 1,
        type: 'messages-changed',
        version: 2,
        changedKeys: ['panel.plugin-list.title'],
        affectsFallback: false,
        i18n: {
          locale: 'en-US',
          defaultLocale: 'zh-CN',
          version: 2,
          currentMessages: { 'panel.plugin-list.title': 'Plugin List' },
          defaultMessages: { 'panel.plugin-list.title': '插件列表' },
        },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const refreshedGroup = Array.from(el.querySelectorAll('ce-panel-group')).find((candidate) => {
      return candidate.shadowRoot!.textContent?.includes('Plugin List');
    });
    expect(refreshedGroup).toBeDefined();
  });

  it('syncs host theme styles into plugin-list iframe on load', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const pluginListPanel = Array.from(el.querySelectorAll('ce-panel')).find(
      (panel) => panel.getAttribute('src') === '/api/assets/panel/%40ce%2Fplugin-list.list/index.html?sessionId=existing-id'
    ) as HTMLElement | undefined;
    expect(pluginListPanel).toBeDefined();

    const iframe = pluginListPanel!.shadowRoot!.querySelector('iframe') as HTMLIFrameElement | null;
    expect(iframe).not.toBeNull();

    const iframeDocument = document.implementation.createHTMLDocument('plugin-list');
    Object.defineProperty(iframe!, 'contentDocument', {
      configurable: true,
      value: iframeDocument,
    });

    iframe!.dispatchEvent(new Event('load'));

    const tokenStyle = iframeDocument.getElementById('ce-theme-tokens');
    expect(tokenStyle).not.toBeNull();
    expect(tokenStyle!.textContent).toContain('--ce-workbench-bg:var(--ce-surface);');

    const baseUiStyle = iframeDocument.getElementById('ce-base-ui-theme');
    expect(baseUiStyle).not.toBeNull();
    expect(baseUiStyle!.textContent).toContain('button {');
  });

  it('wraps a single non-simple panel in a panel-group', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const groups = Array.from(el.querySelectorAll('ce-panel-group'));
    const pluginListGroup = groups.find((group) => {
      const titles = Array.from(group.querySelectorAll(':scope > ce-panel'))
        .map((panel) => panel.getAttribute('title'));
      return titles.includes('List');
    });

    expect(pluginListGroup).not.toBeUndefined();
    expect(pluginListGroup!.querySelectorAll(':scope > ce-panel')).toHaveLength(1);
    // panel-group automatically marks its child panels chromeless during render
    const childPanel = pluginListGroup!.querySelector(':scope > ce-panel') as HTMLElement | null;
    expect(childPanel?.hasAttribute('chromeless')).toBe(true);
    expect(childPanel?.style.background).toBe('transparent');
  });

  it('renders log panel from bootstrap', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const panels = el.querySelectorAll('ce-panel');
    const logPanel = Array.from(panels).find(
      (p) => p.getAttribute('src') === '/api/assets/panel/%40ce%2Flog.log/index.html?sessionId=existing-id'
    );
    expect(logPanel).not.toBeNull();
  });

  it('routes panel-dispatch events to the iframe with the matching panel name', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const logPanel = Array.from(el.querySelectorAll('ce-panel')).find(
      (panel) => panel.getAttribute('data-panel-name') === '@ce/log.log'
    ) as HTMLElement | undefined;
    expect(logPanel).toBeDefined();

    const iframe = logPanel!.shadowRoot!.querySelector('iframe') as HTMLIFrameElement | null;
    expect(iframe).not.toBeNull();

    const postMessage = vi.fn();
    Object.defineProperty(iframe!, 'contentWindow', {
      configurable: true,
      value: { postMessage },
    });

    const source = MockEventSource.instances.at(-1);
    expect(source).toBeDefined();

    source!.onmessage?.({
      data: JSON.stringify({
        protocolVersion: 1,
        type: 'panel-dispatch',
        panel: '@ce/log.log',
        method: 'append',
        args: ['hello'],
        requestId: 'req-1',
      }),
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'panel-dispatch',
      panel: '@ce/log.log',
      method: 'append',
      args: ['hello'],
      requestId: 'req-1',
    }, '*');
  });

  it('relays dispatch results only from a rendered panel iframe', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();
    mockFetch.mockClear();

    const iframe = Array.from(el.querySelectorAll('ce-panel'))
      .find((panel) => panel.getAttribute('data-panel-name') === '@ce/log.log')
      ?.shadowRoot?.querySelector('iframe');
    const trustedSource = {} as Window;
    Object.defineProperty(iframe!, 'contentWindow', { configurable: true, value: trustedSource });
    window.dispatchEvent(new MessageEvent('message', {
      source: trustedSource,
      data: { type: 'dispatch-result', requestId: 'req-1', result: 'done' },
    }));
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledWith('/api/message/result', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'existing-id',
        requestId: 'req-1',
        result: { ok: true, value: 'done' },
      }),
    }));

    mockFetch.mockClear();
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      data: { type: 'dispatch-result', requestId: 'req-2', result: 'forged' },
    }));
    await Promise.resolve();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('relays serialized dispatch errors from a rendered panel iframe', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();
    mockFetch.mockClear();

    const iframe = Array.from(el.querySelectorAll('ce-panel'))
      .find((panel) => panel.getAttribute('data-panel-name') === '@ce/log.log')
      ?.shadowRoot?.querySelector('iframe');
    const trustedSource = {} as Window;
    Object.defineProperty(iframe!, 'contentWindow', { configurable: true, value: trustedSource });
    window.dispatchEvent(new MessageEvent('message', {
      source: trustedSource,
      data: { type: 'dispatch-result', requestId: 'req-error', error: 'panel failed' },
    }));
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledWith('/api/message/result', expect.objectContaining({
      body: JSON.stringify({
        sessionId: 'existing-id',
        requestId: 'req-error',
        result: { ok: false, error: 'panel failed' },
      }),
    }));
  });

  it('activates a panel in the current local window when a panel requests focus', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'panel-focus', panel: '@ce/message-debug.debug' },
    }));

    const logPanel = el.querySelector('[data-panel-name="@ce/log.log"]');
    const debugPanel = el.querySelector('[data-panel-name="@ce/message-debug.debug"]');
    expect(logPanel?.hasAttribute('active')).toBe(false);
    expect(debugPanel?.hasAttribute('active')).toBe(true);
  });

  it('caps the example log plugin at 500 records', async () => {
    type LogPluginDefinition = {
      lifecycle?: { load?: (ctx: unknown) => void };
      methods: {
        appendLog(entry?: { level?: string; message?: string; meta?: unknown } | null): unknown;
        getLogs(): Array<{ level: string; message: string; meta?: unknown }>;
      };
    };
    let plugin: LogPluginDefinition | undefined;
    const broadcast = vi.fn();
    const previousEditor = (globalThis as typeof globalThis & { editor?: unknown }).editor;
    (globalThis as typeof globalThis & {
      editor: { plugin: { define: (definition: LogPluginDefinition) => void } };
    }).editor = {
      plugin: {
        define(definition) {
          plugin = definition;
        },
      },
    };

    vi.resetModules();
    try {
      // @ts-expect-error The example plugin source lives outside the client tsconfig root.
      await import('../../../../kits/default/plugins/log/main/src/index.ts');
      plugin?.lifecycle?.load?.({
        message: { broadcast },
      });
      expect(plugin?.methods.appendLog(null)).toMatchObject({
        level: 'info',
        message: 'New log entry',
      });
      expect(plugin?.methods.appendLog({ level: 'warn', message: 'object payload', meta: { source: 'test' } })).toMatchObject({
        level: 'warn',
        message: 'object payload',
        meta: { source: 'test' },
      });
      for (let index = 0; index < 550; index += 1) {
        plugin?.methods.appendLog({ message: `log-${index}` });
      }

      const logs = plugin?.methods.getLogs() ?? [];
      expect(logs).toHaveLength(500);
      expect(logs[0].message).toBe('log-50');
      expect(broadcast).toHaveBeenCalledWith('log.changed', expect.any(Array));
    } finally {
      if (previousEditor === undefined) {
        delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
      } else {
        (globalThis as typeof globalThis & { editor?: unknown }).editor = previousEditor;
      }
    }
  });

  it('renders panel-group container for multiple panels in one region', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const group = Array.from(el.querySelectorAll('ce-panel-group')).find((candidate) => {
      const titles = Array.from(candidate.querySelectorAll(':scope > ce-panel'))
        .map((panel) => panel.getAttribute('title'));
      return titles.includes('Log') && titles.includes('Debug');
    });
    expect(group).not.toBeUndefined();
    const panels = group!.querySelectorAll(':scope > ce-panel');
    expect(panels).toHaveLength(2);
    expect(panels[0].getAttribute('title')).toBe('Log');
    expect(panels[0].hasAttribute('active')).toBe(true);
    expect(panels[1].getAttribute('title')).toBe('Debug');
    expect(panels[1].hasAttribute('active')).toBe(false);
  });

  it('renders loading panel before deferred bootstrap resolves', async () => {
    const bootstrapDeferred = deferred<Response>();
    bootstrapResponse = () => bootstrapDeferred.promise;

    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await Promise.resolve();

    const loadingPanel = Array.from(el.querySelectorAll('ce-panel')).find(
      (panel) => panel.getAttribute('type') === 'simple' && panel.getAttribute('src') === null
    );
    expect(loadingPanel).not.toBeNull();
    expect(el.textContent).toContain('Loading kit layout...');

    bootstrapDeferred.resolve(createJsonResponse(bootstrapPayload));
    await waitForBootstrap();
  });

  it('does not sync Electron menu or connect SSE after disconnect before bootstrap resolves', async () => {
    const bootstrapDeferred = deferred<Response>();
    const syncMenu = vi.fn();
    bootstrapResponse = () => bootstrapDeferred.promise;
    (window as typeof window & {
      electronMenu?: { syncMenu: typeof syncMenu; onMenuAction: ReturnType<typeof vi.fn> };
    }).electronMenu = {
      syncMenu,
      onMenuAction: vi.fn(() => () => {}),
    };

    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await Promise.resolve();
    el.remove();

    bootstrapDeferred.resolve(createJsonResponse(bootstrapPayload));
    await Promise.resolve();
    await Promise.resolve();

    expect(syncMenu).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);

    delete (window as typeof window & { electronMenu?: unknown }).electronMenu;
  });

  it('disconnects SSE when the component unmounts', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const source = MockEventSource.instances.at(-1);
    expect(source).toBeDefined();

    el.remove();

    expect(source!.close).toHaveBeenCalledTimes(1);
  });

  it('renders dividers between panels', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const dividers = el.querySelectorAll('ce-divider');
    expect(dividers).toHaveLength(1);
  });

  it('does not render a divider next to fixed simple panels', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const outer = el.querySelector('ce-split-pane[direction="column"]')!;
    expect(Array.from(outer.children).some((child) => child.tagName.toLowerCase() === 'ce-divider')).toBe(false);
  });

  it('resizes layout items rendered from split layout', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const rowSplit = Array.from(el.querySelectorAll('ce-split-pane')).find(
      (splitPane) => splitPane.getAttribute('direction') === 'row'
    )!;
    const divider = Array.from(rowSplit.children).find(
      (child) => child.tagName.toLowerCase() === 'ce-divider'
    )!;
    const previous = divider.previousElementSibling as HTMLElement;
    const next = divider.nextElementSibling as HTMLElement;

    divider.dispatchEvent(new CustomEvent('ce-divider-resize', {
      detail: { delta: 50 },
      bubbles: true,
      composed: true,
    }));

    expect(previous.style.flex).toBe('0 1 310px');
    expect(next.style.flex).toBe('0 1 70px');
  });

  it('does not render url-bar', () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);

    expect(el.querySelector('url-bar')).toBeNull();
  });

  it('renders panel groups with stable group and session ids', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const groups = Array.from(el.querySelectorAll('ce-panel-group')) as HTMLElement[];
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((group) => group.dataset.groupId)).toBe(true);
    expect(groups.every((group) => group.dataset.sessionId === 'existing-id')).toBe(true);
    expect(groups.every((group) => group.dataset.windowId === 'default-main')).toBe(true);
  });

  it('moves a tab into another group and activates it after drop', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const groups = Array.from(el.querySelectorAll('ce-panel-group')) as HTMLElement[];
    const sourceGroup = groups.find((group) => Array.from(group.querySelectorAll(':scope > ce-panel')).some((panel) => panel.getAttribute('title') === 'Debug'))!;
    const targetGroup = groups.find((group) => Array.from(group.querySelectorAll(':scope > ce-panel')).some((panel) => panel.getAttribute('title') === 'List'))!;

    const sourceTab = sourceGroup.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    const targetTab = targetGroup.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const tabBar = targetGroup.shadowRoot!.querySelector('.tab-bar') as HTMLElement;
    const content = targetGroup.shadowRoot!.querySelector('.content') as HTMLElement;

    sourceTab.getBoundingClientRect = () => makeRect(10, 32);
    targetTab.getBoundingClientRect = () => ({ ...makeRect(80, 32), left: 100, right: 180, top: 0, bottom: 32, x: 100, y: 0 } as DOMRect);
    tabBar.getBoundingClientRect = () => ({ ...makeRect(160, 32), left: 100, right: 260, top: 0, bottom: 32, x: 100, y: 0 } as DOMRect);
    content.getBoundingClientRect = () => ({ ...makeRect(160, 200), left: 100, right: 260, top: 32, bottom: 232, x: 100, y: 32 } as DOMRect);

    sourceTab.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 20, clientY: 16, bubbles: true, composed: true }));
    document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 110, clientY: 16, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 110, clientY: 16, bubbles: true }));

    const refreshedTarget = (Array.from(el.querySelectorAll('ce-panel-group')) as HTMLElement[])
      .find((group) => group.dataset.groupId === targetGroup.dataset.groupId)!;
    const titles = Array.from(refreshedTarget.querySelectorAll(':scope > ce-panel')).map((panel) => panel.getAttribute('title'));
    expect(titles).toEqual(['Debug', 'List']);
    expect(refreshedTarget.querySelector(':scope > ce-panel[active]')?.getAttribute('title')).toBe('Debug');
  });

  it('restores cached layout when the bootstrap layout has not changed', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const groups = Array.from(el.querySelectorAll('ce-panel-group')) as HTMLElement[];
    const sourceGroup = groups.find((group) => Array.from(group.querySelectorAll(':scope > ce-panel')).some((panel) => panel.getAttribute('title') === 'Debug'))!;
    const targetGroup = groups.find((group) => Array.from(group.querySelectorAll(':scope > ce-panel')).some((panel) => panel.getAttribute('title') === 'List'))!;

    const sourceTab = sourceGroup.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    const targetTab = targetGroup.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const tabBar = targetGroup.shadowRoot!.querySelector('.tab-bar') as HTMLElement;
    const content = targetGroup.shadowRoot!.querySelector('.content') as HTMLElement;

    sourceTab.getBoundingClientRect = () => makeRect(10, 32);
    targetTab.getBoundingClientRect = () => ({ ...makeRect(80, 32), left: 100, right: 180, top: 0, bottom: 32, x: 100, y: 0 } as DOMRect);
    tabBar.getBoundingClientRect = () => ({ ...makeRect(160, 32), left: 100, right: 260, top: 0, bottom: 32, x: 100, y: 0 } as DOMRect);
    content.getBoundingClientRect = () => ({ ...makeRect(160, 200), left: 100, right: 260, top: 32, bottom: 232, x: 100, y: 32 } as DOMRect);

    sourceTab.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 20, clientY: 16, bubbles: true, composed: true }));
    document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 110, clientY: 16, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 110, clientY: 16, bubbles: true }));
    expect(window.localStorage.getItem('itharbors:layout:v1:mock-uuid-1234:%40itharbors%2Fkit-default:default-main')).toContain('"layout"');

    el.remove();
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const restoredTarget = (Array.from(el.querySelectorAll('ce-panel-group')) as HTMLElement[])
      .find((group) => Array.from(group.querySelectorAll(':scope > ce-panel')).some((panel) => panel.getAttribute('title') === 'List'))!;
    const titles = Array.from(restoredTarget.querySelectorAll(':scope > ce-panel')).map((panel) => panel.getAttribute('title'));
    expect(titles).toEqual(['Debug', 'List']);
    expect(restoredTarget.querySelector(':scope > ce-panel[active]')?.getAttribute('title')).toBe('Debug');
  });

  it('ignores cached layout when the bootstrap layout signature changes', async () => {
    window.sessionStorage.setItem('itharbors:client-window-id', 'mock-uuid-1234');
    window.localStorage.setItem('itharbors:layout:v1:mock-uuid-1234:%40itharbors%2Fkit-default:default-main', JSON.stringify({
      version: 1,
      defaultSignature: 'stale-default-layout',
      layout: {
        kind: 'group',
        groupId: 'group-stale',
        sessionId: 'old-session',
        windowId: 'default-main',
        activeTabId: 'tab-stale',
        tabs: [{
          tabId: 'tab-stale',
          sessionId: 'old-session',
          windowId: 'default-main',
          groupId: 'group-stale',
          title: 'Stale',
          panelName: '@ce/stale',
          panelType: 'iframe',
          content: { type: 'leaf', panel: '@ce/stale' },
        }],
      },
    }));

    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    expect(Array.from(el.querySelectorAll('ce-panel')).some((panel) => panel.getAttribute('title') === 'Stale')).toBe(false);
    expect(window.localStorage.getItem('itharbors:layout:v1:mock-uuid-1234:%40itharbors%2Fkit-default:default-main')).toBeNull();
  });

  it('invalidates a cached layout when a panel descriptor title changes', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const logPanel = el.querySelector<HTMLElement>('ce-panel[data-panel-name="@ce/log.log"]')!;
    const logGroup = logPanel.closest('ce-panel-group')!;
    logGroup.dispatchEvent(new CustomEvent('ce-panel-change', { bubbles: true }));
    expect(window.localStorage.getItem(
      'itharbors:layout:v1:mock-uuid-1234:%40itharbors%2Fkit-default:default-main',
    )).toContain('"layout"');

    el.remove();
    bootstrapResponse = () => Promise.resolve(createJsonResponse({
      ...bootstrapPayload,
      panels: bootstrapPayload.panels.map((panel) => (
        panel.name === '@ce/log.log' ? { ...panel, title: '日志' } : panel
      )),
    }));
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    expect(el.querySelector('ce-panel[data-panel-name="@ce/log.log"]')?.getAttribute('title'))
      .toBe('日志');
  });

  it('splits a target group when a tab drops on the content edge', async () => {
    el = document.createElement('editor-app') as EditorApp;
    document.body.appendChild(el);
    await waitForBootstrap();

    const groups = Array.from(el.querySelectorAll('ce-panel-group')) as HTMLElement[];
    const sourceGroup = groups.find((group) => Array.from(group.querySelectorAll(':scope > ce-panel')).some((panel) => panel.getAttribute('title') === 'List'))!;
    const targetGroup = groups.find((group) => Array.from(group.querySelectorAll(':scope > ce-panel')).some((panel) => panel.getAttribute('title') === 'Log'))!;

    const sourceTab = sourceGroup.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const content = targetGroup.shadowRoot!.querySelector('.content') as HTMLElement;
    const tabBar = targetGroup.shadowRoot!.querySelector('.tab-bar') as HTMLElement;
    const targetTab = targetGroup.shadowRoot!.querySelector('.tab-item') as HTMLElement;

    sourceTab.getBoundingClientRect = () => makeRect(80, 32);
    tabBar.getBoundingClientRect = () => ({ ...makeRect(160, 32), left: 300, right: 460, top: 0, bottom: 32, x: 300, y: 0 } as DOMRect);
    targetTab.getBoundingClientRect = () => ({ ...makeRect(80, 32), left: 300, right: 380, top: 0, bottom: 32, x: 300, y: 0 } as DOMRect);
    content.getBoundingClientRect = () => ({ ...makeRect(160, 200), left: 300, right: 460, top: 32, bottom: 232, x: 300, y: 32 } as DOMRect);

    sourceTab.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 20, clientY: 16, bubbles: true, composed: true }));
    document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 310, clientY: 40, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 310, clientY: 40, bubbles: true }));

    const refreshedGroups = Array.from(el.querySelectorAll('ce-panel-group'));
    expect(refreshedGroups.some((group) => {
      return Array.from(group.querySelectorAll(':scope > ce-panel'))
        .some((panel) => panel.getAttribute('title') === 'List');
    })).toBe(true);
    expect(el.querySelector('ce-split-pane[direction="column"], ce-split-pane[direction="row"]')).not.toBeNull();
  });
});

function makeRect(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}
