type PanelContext = {
  message: {
    request(plugin: string, method: string, input?: unknown): Promise<unknown>;
  };
};

let root: HTMLElement | null = null;

const definition = {
  mount(_context: PanelContext) {
    root = document.querySelector('#panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    const heading = document.createElement('h1');
    heading.textContent = 'Skill Manager';
    root.replaceChildren(heading);
  },
  unmount() {
    root?.replaceChildren();
    root = null;
  },
  methods: {
    onSnapshotChanged() {},
    onScanProgress() {},
    onOperationProgress() {},
  },
};

export default definition;
