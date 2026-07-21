type PanelContext = {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
};

type PanelDefinition = {
  mount?(ctx: PanelContext): void | Promise<void>;
  methods?: Record<string, (...args: unknown[]) => unknown>;
};

type TitlePayload = {
  product?: string;
  kit?: string | null;
  kitVersion?: string | null;
};

let context: PanelContext;
let rootElement: HTMLElement | null;

const definition: PanelDefinition = {
  async mount(ctx) {
    context = ctx;
    rootElement = document.getElementById('panel-root');
    if (!rootElement) throw new Error('Panel root element #panel-root not found');

    rootElement.innerHTML = '';
    await refreshTitle();
  },
  methods: {
    async refresh() {
      await refreshTitle();
      return true;
    },
  },
};

export default definition;

async function refreshTitle() {
  if (!context || !rootElement) return;

  try {
    const title = await context.message.request('@itharbors/title-bar', 'getTitle') as TitlePayload;
    renderTitle(title);
  } catch (err) {
    rootElement.innerHTML = '';
    const error = document.createElement('span');
    error.className = 'error';
    error.textContent = err instanceof Error ? err.message : String(err);
    rootElement.append(error);
  }
}

function renderTitle(title: TitlePayload) {
  if (!rootElement) return;
  rootElement.innerHTML = '';
  rootElement.append(
    createText(title.product ?? 'ITHARBORS', 'product'),
  );
  if (title.kit) {
    rootElement.append(createDivider(), createKit(title.kit, title.kitVersion));
  }
  rootElement.append(createSpacer());
}

function createText(text: string, className: string) {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

function createDivider() {
  const node = document.createElement('span');
  node.className = 'divider';
  return node;
}

function createKit(name: string, version?: string | null) {
  const wrap = document.createElement('span');
  wrap.className = 'kit';

  const label = document.createElement('span');
  label.textContent = 'kit';

  const value = document.createElement('span');
  value.className = 'name';
  value.textContent = name;

  wrap.append(label, value);

  if (version) {
    const ver = document.createElement('span');
    ver.className = 'version';
    ver.textContent = `v${version}`;
    wrap.append(ver);
  }

  return wrap;
}

function createSpacer() {
  const node = document.createElement('span');
  node.className = 'spacer';
  return node;
}
