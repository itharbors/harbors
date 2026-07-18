type PanelContext = {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
  panelKey?: string;
};

type PanelDefinition = {
  mount?(ctx: PanelContext): void | Promise<void>;
  unmount?(): void | Promise<void>;
  methods?: Record<string, (...args: unknown[]) => unknown>;
};

let context: PanelContext;
let rootElement: HTMLElement | null;
let list: HTMLDivElement | null;

const definition: PanelDefinition = {
  async mount(ctx) {
    context = ctx;
    rootElement = document.getElementById('panel-root');
    if (!rootElement) {
      throw new Error('Panel root element #panel-root not found');
    }

    rootElement.innerHTML = '';
    rootElement.append(createToolbar(), createList());

    const logs = await ctx.message.request('@ce/log', 'getLogs');
    renderLogs(Array.isArray(logs) ? logs : []);
  },
  methods: {
    onLogsChanged(logs: unknown) {
      renderLogs(Array.isArray(logs) ? logs : []);
      return logs;
    },
  },
};

export default definition;

function createToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';

  const title = document.createElement('strong');
  title.textContent = 'Runtime Logs';

  const add = document.createElement('button');
  add.textContent = 'Add sample';
  add.addEventListener('click', () => {
    void context.message.request('@ce/log', 'appendLog', {
      level: 'info',
      message: 'Sample log from panel',
      meta: { source: context.panelKey },
    });
  });

  const clear = document.createElement('button');
  clear.textContent = 'Clear';
  clear.addEventListener('click', () => {
    void context.message.request('@ce/log', 'clearLogs');
  });

  toolbar.append(title, add, clear);
  return toolbar;
}

function createList() {
  list = document.createElement('div');
  list.className = 'logs';
  return list;
}

function renderLogs(logs: Array<Record<string, unknown>>) {
  if (!list) return;
  list.innerHTML = '';

  if (logs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No logs yet.';
    list.append(empty);
    return;
  }

  for (const log of logs.slice().reverse()) {
    const row = document.createElement('div');
    row.className = `log log-${String(log.level ?? 'info')}`;

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date(String(log.timestamp ?? '')).toLocaleTimeString();

    const level = document.createElement('span');
    level.className = 'level';
    level.textContent = String(log.level ?? 'info').toUpperCase();

    const message = document.createElement('span');
    message.className = 'message';
    message.textContent = String(log.message ?? '');

    row.append(time, level, message);
    list.append(row);
  }
}
