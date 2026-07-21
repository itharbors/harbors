type PanelContext = {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
};

type PanelDefinition = {
  mount?(ctx: PanelContext): void | Promise<void>;
  methods?: Record<string, (...args: unknown[]) => unknown>;
};

type PluginDetail = {
  name: string;
  source?: string;
  path?: string;
  panelCount?: number;
  requestCount?: number;
  broadcastCount?: number;
  contribute?: {
    panel?: Record<string, unknown>;
    message?: {
      request?: Record<string, unknown>;
      broadcast?: Record<string, unknown>;
    };
  };
};

let context: PanelContext;
let rootElement: HTMLElement | null;

const definition: PanelDefinition = {
  async mount(ctx) {
    context = ctx;
    rootElement = document.getElementById('panel-root');
    if (!rootElement) throw new Error('Panel root element #panel-root not found');

    try {
      const detail = await ctx.message.request('@itharbors/plugin-list', 'getSelectedPlugin');
      renderDetail(detail as PluginDetail | null);
    } catch (err) {
      renderError(err);
    }
  },
  methods: {
    onPluginSelected(detail: unknown) {
      renderDetail(detail as PluginDetail | null);
      return detail;
    },
  },
};

export default definition;

function renderDetail(plugin: PluginDetail | null) {
  if (!context || !rootElement) return;
  rootElement.innerHTML = '';

  if (!plugin) {
    const empty = document.createElement('div');
    empty.className = 'content empty';
    empty.textContent = 'Select a plugin from the list.';
    rootElement.append(empty);
    return;
  }

  const header = document.createElement('div');
  header.className = 'header';

  const eyebrow = document.createElement('div');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'Plugin Detail';

  const name = document.createElement('div');
  name.className = 'name';
  name.title = plugin.name;
  name.textContent = plugin.name;

  header.append(eyebrow, name);

  const content = document.createElement('div');
  content.className = 'content';
  content.append(
    renderMeta(plugin),
    renderOverview(plugin),
    renderContributes('Panels', plugin.contribute?.panel),
    renderContributes('Requests', plugin.contribute?.message?.request),
    renderContributes('Broadcasts', plugin.contribute?.message?.broadcast),
  );

  rootElement.append(header, content);
}

function renderMeta(plugin: PluginDetail) {
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.append(
    createBadge(plugin.source ?? 'external'),
    createBadge(`${plugin.panelCount ?? 0} panels`),
    createBadge(`${plugin.requestCount ?? 0} requests`),
    createBadge(`${plugin.broadcastCount ?? 0} broadcasts`),
  );
  return meta;
}

function renderOverview(plugin: PluginDetail) {
  const section = document.createElement('section');
  section.className = 'section';

  const title = document.createElement('div');
  title.className = 'section-title';
  title.textContent = 'Overview';

  const kv = document.createElement('div');
  kv.className = 'kv';
  appendKv(kv, 'Name', plugin.name);
  appendKv(kv, 'Source', plugin.source ?? 'external');
  appendKv(kv, 'Path', plugin.path ?? 'unknown');

  section.append(title, kv);
  return section;
}

function renderContributes(titleText: string, entries?: Record<string, unknown>) {
  const section = document.createElement('section');
  section.className = 'section';

  const title = document.createElement('div');
  title.className = 'section-title';
  title.textContent = titleText;
  section.append(title);

  const keys = entries && typeof entries === 'object' ? Object.keys(entries) : [];
  if (keys.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'None';
    section.append(empty);
    return section;
  }

  const list = document.createElement('ul');
  list.className = 'list';
  for (const key of keys) {
    const item = document.createElement('li');
    item.className = 'list-item code';
    item.textContent = key;
    list.append(item);
  }
  section.append(list);
  return section;
}

function appendKv(parent: HTMLElement, key: string, value: unknown) {
  const keyNode = document.createElement('div');
  keyNode.className = 'key';
  keyNode.textContent = key;

  const valueNode = document.createElement('div');
  valueNode.className = 'value';
  valueNode.textContent = value == null ? 'unknown' : String(value);

  parent.append(keyNode, valueNode);
}

function createBadge(text: string) {
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = text;
  return badge;
}

function renderError(err: unknown) {
  if (!rootElement) return;
  rootElement.innerHTML = '';
  const error = document.createElement('div');
  error.className = 'content error';
  error.textContent = err instanceof Error ? err.message : String(err);
  rootElement.append(error);
}
