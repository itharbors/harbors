type PanelContext = {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
};

type PanelDefinition = {
  mount?(ctx: PanelContext): void | Promise<void>;
  unmount?(): void | Promise<void>;
  methods?: Record<string, (...args: unknown[]) => unknown>;
};

type StatusPayload = {
  uptime: number;
  panels: unknown[];
  pluginsLoaded: number;
  pluginsRegistered: number;
};

let context: PanelContext;
let rootElement: HTMLElement | null;
let timer: ReturnType<typeof setInterval> | undefined;
let latestStatus: StatusPayload | undefined;
let latestStatusAt = 0;

const definition: PanelDefinition = {
  async mount(ctx) {
    context = ctx;
    rootElement = document.getElementById('panel-root');
    if (!rootElement) throw new Error('Panel root element #panel-root not found');

    rootElement.innerHTML = '';
    await refreshStatus();
    timer = setInterval(renderCachedStatus, 60 * 1000);
  },
  unmount() {
    if (timer) clearInterval(timer);
    timer = undefined;
  },
  methods: {
    async refresh() {
      await refreshStatus();
      return true;
    },
  },
};

export default definition;

async function refreshStatus() {
  if (!context || !rootElement) return;

  try {
    const status = await context.message.request('@ce/status-bar', 'getStatus') as StatusPayload;
    latestStatus = status;
    latestStatusAt = Date.now();
    renderStatus(status);
  } catch (err) {
    rootElement.innerHTML = '';
    const error = document.createElement('span');
    error.className = 'error';
    error.textContent = err instanceof Error ? err.message : String(err);
    rootElement.append(error);
  }
}

function renderCachedStatus() {
  if (!latestStatus || !latestStatusAt) return;

  renderStatus({
    ...latestStatus,
    uptime: latestStatus.uptime + (Date.now() - latestStatusAt),
  });
}

function renderStatus(status: StatusPayload) {
  if (!rootElement) return;
  rootElement.innerHTML = '';
  rootElement.append(
    createMetric('plugins', `${status.pluginsLoaded}/${status.pluginsRegistered}`),
    createMetric('panels', String(status.panels.length)),
    createSpacer(),
    createMetric('uptime', formatDuration(status.uptime)),
  );
}

function createMetric(label: string, value: string) {
  const item = document.createElement('span');
  item.className = 'item';

  const labelNode = document.createElement('span');
  labelNode.textContent = label;

  const valueNode = document.createElement('span');
  valueNode.className = 'value';
  valueNode.textContent = value;

  item.append(labelNode, valueNode);
  return item;
}

function createSpacer() {
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  return spacer;
}

function formatDuration(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m`;
}
