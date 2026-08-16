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

function isOwnKitPlugin(plugin: PluginItem): boolean {
  return plugin.source === 'kit' && plugin.kind !== 'builtin';
}

export default {
  async mount(context: PanelContext) {
    const root = document.getElementById('panel-root');
    if (!root) return;
    root.innerHTML = '<header><strong>插件列表</strong><span>正在读取…</span></header><main></main>';
    const status = root.querySelector('header span');
    const list = root.querySelector('main');
    try {
      const summary = await context.message.request('plugin-list', 'getPluginSummary') as { activeKitName?: string; plugins?: PluginItem[] };
      const plugins = summary.plugins ?? [];
      if (status) status.textContent = `${plugins.length} 个 · 当前 Kit: ${summary.activeKitName ?? 'unknown'}`;
      if (!list) return;
      if (!plugins.length) { list.textContent = '没有已加载的插件'; return; }
      for (const plugin of plugins) {
        const item = document.createElement('article');
        item.innerHTML = '<strong></strong><div class="meta"><span class="type"></span><div class="actions"><button class="btn-unload" type="button">关闭</button><button class="btn-restart" type="button">重启</button></div></div><div class="feedback"></div>';
        item.querySelector('strong')!.textContent = plugin.name;

        const typeEl = item.querySelector('.type') as HTMLElement;
        const stateLabel = plugin.loaded ? '已加载' : '未加载';
        typeEl.textContent = `${plugin.source} · ${stateLabel} · ${plugin.panelCount} panels · ${plugin.requestCount} requests`;

        const unloadBtn = item.querySelector('.btn-unload') as HTMLButtonElement;
        const restartBtn = item.querySelector('.btn-restart') as HTMLButtonElement;
        const feedback = item.querySelector('.feedback') as HTMLElement;

        const manageable = isOwnKitPlugin(plugin);
        if (!manageable) {
          unloadBtn.disabled = true;
          restartBtn.disabled = true;
          unloadBtn.title = '仅当前 Kit 的非 builtin 插件可操作';
          restartBtn.title = '仅当前 Kit 的非 builtin 插件可操作';
        }
        unloadBtn.disabled = unloadBtn.disabled || !plugin.loaded;

        const setFeedback = (text: string, tone: 'info' | 'error' | 'success' = 'info') => {
          feedback.textContent = text;
          feedback.dataset.tone = tone;
        };

        const setBusy = (busy: boolean) => {
          unloadBtn.disabled = busy || !manageable || !plugin.loaded;
          restartBtn.disabled = busy || !manageable;
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
            } else {
              setFeedback(`关闭失败: ${result.error ?? '未知错误'}`, 'error');
            }
          } catch (error) {
            setFeedback(`关闭失败: ${error instanceof Error ? error.message : String(error)}`, 'error');
          }
          setBusy(false);
        });

        restartBtn.addEventListener('click', async () => {
          setBusy(true);
          setFeedback('重启中…', 'info');
          try {
            const result = await context.message.request('plugin-list', 'restart', plugin.name) as LifecycleResult;
            if (result.ok) {
              plugin.loaded = true;
              setFeedback('已重启', 'success');
              typeEl.textContent = typeEl.textContent.replace('未加载', '已加载');
            } else {
              setFeedback(`重启失败: ${result.error ?? '未知错误'}`, 'error');
            }
          } catch (error) {
            setFeedback(`重启失败: ${error instanceof Error ? error.message : String(error)}`, 'error');
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
