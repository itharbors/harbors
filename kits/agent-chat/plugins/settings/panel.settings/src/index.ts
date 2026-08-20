type PanelContext = {
  sessionId: string;
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
};

export type SettingsPage = {
  owner: string;
  panel: string;
  title: string;
  order: number;
  entry: string;
};

type PageRequest = {
  type: 'settings-page-request';
  requestId: string;
  name: string;
  args: unknown[];
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Add the host session to an embedded settings page while retaining existing query parameters. */
export function appendSessionId(entry: string, sessionId: string, base = typeof document === 'undefined' ? 'http://settings.local/' : document.baseURI): string {
  const url = new URL(entry, base);
  url.searchParams.set('sessionId', sessionId);
  if (/^[a-z][a-z\d+.-]*:/i.test(entry)) return url.toString();
  return `${url.pathname}${url.search}${url.hash}`;
}

function isPageRequest(value: unknown): value is PageRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return request.type === 'settings-page-request'
    && typeof request.requestId === 'string'
    && request.requestId.length > 0
    && typeof request.name === 'string'
    && request.name.length > 0
    && Array.isArray(request.args);
}

let reloadPanel: (() => void) | null = null;
let disposePanel: (() => void) | null = null;

const definition = {
  async mount(ctx: PanelContext) {
    const root = document.getElementById('panel-root');
    if (!root) return;
    root.innerHTML = '<main class="settings-shell"><nav id="settings-pages" aria-label="设置页面"></nav><section id="settings-content" aria-live="polite"></section></main>';
    const pageList = root.querySelector('#settings-pages') as HTMLElement;
    const content = root.querySelector('#settings-content') as HTMLElement;
    let currentPages: SettingsPage[] = [];
    let selectedPanel: string | null = null;
    let currentFrame: HTMLIFrameElement | null = null;
    const sourceOwners = new Map<Window, string>();

    const showMessage = (message: string, kind: 'loading' | 'empty' | 'error') => {
      const element = document.createElement('p');
      element.className = kind;
      element.textContent = message;
      content.replaceChildren(element);
    };

    const renderPage = (page: SettingsPage | undefined) => {
      sourceOwners.clear();
      currentFrame = null;
      content.replaceChildren();
      if (!page) {
        showMessage('暂无插件设置页面', 'empty');
        return;
      }
      selectedPanel = page.panel;
      const frame = document.createElement('iframe');
      frame.className = 'settings-page-frame';
      frame.title = page.title;
      frame.src = appendSessionId(page.entry, ctx.sessionId);
      frame.setAttribute('allow', 'clipboard-read; clipboard-write');
      currentFrame = frame;
      content.append(frame);
      // Register only the currently rendered frame. event.source is checked against this exact Window.
      if (frame.contentWindow) sourceOwners.set(frame.contentWindow, page.owner);
    };

    const renderPages = () => {
      pageList.replaceChildren();
      for (const page of currentPages) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'settings-page-link';
        button.textContent = page.title;
        button.dataset.panel = page.panel;
        button.setAttribute('aria-pressed', String(page.panel === selectedPanel));
        button.addEventListener('click', () => {
          selectedPanel = page.panel;
          renderPages();
        });
        pageList.append(button);
      }
      const selected = currentPages.find((page) => page.panel === selectedPanel) ?? currentPages[0];
      if (selected && selected.panel !== selectedPanel) selectedPanel = selected.panel;
      renderPage(selected);
    };

    const loadPages = async () => {
      sourceOwners.clear();
      currentFrame = null;
      showMessage('正在读取…', 'loading');
      try {
        const result = await ctx.message.request('settings', 'getPages');
        currentPages = Array.isArray(result) ? result as SettingsPage[] : [];
        renderPages();
      } catch (error) {
        showMessage(errorText(error), 'error');
      }
    };

    const onWindowMessage = (event: MessageEvent) => {
      if (!isPageRequest(event.data) || !event.source) return;
      const owner = sourceOwners.get(event.source as Window);
      if (!owner || !currentFrame || event.source !== currentFrame.contentWindow) return;
      void ctx.message.request('settings', 'requestPage', { owner, name: event.data.name, args: event.data.args })
        .then((result) => (event.source as Window).postMessage({ type: 'settings-page-response', requestId: event.data.requestId, result }, '*'))
        .catch((error) => (event.source as Window).postMessage({ type: 'settings-page-response', requestId: event.data.requestId, error: errorText(error) }, '*'));
    };

    window.addEventListener('message', onWindowMessage);
    disposePanel = () => window.removeEventListener('message', onWindowMessage);
    reloadPanel = () => { void loadPages(); };
    await loadPages();
  },

  unmount() {
    disposePanel?.();
    disposePanel = null;
    reloadPanel = null;
  },

  methods: {
    onRegistryChanged() {
      reloadPanel?.();
    },
  },
};

export default definition;
