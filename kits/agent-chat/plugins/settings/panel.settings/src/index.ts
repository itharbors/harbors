type PanelContext = {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
};

type ConfigEntry = {
  key: string;
  value: unknown;
  perType: Record<string, unknown>;
};

type ConfigListResult = {
  entries: ConfigEntry[];
};

type ValueKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

function detectKind(value: unknown): ValueKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as ValueKind;
}

function parseValue(raw: string, kind: ValueKind): unknown {
  switch (kind) {
    case 'string':
      return raw;
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case 'boolean':
      return raw === 'true' || raw === '1';
    case 'null':
      return null;
    case 'array':
    case 'object':
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

const definition = {
  async mount(ctx: PanelContext) {
    const root = document.getElementById('panel-root');
    if (!root) return;

    root.innerHTML = `
      <header>
        <h1>设置</h1>
        <button id="refresh-btn" type="button">刷新</button>
      </header>
      <section class="add-section">
        <input id="new-key" type="text" placeholder="配置键名" />
        <select id="new-kind">
          <option value="string">字符串</option>
          <option value="number">数字</option>
          <option value="boolean">布尔</option>
          <option value="object">JSON</option>
        </select>
        <span id="new-value-host"></span>
        <button id="add-btn" type="button">添加</button>
      </section>
      <main id="settings-list">
        <p class="loading">正在读取…</p>
      </main>
    `;

    const listEl = root.querySelector('#settings-list') as HTMLElement;
    const refreshBtn = root.querySelector('#refresh-btn') as HTMLButtonElement;
    const newKeyInput = root.querySelector('#new-key') as HTMLInputElement;
    const newKindSelect = root.querySelector('#new-kind') as HTMLSelectElement;
    const newValueHost = root.querySelector('#new-value-host') as HTMLElement;
    const addBtn = root.querySelector('#add-btn') as HTMLButtonElement;

    // 根据类型渲染新增配置的值输入控件
    function renderNewValueInput() {
      const kind = newKindSelect.value as ValueKind;
      newValueHost.innerHTML = '';
      let input: HTMLElement;
      if (kind === 'boolean') {
        input = document.createElement('label');
        input.className = 'checkbox-label';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = 'new-value';
        const span = document.createElement('span');
        span.textContent = 'false';
        cb.addEventListener('change', () => {
          span.textContent = cb.checked ? 'true' : 'false';
        });
        input.append(cb, span);
      } else if (kind === 'object' || kind === 'array') {
        input = document.createElement('textarea');
        (input as HTMLTextAreaElement).id = 'new-value';
        (input as HTMLTextAreaElement).placeholder = 'JSON 值';
        (input as HTMLTextAreaElement).rows = 2;
      } else {
        input = document.createElement('input');
        (input as HTMLInputElement).id = 'new-value';
        (input as HTMLInputElement).type = kind === 'number' ? 'number' : 'text';
        (input as HTMLInputElement).placeholder = '配置值';
      }
      newValueHost.append(input);
    }

    function getNewValue(): unknown {
      const kind = newKindSelect.value as ValueKind;
      if (kind === 'boolean') {
        const cb = newValueHost.querySelector('#new-value') as HTMLInputElement;
        return cb.checked;
      }
      const el = newValueHost.querySelector('#new-value') as HTMLInputElement | HTMLTextAreaElement;
      return parseValue(el.value, kind);
    }

    renderNewValueInput();
    newKindSelect.addEventListener('change', renderNewValueInput);

    async function loadSettings() {
      listEl.innerHTML = '<p class="loading">正在读取…</p>';
      try {
        const result = (await ctx.message.request('settings', 'list')) as ConfigListResult;
        renderEntries(result.entries);
      } catch (err) {
        listEl.innerHTML = `<p class="error">${err instanceof Error ? err.message : String(err)}</p>`;
      }
    }

    function renderEntries(entries: ConfigEntry[]) {
      if (entries.length === 0) {
        listEl.innerHTML = '<p class="empty">暂无配置项</p>';
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const entry of entries) {
        const item = document.createElement('article');
        item.className = 'setting-item';
        const kind = detectKind(entry.value);
        item.innerHTML = `
          <div class="setting-header">
            <span class="setting-key"></span>
            <span class="setting-kind"></span>
            <button class="btn-delete" type="button">删除</button>
          </div>
          <div class="setting-body">
            <span class="value-host"></span>
            <button class="btn-save" type="button">保存</button>
          </div>
          <div class="setting-feedback" hidden></div>
        `;

        const keyEl = item.querySelector('.setting-key') as HTMLElement;
        const kindEl = item.querySelector('.setting-kind') as HTMLElement;
        const valueHost = item.querySelector('.value-host') as HTMLElement;
        const saveBtn = item.querySelector('.btn-save') as HTMLButtonElement;
        const deleteBtn = item.querySelector('.btn-delete') as HTMLButtonElement;
        const feedback = item.querySelector('.setting-feedback') as HTMLElement;

        keyEl.textContent = entry.key;
        kindEl.textContent = kind;
        kindEl.dataset.kind = kind;

        // 根据类型渲染值输入控件
        let valueControl: HTMLElement;
        if (kind === 'boolean') {
          valueControl = document.createElement('label');
          valueControl.className = 'checkbox-label';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = entry.value === true;
          const span = document.createElement('span');
          span.textContent = cb.checked ? 'true' : 'false';
          cb.addEventListener('change', () => {
            span.textContent = cb.checked ? 'true' : 'false';
          });
          valueControl.append(cb, span);
        } else if (kind === 'null') {
          valueControl = document.createElement('span');
          valueControl.className = 'null-value';
          valueControl.textContent = 'null';
        } else if (kind === 'object' || kind === 'array') {
          valueControl = document.createElement('textarea');
          (valueControl as HTMLTextAreaElement).className = 'setting-value';
          (valueControl as HTMLTextAreaElement).value = formatValue(entry.value);
          (valueControl as HTMLTextAreaElement).rows = 2;
        } else {
          valueControl = document.createElement('input');
          (valueControl as HTMLInputElement).className = 'setting-value';
          (valueControl as HTMLInputElement).type = kind === 'number' ? 'number' : 'text';
          (valueControl as HTMLInputElement).value = formatValue(entry.value);
        }
        valueHost.append(valueControl);

        const setFeedback = (text: string, tone: 'info' | 'error' | 'success' = 'info') => {
          feedback.textContent = text;
          feedback.dataset.tone = tone;
          feedback.hidden = !text;
        };

        const getCurrentValue = (): unknown => {
          if (kind === 'boolean') {
            const cb = valueHost.querySelector('input[type="checkbox"]') as HTMLInputElement;
            return cb.checked;
          }
          if (kind === 'null') return null;
          const el = valueHost.querySelector('.setting-value') as HTMLInputElement | HTMLTextAreaElement;
          return parseValue(el.value, kind);
        };

        saveBtn.addEventListener('click', async () => {
          saveBtn.disabled = true;
          setFeedback('');
          try {
            const parsed = getCurrentValue();
            await ctx.message.request('settings', 'set', entry.key, parsed);
            setFeedback('已保存', 'success');
          } catch (err) {
            setFeedback(`保存失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
          } finally {
            saveBtn.disabled = false;
          }
        });

        deleteBtn.addEventListener('click', async () => {
          deleteBtn.disabled = true;
          setFeedback('');
          try {
            await ctx.message.request('settings', 'delete', entry.key);
            item.remove();
            if (listEl.childElementCount === 0) {
              listEl.innerHTML = '<p class="empty">暂无配置项</p>';
            }
          } catch (err) {
            setFeedback(`删除失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
            deleteBtn.disabled = false;
          }
        });

        fragment.append(item);
      }
      listEl.replaceChildren(fragment);
    }

    refreshBtn.addEventListener('click', loadSettings);

    addBtn.addEventListener('click', async () => {
      const key = newKeyInput.value.trim();
      if (!key) return;
      addBtn.disabled = true;
      try {
        const value = getNewValue();
        await ctx.message.request('settings', 'set', key, value);
        newKeyInput.value = '';
        renderNewValueInput();
        await loadSettings();
      } catch (err) {
        alert(`添加失败: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        addBtn.disabled = false;
      }
    });

    await loadSettings();
  },

  methods: {
    onConfigChanged() {
      const root = document.getElementById('panel-root');
      if (!root) return;
      const refreshBtn = root.querySelector('#refresh-btn') as HTMLButtonElement | null;
      refreshBtn?.click();
    },
  },
};

export default definition;
