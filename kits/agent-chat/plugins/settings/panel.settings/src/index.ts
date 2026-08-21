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

let reloadPanel: (() => void) | null = null;

const definition = {
  async mount(ctx: PanelContext) {
    const root = document.getElementById('panel-root');
    if (!root) return;
    root.innerHTML = '<main class="settings-shell"><nav id="settings-pages" aria-label="设置页面"></nav><section id="settings-content" aria-live="polite"></section></main>';
    const pageList = root.querySelector('#settings-pages') as HTMLElement;
    const content = root.querySelector('#settings-content') as HTMLElement;
    let currentPages: SettingsPage[] = [];
    let selectedPanel: string | null = null;

    const showMessage = (message: string, kind: 'loading' | 'empty' | 'error') => {
      const element = document.createElement('p');
      element.className = kind;
      element.textContent = message;
      content.replaceChildren(element);
    };

    const renderPage = (page: SettingsPage | undefined) => {
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
      content.append(frame);
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
      showMessage('正在读取…', 'loading');
      try {
        const result = await ctx.message.request('settings', 'getPages');
        currentPages = Array.isArray(result) ? result as SettingsPage[] : [];
        renderPages();
      } catch (error) {
        showMessage(errorText(error), 'error');
      }
    };

    reloadPanel = () => { void loadPages(); };
    await loadPages();
  },

  unmount() {
    reloadPanel = null;
  },

  methods: {
    onRegistryChanged() {
      reloadPanel?.();
    },
  },
};

export default definition;
