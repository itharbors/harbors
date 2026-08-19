type PanelContext = {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
};

type Layer = 'default' | 'global' | 'project';
type SettingControl = 'text' | 'textarea' | 'number' | 'toggle' | 'select';
type SettingOption = { label: string; value: string | number };
type SettingField = {
  key: string;
  label: string;
  description?: string;
  control: SettingControl;
  defaultValue?: string | number | boolean;
  layers: Array<'global' | 'project'>;
  defaultLayer: 'global' | 'project';
  options?: SettingOption[];
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
};
type SettingFieldViewModel = {
  owner: string;
  section: string;
  field: SettingField;
  resolvedValue: string | number | boolean | null;
  resolvedLayer: Layer | null;
  perLayer: Record<Layer, string | number | boolean | null>;
};
type SettingsViewModel = {
  sections: Array<{
    owner: string;
    section: { id: string; title: string; description?: string };
    fields: SettingFieldViewModel[];
  }>;
};

let reloadPanel: (() => void) | null = null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function layerLabel(layer: Layer): string {
  return layer === 'project' ? '当前项目' : layer === 'global' ? '全局' : '默认值';
}

function sourceLabel(layer: Layer | null): string {
  return layerLabel(layer ?? 'default');
}

function valueForLayer(model: SettingFieldViewModel, layer: Layer): string | number | boolean | null {
  return model.perLayer[layer] ?? model.resolvedValue;
}

const definition = {
  async mount(ctx: PanelContext) {
    const root = document.getElementById('panel-root');
    if (!root) return;
    root.innerHTML = '<header class="panel-header"><div class="header-copy"><h1>设置</h1><p class="header-subtitle">插件配置</p></div><button id="refresh-btn" class="refresh-button" type="button"><span aria-hidden="true">↻</span>刷新</button></header><main id="settings-list" aria-live="polite"></main>';
    const list = root.querySelector('#settings-list') as HTMLElement;
    const refreshButton = root.querySelector('#refresh-btn') as HTMLButtonElement;

    function showMessage(message: string, kind: 'loading' | 'empty' | 'error') {
      const element = document.createElement('p');
      element.className = kind;
      element.textContent = message;
      list.replaceChildren(element);
    }

    function renderField(model: SettingFieldViewModel): HTMLElement {
      const field = model.field;
      const item = document.createElement('article');
      item.className = 'setting-field';

      const heading = document.createElement('div');
      heading.className = 'field-heading';
      const text = document.createElement('div');
      const label = document.createElement('label');
      label.className = 'field-label';
      label.textContent = field.label;
      const id = `setting-${field.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
      label.htmlFor = id;
      text.append(label);
      if (field.description) {
        const description = document.createElement('p');
        description.className = 'field-description';
        description.textContent = field.description;
        text.append(description);
      }
      const source = document.createElement('span');
      source.className = 'field-source';
      source.textContent = `当前来自 ${sourceLabel(model.resolvedLayer)}`;
      heading.append(text, source);

      const controls = document.createElement('div');
      controls.className = 'field-controls';
      const layerSelect = document.createElement('select');
      layerSelect.className = 'layer-select';
      layerSelect.setAttribute('aria-label', `${field.label} 保存层`);
      for (const layer of field.layers) {
        const option = document.createElement('option');
        option.value = layer;
        option.textContent = layerLabel(layer);
        layerSelect.append(option);
      }
      const selectedLayer = field.defaultLayer;
      layerSelect.value = selectedLayer;

      const valueHost = document.createElement('div');
      valueHost.className = 'value-host';
      let valueControl: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      let resetButton: HTMLButtonElement | null = null;

      function renderValueControl() {
        valueHost.replaceChildren();
        if (resetButton) resetButton.disabled = model.perLayer[layerSelect.value as Layer] === null;
        const value = valueForLayer(model, layerSelect.value as Layer);
        if (field.control === 'textarea') {
          const textarea = document.createElement('textarea');
          textarea.id = id;
          textarea.rows = 2;
          textarea.value = typeof value === 'string' ? value : value == null ? '' : String(value);
          if (field.placeholder) textarea.placeholder = field.placeholder;
          valueControl = textarea;
        } else if (field.control === 'select') {
          const select = document.createElement('select');
          select.id = id;
          for (const entry of field.options ?? []) {
            const option = document.createElement('option');
            option.value = String(entry.value);
            option.textContent = entry.label;
            option.selected = entry.value === value;
            select.append(option);
          }
          valueControl = select;
        } else {
          const input = document.createElement('input');
          input.id = id;
          input.type = field.control === 'toggle' ? 'checkbox' : field.control === 'number' ? 'number' : 'text';
          if (field.control === 'toggle') input.checked = value === true;
          else input.value = value == null ? '' : String(value);
          if (field.placeholder) input.placeholder = field.placeholder;
          if (field.min !== undefined) input.min = String(field.min);
          if (field.max !== undefined) input.max = String(field.max);
          if (field.step !== undefined) input.step = String(field.step);
          valueControl = input;
        }
        valueHost.append(valueControl);
      }
      renderValueControl();
      layerSelect.addEventListener('change', renderValueControl);

      const actions = document.createElement('div');
      actions.className = 'field-actions';
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'save-button';
      save.textContent = '保存';
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'reset-button';
      reset.textContent = '重置';
      resetButton = reset;
      reset.disabled = model.perLayer[selectedLayer] === null;
      const feedback = document.createElement('span');
      feedback.className = 'field-feedback';

      function setFeedback(message: string, kind: 'success' | 'error') {
        feedback.textContent = message;
        feedback.dataset.kind = kind;
      }

      save.addEventListener('click', async () => {
        save.disabled = true;
        feedback.textContent = '';
        try {
          let value: string | number | boolean;
          if (field.control === 'toggle') value = (valueControl as HTMLInputElement).checked;
          else if (field.control === 'number') value = Number(valueControl.value);
          else if (field.control === 'select') value = (field.options ?? []).find((option) => String(option.value) === (valueControl as HTMLSelectElement).value)?.value as string | number;
          else value = valueControl.value;
          await ctx.message.request('settings', 'setValue', { key: field.key, layer: layerSelect.value, value });
          setFeedback('已保存', 'success');
          await loadSettings();
        } catch (error) {
          setFeedback(errorText(error), 'error');
        } finally {
          save.disabled = false;
        }
      });

      reset.addEventListener('click', async () => {
        reset.disabled = true;
        feedback.textContent = '';
        try {
          await ctx.message.request('settings', 'resetValue', { key: field.key, layer: layerSelect.value });
          await loadSettings();
        } catch (error) {
          setFeedback(errorText(error), 'error');
          reset.disabled = false;
        }
      });

      actions.append(save, reset, feedback);
      const footer = document.createElement('div');
      footer.className = 'field-footer';
      footer.append(layerSelect, actions);
      controls.append(valueHost, footer);
      item.append(heading, controls);
      return item;
    }

    function renderViewModel(model: SettingsViewModel) {
      if (model.sections.length === 0) {
        showMessage('暂无插件设置', 'empty');
        return;
      }
      const fragment = document.createDocumentFragment();
      for (const group of model.sections) {
        const section = document.createElement('section');
        section.className = 'settings-section';
        const sectionHeading = document.createElement('div');
        sectionHeading.className = 'section-heading';
        const title = document.createElement('h3');
        title.textContent = group.section.title;
        const owner = document.createElement('code');
        owner.className = 'section-owner';
        owner.textContent = group.owner;
        sectionHeading.append(title, owner);
        section.append(sectionHeading);
        if (group.section.description) {
          const description = document.createElement('p');
          description.className = 'section-description';
          description.textContent = group.section.description;
          section.append(description);
        }
        for (const field of group.fields) section.append(renderField(field));
        fragment.append(section);
      }
      list.replaceChildren(fragment);
    }

    async function loadSettings() {
      showMessage('正在读取…', 'loading');
      try {
        renderViewModel(await ctx.message.request('settings', 'getViewModel') as SettingsViewModel);
      } catch (error) {
        showMessage(errorText(error), 'error');
      }
    }

    reloadPanel = () => { void loadSettings(); };
    refreshButton.addEventListener('click', () => { void loadSettings(); });
    await loadSettings();
  },

  unmount() {
    reloadPanel = null;
  },

  methods: {
    onConfigChanged() {
      reloadPanel?.();
    },
    onRegistryChanged() {
      reloadPanel?.();
    },
  },
};

export default definition;
