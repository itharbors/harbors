type PanelContext = { message?: { request(plugin: string, name: string, ...args: unknown[]): Promise<unknown> } };
type MessageRequest = (plugin: string, name: string, ...args: unknown[]) => Promise<unknown>;

type Provider = {
  id: string;
  name: string;
  protocol: 'openai-chat-completions' | 'anthropic-messages' | 'openai-completions';
  baseUrl: string;
  models: Model[];
  defaultModel?: string;
  credentialConfigured: boolean;
};
type Settings = { defaultProviderId?: string; providers: Provider[] };
type Model = {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  reasoningEfforts?: string[];
  serviceTiers?: string[];
  defaultReasoningEffort?: string;
  defaultServiceTier?: string;
  webSearch?: boolean;
};
type ModelDraft = Omit<Model, 'id' | 'name' | 'description' | 'contextWindow'> & { id: string; name: string; description: string; contextWindow: string };

let sequence = 0;
type PendingRequest = { resolve(value: unknown): void; reject(error: Error): void; timeout: number };
const pending = new Map<string, PendingRequest>();
let activeRequest: MessageRequest | null = null;

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function request(method: string, payload?: unknown): Promise<unknown> {
  if (!activeRequest) return Promise.reject(new Error('设置页面不可用'));
  const requestId = `model-service-settings-${Date.now()}-${sequence += 1}`;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      const entry = pending.get(requestId);
      if (!entry) return;
      pending.delete(requestId);
      entry.reject(new Error('设置请求超时'));
    }, 15_000);
    pending.set(requestId, { resolve, reject, timeout });
    const args = payload === undefined ? [] : [payload];
    Promise.resolve()
      .then(() => activeRequest?.('model-service', method, ...args))
      .then((result) => {
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        window.clearTimeout(entry.timeout);
        resolve(result);
      }, (error) => {
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        window.clearTimeout(entry.timeout);
        reject(error instanceof Error ? error : new Error(errorText(error)));
      });
  });
}

function createModelDraft(model?: Model): ModelDraft {
  return {
    id: model?.id || '',
    name: model?.name || '',
    description: model?.description || '',
    contextWindow: typeof model?.contextWindow === 'number' ? String(model.contextWindow) : '',
    ...(model?.reasoningEfforts ? { reasoningEfforts: [...model.reasoningEfforts] } : {}),
    ...(model?.serviceTiers ? { serviceTiers: [...model.serviceTiers] } : {}),
    ...(model?.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
    ...(model?.defaultServiceTier ? { defaultServiceTier: model.defaultServiceTier } : {}),
    ...(typeof model?.webSearch === 'boolean' ? { webSearch: model.webSearch } : {}),
  };
}

function serializeModelDrafts(drafts: ModelDraft[]): Model[] {
  const ids = new Set<string>();
  return drafts.map((draft, index) => {
    const id = draft.id.trim();
    if (!id) throw new Error(`模型 ${index + 1} 的 ID 不能为空`);
    if (ids.has(id)) throw new Error(`模型 ID 重复：${id}`);
    ids.add(id);
    const contextText = draft.contextWindow.trim();
    let contextWindow: number | undefined;
    if (contextText) {
      contextWindow = Number(contextText);
      if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) throw new Error(`模型 ${id} 的上下文窗口必须是正整数`);
    }
    const model: Model = { id, name: draft.name.trim() || id };
    if (draft.description.trim()) model.description = draft.description.trim();
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    if (draft.reasoningEfforts?.length) model.reasoningEfforts = [...draft.reasoningEfforts];
    if (draft.serviceTiers?.length) model.serviceTiers = [...draft.serviceTiers];
    if (draft.defaultReasoningEffort) model.defaultReasoningEffort = draft.defaultReasoningEffort;
    if (draft.defaultServiceTier) model.defaultServiceTier = draft.defaultServiceTier;
    if (typeof draft.webSearch === 'boolean') model.webSearch = draft.webSearch;
    return model;
  });
}

function normalizeSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as { providers?: unknown }).providers)) throw new Error('模型服务设置响应无效');
  const raw = value as { defaultProviderId?: unknown; providers: unknown[] };
  const providers = raw.providers.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const provider = item as Record<string, unknown>;
    if (typeof provider.id !== 'string' || !provider.id || typeof provider.name !== 'string' || typeof provider.baseUrl !== 'string' || !Array.isArray(provider.models)) return [];
    const protocol: Provider['protocol'] = provider.protocol === 'anthropic-messages' || provider.protocol === 'openai-completions' ? provider.protocol : 'openai-chat-completions';
    const models = provider.models.flatMap((model) => {
      if (!model || typeof model !== 'object' || Array.isArray(model)) return [];
      const candidate = model as Record<string, unknown>;
      if (typeof candidate.id !== 'string' || !candidate.id) return [];
      return [{
        id: candidate.id,
        name: typeof candidate.name === 'string' && candidate.name ? candidate.name : candidate.id,
        ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
        ...(typeof candidate.contextWindow === 'number' && Number.isFinite(candidate.contextWindow) ? { contextWindow: candidate.contextWindow } : {}),
        ...(Array.isArray(candidate.reasoningEfforts) ? { reasoningEfforts: candidate.reasoningEfforts.filter((item): item is string => typeof item === 'string' && Boolean(item)) } : {}),
        ...(Array.isArray(candidate.serviceTiers) ? { serviceTiers: candidate.serviceTiers.filter((item): item is string => typeof item === 'string' && Boolean(item)) } : {}),
        ...(typeof candidate.defaultReasoningEffort === 'string' && candidate.defaultReasoningEffort ? { defaultReasoningEffort: candidate.defaultReasoningEffort } : {}),
        ...(typeof candidate.defaultServiceTier === 'string' && candidate.defaultServiceTier ? { defaultServiceTier: candidate.defaultServiceTier } : {}),
        ...(typeof candidate.webSearch === 'boolean' ? { webSearch: candidate.webSearch } : {}),
      }];
    });
    return [{
      id: provider.id,
      name: provider.name,
      protocol,
      baseUrl: provider.baseUrl,
      models,
      ...(typeof provider.defaultModel === 'string' && provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
      credentialConfigured: provider.credentialConfigured === true,
    }];
  });
  return { ...(typeof raw.defaultProviderId === 'string' && raw.defaultProviderId ? { defaultProviderId: raw.defaultProviderId } : {}), providers };
}

function providerModelNames(provider: Provider): string {
  return provider.models.map((model) => typeof model.id === 'string' ? model.id : '').filter(Boolean).join('、') || '未导入模型';
}

const definition = {
  async mount(_ctx: PanelContext) {
    definition.unmount();
    if (typeof _ctx?.message?.request !== 'function') return;
    activeRequest = _ctx.message.request;
    const root = document.getElementById('panel-root');
    if (!root) return;
    root.innerHTML = '<main class="page"><header class="header"><div><h1>模型服务</h1><p class="subtitle">管理 Provider、模型和凭据。Token 只写入凭据库，永不回显。</p></div><div class="toolbar"><button id="refresh" type="button">刷新</button><button id="add" class="primary" type="button">新增 Provider</button></div></header><p id="status" class="status" aria-live="polite"></p><section id="providers" class="provider-list" aria-live="polite"></section></main>';
    const list = root.querySelector('#providers') as HTMLElement;
    const status = root.querySelector('#status') as HTMLElement;
    let settings: Settings = { providers: [] };
    let selectedId: string | undefined;

    function setStatus(message: string, kind?: 'success' | 'error') { status.textContent = message; status.dataset.kind = kind || ''; }
    function input<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(form: HTMLElement, name: string): T { return form.querySelector(`[name="${name}"]`) as T; }
    function render(): void {
      if (!settings.providers.length) { list.innerHTML = '<p class="empty">尚未配置 Provider，点击“新增 Provider”开始。</p>'; return; }
      list.replaceChildren(...settings.providers.map((provider) => renderProvider(provider)));
    }
    function renderProvider(provider: Provider): HTMLElement {
      const card = document.createElement('article');
      card.className = `provider-card${provider.id === selectedId ? ' selected' : ''}`;
      card.innerHTML = `<div class="card-head"><div class="card-title"><h2>${escapeHtml(provider.name || provider.id)}</h2><p>${escapeHtml(provider.id)} · ${escapeHtml(providerModelNames(provider))}</p></div><span class="badge${provider.credentialConfigured ? ' configured' : ''}">${provider.credentialConfigured ? '凭据已配置' : '未配置凭据'}</span></div>`;
      const form = document.createElement('form');
      form.className = 'form-grid';
      form.innerHTML = `<div class="field"><label>Provider ID<input name="id" required value="${escapeAttr(provider.id)}" /></label></div><div class="field"><label>名称<input name="name" required value="${escapeAttr(provider.name)}" /></label></div><div class="field"><label>协议<select name="protocol"><option value="openai-chat-completions">OpenAI Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option><option value="openai-completions">OpenAI Completions</option></select></label></div><div class="field"><label>Base URL<input name="baseUrl" value="${escapeAttr(provider.baseUrl)}" /></label></div><div class="field full"><div class="models-heading"><div><label>模型</label><p class="hint">填写模型 ID、名称、描述和上下文窗口。</p></div><button name="addModel" type="button">添加模型</button></div><div class="models-editor" data-models-editor></div></div><div class="field"><label>默认模型<select name="defaultModel"></select></label><p class="hint" data-default-model-hint></p></div><div class="field"><label>新 Token（可选）<input name="secret" type="password" autocomplete="new-password" placeholder="留空表示保持现有 Token" /></label></div><div class="field full"><div class="card-actions"><button name="reset" class="danger" type="button" ${provider.credentialConfigured ? '' : 'disabled'}>重置 Token</button><button name="delete" class="danger" type="button">删除 Provider</button><button class="primary" type="submit">保存</button></div></div>`;
      input<HTMLSelectElement>(form, 'protocol').value = provider.protocol;
      const modelsEditor = form.querySelector('[data-models-editor]') as HTMLElement;
      const defaultModelSelect = input<HTMLSelectElement>(form, 'defaultModel');
      const defaultModelHint = form.querySelector('[data-default-model-hint]') as HTMLElement;
      let selectedDefaultModel = provider.defaultModel || '';
      let modelDrafts = provider.models.map((model) => createModelDraft(model));
      function renderModelDrafts(): void {
        if (!modelDrafts.length) modelDrafts = [createModelDraft()];
        modelsEditor.replaceChildren(...modelDrafts.map((draft, index) => {
          const block = document.createElement('fieldset');
          block.className = 'model-block';
          block.dataset.index = String(index);
          block.innerHTML = `<legend>模型 ${index + 1}</legend><div class="model-block-grid"><label>ID<input data-model-field="id" required value="${escapeAttr(draft.id)}" /></label><label>名称<input data-model-field="name" value="${escapeAttr(draft.name)}" /></label><label class="wide">描述<textarea data-model-field="description" rows="2">${escapeHtml(draft.description)}</textarea></label><label>上下文窗口<input data-model-field="contextWindow" type="number" min="1" step="1" value="${escapeAttr(draft.contextWindow)}" placeholder="留空" /></label><button data-remove-model type="button" class="danger model-remove" ${modelDrafts.length <= 1 ? 'disabled' : ''}>移除</button></div>`;
          return block;
        }));
        syncDefaultModelOptions();
      }
      function readModelDrafts(): void {
        const previousDrafts = modelDrafts;
        modelDrafts = Array.from(modelsEditor.querySelectorAll<HTMLElement>('.model-block')).map((block, index) => {
          const value = (name: keyof ModelDraft): string => (block.querySelector(`[data-model-field="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
          const previous = previousDrafts[index];
          return { id: value('id'), name: value('name'), description: value('description'), contextWindow: value('contextWindow'), ...(previous?.reasoningEfforts ? { reasoningEfforts: previous.reasoningEfforts } : {}), ...(previous?.serviceTiers ? { serviceTiers: previous.serviceTiers } : {}), ...(previous?.defaultReasoningEffort ? { defaultReasoningEffort: previous.defaultReasoningEffort } : {}), ...(previous?.defaultServiceTier ? { defaultServiceTier: previous.defaultServiceTier } : {}), ...(typeof previous?.webSearch === 'boolean' ? { webSearch: previous.webSearch } : {}) };
        });
      }
      function syncDefaultModelOptions(): void {
        readModelDrafts();
        const current = selectedDefaultModel;
        const ids = modelDrafts.map((draft) => draft.id.trim()).filter(Boolean);
        defaultModelSelect.innerHTML = `<option value="">未设置</option>${ids.map((id) => `<option value="${escapeAttr(id)}">${escapeHtml(id)}</option>`).join('')}`;
        if (current && !ids.includes(current)) {
          defaultModelSelect.insertAdjacentHTML('beforeend', `<option value="${escapeAttr(current)}">${escapeHtml(current)}（已失效）</option>`);
          defaultModelHint.textContent = '当前默认模型不在模型列表中，保存时将保留该值；请选择新的模型以修复。';
        } else defaultModelHint.textContent = '';
        defaultModelSelect.value = current;
      }
      renderModelDrafts();
      form.addEventListener('focusin', () => { selectedId = provider.id; });
      modelsEditor.addEventListener('input', (event) => {
        const target = event.target as HTMLElement;
        const block = target.closest('.model-block');
        if (!block) return;
        syncDefaultModelOptions();
      });
      modelsEditor.addEventListener('change', () => { syncDefaultModelOptions(); });
      defaultModelSelect.addEventListener('change', () => { selectedDefaultModel = defaultModelSelect.value; syncDefaultModelOptions(); });
      modelsEditor.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        if (!target.matches('[data-remove-model]')) return;
        readModelDrafts();
        const index = Number((target.closest('.model-block') as HTMLElement).dataset.index);
        modelDrafts.splice(index, 1);
        renderModelDrafts();
      });
      (form.querySelector('[name="addModel"]') as HTMLButtonElement).addEventListener('click', () => {
        readModelDrafts();
        modelDrafts.push(createModelDraft());
        renderModelDrafts();
        const blocks = modelsEditor.querySelectorAll('.model-block');
        (blocks[blocks.length - 1]?.querySelector('[data-model-field="id"]') as HTMLInputElement | null)?.focus();
      });
      const saveProvider = async () => {
        readModelDrafts();
        let models: Model[];
        try { models = serializeModelDrafts(modelDrafts); } catch (error) { setStatus(errorText(error), 'error'); return; }
        const save = form.querySelector('button[type="submit"]') as HTMLButtonElement;
        save.disabled = true;
        try {
          const nextId = input<HTMLInputElement>(form, 'id').value.trim();
          settings = normalizeSettings(await request('saveProvider', { id: nextId, previousId: provider.id, name: input<HTMLInputElement>(form, 'name').value.trim(), protocol: input<HTMLSelectElement>(form, 'protocol').value, baseUrl: input<HTMLInputElement>(form, 'baseUrl').value, models, defaultModel: defaultModelSelect.value.trim(), secret: input<HTMLInputElement>(form, 'secret').value }));
          selectedId = nextId;
          setStatus('已保存，Token 输入已清空', 'success');
          render();
        } catch (error) { setStatus(errorText(error), 'error'); } finally { save.disabled = false; }
      };
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void saveProvider();
      });
      const saveButton = form.querySelector('button[type="submit"]') as HTMLButtonElement;
      saveButton.addEventListener('click', (event) => {
        // Embedded Web hosts may not dispatch native form submit for an iframe button.
        // Handle the real click explicitly and prevent the browser's follow-up submit
        // so one click always creates exactly one settings request.
        event.preventDefault();
        void saveProvider();
      });
      (form.querySelector('[name="delete"]') as HTMLButtonElement).addEventListener('click', async () => {
        const button = form.querySelector('[name="delete"]') as HTMLButtonElement;
        button.disabled = true;
        try { await request('deleteProvider', provider.id); settings = normalizeSettings(await request('getSettings')); selectedId = undefined; setStatus('Provider 已删除', 'success'); render(); } catch (error) { setStatus(errorText(error), 'error'); button.disabled = false; }
      });
      (form.querySelector('[name="reset"]') as HTMLButtonElement).addEventListener('click', async () => {
        const button = form.querySelector('[name="reset"]') as HTMLButtonElement;
        button.disabled = true;
        try { settings = normalizeSettings(await request('resetProviderCredential', { providerId: provider.id })); setStatus('Token 已重置', 'success'); render(); } catch (error) { setStatus(errorText(error), 'error'); button.disabled = false; }
      });
      card.append(form);
      return card;
    }
    function load() { setStatus('正在读取…'); return request('getSettings').then((value) => { settings = normalizeSettings(value); selectedId = settings.defaultProviderId || settings.providers[0]?.id; render(); setStatus(''); }).catch((error) => { list.innerHTML = `<p class="error">${escapeHtml(errorText(error))}</p>`; setStatus('读取失败', 'error'); }); }
    root.querySelector('#refresh')?.addEventListener('click', () => { void load(); });
    root.querySelector('#add')?.addEventListener('click', () => { const provider = { id: `provider-${Date.now()}`, name: '新 Provider', protocol: 'openai-chat-completions' as const, baseUrl: '', models: [], credentialConfigured: false }; settings.providers = [...settings.providers, provider]; selectedId = provider.id; render(); });
    await load();
  },
  unmount() {
    for (const entry of pending.values()) {
      window.clearTimeout(entry.timeout);
      entry.reject(new Error('设置页面已卸载'));
    }
    pending.clear();
    activeRequest = null;
  },
};

function escapeHtml(value: string): string { return value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] || character)); }
function escapeAttr(value: string): string { return escapeHtml(value); }

export default definition;
export { createModelDraft, normalizeSettings, request, serializeModelDrafts };
