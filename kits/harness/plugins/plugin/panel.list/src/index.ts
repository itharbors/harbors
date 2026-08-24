type PluginItem = {
  name: string;
  path: string;
  kind: string;
  source: string;
  sourceLabel?: string;
  loaded: boolean;
  panelCount: number;
  requestCount: number;
  broadcastCount: number;
};

type PanelContext = {
  message: { request(plugin: string, name: string, ...args: unknown[]): Promise<unknown> };
};

type LifecycleResult = { ok: boolean; error?: string };
type PluginSummary = { activeKitName?: string; loadedCount?: number; plugins?: PluginItem[] };

type GroupKey = 'builtin' | 'kit' | 'external';

const GROUPS: { key: GroupKey; title: string }[] = [
  { key: 'builtin', title: '内置插件' },
  { key: 'kit', title: '我的插件' },
  { key: 'external', title: '外部插件' },
];

const SOURCE_LABEL: Record<string, string> = {
  builtin: '内置',
  kit: '自有',
  external: '外部',
};

function isOwnKitPlugin(plugin: PluginItem): boolean {
  return plugin.source === 'kit' && plugin.kind !== 'builtin';
}

function labelOf(plugin: PluginItem): string {
  return plugin.sourceLabel ?? SOURCE_LABEL[plugin.source] ?? plugin.source;
}

export default {
  async mount(context: PanelContext) {
    const root = document.getElementById('panel-root');
    if (!root) return;
    root.innerHTML = '<header><span>正在读取…</span></header><main></main>';
    const status = root.querySelector('header span');
    const list = root.querySelector('main');
    try {
      const summary = await context.message.request('plugin', 'getPluginSummary') as PluginSummary;
      const plugins = summary.plugins ?? [];
      const loadedCount = summary.loadedCount ?? plugins.filter((plugin) => plugin.loaded).length;
      const updateStatus = () => {
        const currentLoadedCount = plugins.filter((plugin) => plugin.loaded).length;
        if (status) status.textContent = `插件：${currentLoadedCount}/${plugins.length}`;
      };
      if (status) status.textContent = `插件：${loadedCount}/${plugins.length}`;
      if (!list) return;
      if (!plugins.length) { list.textContent = '没有已注册的插件'; return; }

      const renderPluginItem = (plugin: PluginItem): HTMLElement => {
        const item = document.createElement('article');
        item.innerHTML = '<strong></strong><div class="meta"><div class="details"><span class="type"></span><span class="stats"></span></div><div class="actions"><button class="btn-restart" type="button">重启</button></div></div><div class="feedback" hidden></div>';

        const titleEl = item.querySelector('strong') as HTMLElement;
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.dataset.source = plugin.source;
        badge.textContent = labelOf(plugin);
        const nameEl = document.createElement('span');
        nameEl.className = 'plugin-name';
        nameEl.textContent = plugin.name;
        titleEl.textContent = '';
        titleEl.append(badge, nameEl);

        const typeEl = item.querySelector('.type') as HTMLElement;
        const statsEl = item.querySelector('.stats') as HTMLElement;
        const stateLabel = plugin.loaded ? '已加载' : '已关闭';
        typeEl.textContent = stateLabel;
        statsEl.textContent = `${plugin.panelCount} panels · ${plugin.requestCount} requests · ${plugin.broadcastCount} broadcasts`;

        const restartBtn = item.querySelector('.btn-restart') as HTMLButtonElement;
        const feedback = item.querySelector('.feedback') as HTMLElement;

        const manageable = isOwnKitPlugin(plugin);
        if (!manageable) {
          restartBtn.disabled = true;
          restartBtn.title = '仅当前 Kit 的非 builtin 插件可操作';
        }

        const setFeedback = (text: string, tone: 'info' | 'error' | 'success' = 'info') => {
          feedback.textContent = text;
          feedback.dataset.tone = tone;
          feedback.hidden = !text;
        };

        const setBusy = (busy: boolean) => {
          restartBtn.disabled = busy || !manageable;
        };

        const setState = (loaded: boolean) => {
          plugin.loaded = loaded;
          typeEl.textContent = loaded ? '已加载' : '已关闭';
          updateStatus();
        };

        restartBtn.addEventListener('click', async () => {
          setBusy(true);
          setFeedback('');
          try {
            const result = await context.message.request('plugin', 'restart', plugin.name) as LifecycleResult;
            if (result.ok) {
              setState(true);
            } else {
              setFeedback(`重启失败: ${result.error ?? '未知错误'}`, 'error');
            }
          } catch (error) {
            setFeedback(`重启失败: ${error instanceof Error ? error.message : String(error)}`, 'error');
          }
          setBusy(false);
        });

        return item;
      };

      for (const group of GROUPS) {
        const groupPlugins = plugins.filter((plugin) => plugin.source === group.key);
        if (!groupPlugins.length) continue;

        const section = document.createElement('section');
        section.className = 'group';
        section.dataset.source = group.key;

        const heading = document.createElement('h2');
        heading.className = 'group-title';
        heading.textContent = `${group.title} (${groupPlugins.length})`;
        section.append(heading);

        const grid = document.createElement('div');
        grid.className = 'group-grid';
        for (const plugin of groupPlugins) grid.append(renderPluginItem(plugin));
        section.append(grid);

        list.append(section);
      }
    } catch (error) {
      if (status) status.textContent = '读取失败';
      if (list) list.textContent = error instanceof Error ? error.message : String(error);
    }
  },
};
