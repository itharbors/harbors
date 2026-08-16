type PluginItem = {
  name: string;
  path: string;
  kind: string;
  source: string;
  loaded: boolean;
  panelCount: number;
  requestCount: number;
};

type PanelContext = {
  message: { request(plugin: string, name: string, ...args: unknown[]): Promise<unknown> };
};

type LifecycleResult = { ok: boolean; error?: string };
type PluginSummary = { activeKitName?: string; loadedCount?: number; plugins?: PluginItem[] };

function isOwnKitPlugin(plugin: PluginItem): boolean {
  return plugin.source === 'kit' && plugin.kind !== 'builtin';
}

export default {
  async mount(context: PanelContext) {
    const root = document.getElementById('panel-root');
    if (!root) return;
    root.innerHTML = '<header><span>正在读取…</span></header><main></main>';
    const status = root.querySelector('header span');
    const list = root.querySelector('main');
    try {
      const summary = await context.message.request('plugin-list', 'getPluginSummary') as PluginSummary;
      const plugins = summary.plugins ?? [];
      const loadedCount = summary.loadedCount ?? plugins.filter((plugin) => plugin.loaded).length;
      const updateStatus = () => {
        const currentLoadedCount = plugins.filter((plugin) => plugin.loaded).length;
        if (status) status.textContent = `插件：${currentLoadedCount}/${plugins.length}`;
      };
      if (status) status.textContent = `插件：${loadedCount}/${plugins.length}`;
      if (!list) return;
      if (!plugins.length) { list.textContent = '没有已注册的插件'; return; }
      for (const plugin of plugins) {
        const item = document.createElement('article');
        item.innerHTML = '<strong></strong><div class="meta"><span class="type"></span><div class="actions"><button class="btn-unload" type="button">关闭</button><button class="btn-load" type="button">启动</button></div></div><div class="feedback"></div>';
        item.querySelector('strong')!.textContent = plugin.name;

        const typeEl = item.querySelector('.type') as HTMLElement;
        const stateLabel = plugin.loaded ? '已加载' : '未加载';
        typeEl.textContent = `${plugin.source} · ${stateLabel} · ${plugin.panelCount} panels · ${plugin.requestCount} requests`;

        const unloadBtn = item.querySelector('.btn-unload') as HTMLButtonElement;
        const loadBtn = item.querySelector('.btn-load') as HTMLButtonElement;
        const feedback = item.querySelector('.feedback') as HTMLElement;

        const manageable = isOwnKitPlugin(plugin);
        if (!manageable) {
          unloadBtn.disabled = true;
          loadBtn.disabled = true;
          unloadBtn.title = '仅当前 Kit 的非 builtin 插件可操作';
          loadBtn.title = '仅当前 Kit 的非 builtin 插件可操作';
        }
        unloadBtn.disabled = unloadBtn.disabled || !plugin.loaded;
        loadBtn.disabled = loadBtn.disabled || plugin.loaded;

        const setFeedback = (text: string, tone: 'info' | 'error' | 'success' = 'info') => {
          feedback.textContent = text;
          feedback.dataset.tone = tone;
        };

        const setBusy = (busy: boolean) => {
          unloadBtn.disabled = busy || !manageable || !plugin.loaded;
          loadBtn.disabled = busy || !manageable || plugin.loaded;
        };

        unloadBtn.addEventListener('click', async () => {
          setBusy(true);
          setFeedback('关闭中…', 'info');
          try {
            const result = await context.message.request('plugin-list', 'unload', plugin.name) as LifecycleResult;
            if (result.ok) {
              plugin.loaded = false;
              setFeedback('已关闭', 'success');
              typeEl.textContent = typeEl.textContent.replace('已加载', '未加载');
              updateStatus();
            } else {
              setFeedback(`关闭失败: ${result.error ?? '未知错误'}`, 'error');
            }
          } catch (error) {
            setFeedback(`关闭失败: ${error instanceof Error ? error.message : String(error)}`, 'error');
          }
          setBusy(false);
        });

        loadBtn.addEventListener('click', async () => {
          setBusy(true);
          setFeedback('启动中…', 'info');
          try {
            const result = await context.message.request('plugin-list', 'load', plugin.name) as LifecycleResult;
            if (result.ok) {
              plugin.loaded = true;
              setFeedback('已启动', 'success');
              typeEl.textContent = typeEl.textContent.replace('未加载', '已加载');
              updateStatus();
            } else {
              setFeedback(`启动失败: ${result.error ?? '未知错误'}`, 'error');
            }
          } catch (error) {
            setFeedback(`启动失败: ${error instanceof Error ? error.message : String(error)}`, 'error');
          }
          setBusy(false);
        });

        list.append(item);
      }
    } catch (error) {
      if (status) status.textContent = '读取失败';
      if (list) list.textContent = error instanceof Error ? error.message : String(error);
    }
  },
};
