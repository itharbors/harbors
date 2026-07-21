type PanelContext = {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
};

type PanelDefinition = {
  mount?(ctx: PanelContext): void | Promise<void>;
  methods?: Record<string, (...args: unknown[]) => unknown>;
};

type PluginSummary = {
  count?: number;
  activeKitName?: string | null;
  selectedPluginName?: string;
  groups?: Record<string, number>;
  plugins?: PluginItem[];
};

type PluginItem = {
  name: string;
  source?: string;
  panelCount?: number;
  requestCount?: number;
  broadcastCount?: number;
};

let context: PanelContext;
let list: HTMLDivElement | null;
let selectedPluginName: string | undefined;

const definition: PanelDefinition = {
  async mount(ctx) {
    context = ctx;
    const rootElement = document.getElementById('panel-root');
    if (!rootElement) throw new Error('Panel root element #panel-root not found');

    rootElement.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'header';
    list = document.createElement('div');
    list.className = 'list';
    rootElement.append(header, list);

    try {
      const summary = await ctx.message.request('@itharbors/plugin-list', 'getPluginSummary') as PluginSummary;
      selectedPluginName = summary.selectedPluginName;
      renderHeader(header, summary);
      renderPlugins(summary.plugins);
    } catch (err) {
      header.innerHTML = '<div class="title">Loaded Plugins</div>';
      list.innerHTML = '';
      const error = document.createElement('div');
      error.className = 'error';
      error.textContent = err instanceof Error ? err.message : String(err);
      list.append(error);
    }
  },
  methods: {
    onPluginSelected(detail: unknown) {
      selectedPluginName = (detail as { name?: string } | null)?.name;
      syncActivePlugin();
      return detail;
    },
  },
};

export default definition;

function renderHeader(header: HTMLElement, summary: PluginSummary) {
  header.innerHTML = '';

  const titleRow = document.createElement('div');
  titleRow.className = 'title-row';

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = String(summary.count ?? 0);

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = 'Loaded Plugins';

  const subtitle = document.createElement('div');
  subtitle.className = 'subtitle';
  subtitle.textContent = summary.activeKitName
    ? `kit: ${summary.activeKitName}`
    : 'kit: unknown';

  const summaryRow = document.createElement('div');
  summaryRow.className = 'summary-row';
  summaryRow.append(
    createBadge(`${summary.groups?.builtin ?? 0} built-in`),
    createBadge(`${summary.groups?.kit ?? 0} kit`),
    createBadge(`${summary.groups?.external ?? 0} external`),
  );

  titleRow.append(count, title);
  header.append(titleRow, subtitle, summaryRow);
}

function renderPlugins(plugins: PluginItem[] = []) {
  if (!list) return;
  list.innerHTML = '';

  if (plugins.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No plugins loaded.';
    list.append(empty);
    return;
  }

  const groups = groupPlugins(plugins);
  const orderedSources = ['builtin', 'kit', 'external'];

  for (const source of orderedSources) {
    const group = groups[source] ?? [];
    if (group.length === 0) continue;

    const section = document.createElement('section');
    section.className = 'section';

    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = `${getSourceLabel(source)} · ${group.length}`;
    section.append(title);

    for (const plugin of group) {
      const item = document.createElement('div');
      item.className = 'plugin';
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.dataset.pluginName = plugin.name;
      if (plugin.name === selectedPluginName) {
        item.classList.add('active');
      }

      const name = document.createElement('div');
      name.className = 'plugin-name';
      name.title = plugin.name;
      name.textContent = formatPluginName(plugin.name);

      const meta = document.createElement('div');
      meta.className = 'plugin-meta';
      meta.append(
        createSourceBadge(plugin.source),
        createBadge(`${plugin.panelCount ?? 0} panels`),
        createBadge(`${plugin.requestCount ?? 0} requests`),
        createBadge(`${plugin.broadcastCount ?? 0} broadcasts`),
      );

      item.append(name, meta);
      item.addEventListener('click', () => selectPlugin(plugin.name));
      item.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        void selectPlugin(plugin.name);
      });
      section.append(item);
    }

    list.append(section);
  }
}

function createBadge(text: string) {
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = text;
  return badge;
}

function createSourceBadge(source = 'external') {
  const badge = createBadge(getSourceLabel(source));
  badge.classList.add(`badge-source-${source}`);
  return badge;
}

function groupPlugins(plugins: PluginItem[]) {
  return plugins.reduce<Record<string, PluginItem[]>>((groups, plugin) => {
    const source = plugin.source ?? 'external';
    if (!groups[source]) groups[source] = [];
    groups[source].push(plugin);
    return groups;
  }, {});
}

function getSourceLabel(source?: string) {
  if (source === 'builtin') return 'Built-in';
  if (source === 'kit') return 'Kit';
  return 'External';
}

function formatPluginName(name: string) {
  if (typeof name !== 'string' || name.length === 0) return 'unknown';

  const [scope, packageName] = name.split('/');
  const shortScope = scope === '@itharbors' ? '@ce' : scope;
  const shortPackageName = packageName?.replace(/^plugin-/, '') ?? '';

  if (!packageName) return shortScope;
  return `${shortScope}/${shortPackageName}`;
}

async function selectPlugin(name: string) {
  if (!context || !name) return;

  selectedPluginName = name;
  syncActivePlugin();

  try {
    const detail = await context.message.request('@itharbors/plugin-list', 'selectPlugin', name) as { name?: string } | null;
    selectedPluginName = detail?.name ?? name;
    syncActivePlugin();
  } catch {
    // Keep the optimistic highlight; the detail panel will show the last valid selection.
  }
}

function syncActivePlugin() {
  if (!list) return;

  for (const item of Array.from(list.querySelectorAll<HTMLElement>('.plugin'))) {
    item.classList.toggle('active', item.dataset.pluginName === selectedPluginName);
  }
}
