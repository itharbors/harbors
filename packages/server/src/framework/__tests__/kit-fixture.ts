import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TestKitPlugin {
  name: string;
  directory?: string;
  contribute?: Record<string, unknown>;
  code?: string;
}

export interface TestKitFixtureOptions {
  name?: string;
  label?: string;
  plugins?: TestKitPlugin[];
  mainPanel?: string | null;
}

export interface TestKitFixture {
  directory: string;
  name: string;
  primaryPlugin: string;
  primaryPanel: string;
  observerPlugin: string;
  dispose(): Promise<void>;
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function createDistPlugin(pluginsDirectory: string, plugin: TestKitPlugin): string {
  const directoryName = plugin.directory ?? plugin.name.replace(/^@[^/]+\//u, '');
  const pluginDirectory = path.join(pluginsDirectory, directoryName);
  fs.mkdirSync(path.join(pluginDirectory, 'main', 'dist'), { recursive: true });
  writeJson(path.join(pluginDirectory, 'package.json'), {
    name: plugin.name,
    version: '1.0.0',
    type: 'module',
    main: './main/dist/index.js',
    'ce-editor': { contribute: plugin.contribute ?? {} },
  });
  fs.writeFileSync(
    path.join(pluginDirectory, 'main', 'dist', 'index.js'),
    plugin.code ?? 'editor.plugin.define({ methods: {} });\n',
  );

  const panels = plugin.contribute?.panel;
  if (panels && typeof panels === 'object') {
    for (const definition of Object.values(panels)) {
      const entry = definition && typeof definition === 'object'
        ? (definition as { entry?: unknown }).entry
        : undefined;
      if (typeof entry !== 'string') continue;
      const entryPath = path.resolve(pluginDirectory, entry);
      fs.mkdirSync(path.dirname(entryPath), { recursive: true });
      fs.writeFileSync(entryPath, '<!doctype html><html><body><fixture-panel></fixture-panel></body></html>\n');
    }
  }
  return pluginDirectory;
}

export function createKitFixture(options: TestKitFixtureOptions = {}): TestKitFixture {
  const name = options.name ?? '@example/kit-alpha';
  const label = options.label ?? 'Alpha Fixture';
  const primaryPlugin = '@example/alpha-panel';
  const primaryPanel = `${primaryPlugin}.viewer`;
  const observerPlugin = '@example/message-observer';
  const defaultPlugins: TestKitPlugin[] = [
    {
      name: primaryPlugin,
      contribute: {
        panel: { viewer: { entry: './panel.viewer/dist/index.html' } },
        menu: [
          { type: 'menu', id: 'Fixture', label: 'Fixture' },
          { type: 'menu', id: 'Fixture/open', label: 'Open fixture', message: 'openFixture' },
        ],
        message: { request: { openFixture: ['openFixture'] } },
      },
      code: `
        let runtime;
        editor.plugin.define({
          lifecycle: { load(value) { runtime = value; } },
          methods: { openFixture() { return runtime.window.openPanel('${primaryPanel}'); } },
        });
      `,
    },
    {
      name: observerPlugin,
      contribute: {
        message: {
          request: { '*': ['onAnyRequest'], getSnapshot: ['getSnapshot'] },
          broadcast: { '*': ['onAnyBroadcast'] },
        },
      },
      code: `
        const messages = [];
        editor.plugin.define({
          methods: {
            getSnapshot() { return { messages: [...messages] }; },
            onAnyRequest(meta, ...args) {
              if (meta?.plugin === '${observerPlugin}' && meta?.name === 'getSnapshot') return;
              messages.push({ type: 'Request ' + meta.plugin + '.' + meta.name, payload: args.length === 0 ? [] : args.length === 1 ? args[0] : args });
            },
            onAnyBroadcast(meta, ...args) {
              messages.push({ type: 'Broadcast ' + meta.topic, payload: args.length === 0 ? [] : args.length === 1 ? args[0] : args });
            },
          },
        });
      `,
    },
  ];
  const plugins = options.plugins ?? defaultPlugins;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-framework-kit-'));
  const pluginsDirectory = path.join(directory, 'plugins');
  fs.mkdirSync(pluginsDirectory, { recursive: true });
  for (const plugin of plugins) createDistPlugin(pluginsDirectory, plugin);

  const selectedPrimaryPlugin = plugins[0]?.name ?? primaryPlugin;
  const selectedMainPanel = options.mainPanel === undefined
    ? (options.plugins === undefined ? `${selectedPrimaryPlugin}.viewer` : undefined)
    : options.mainPanel ?? undefined;
  writeJson(path.join(directory, 'layout.json'), {
    windows: selectedMainPanel ? [{
      id: 'fixture-main', type: 'panel-area', layout: { type: 'leaf', panel: selectedMainPanel },
    }] : [],
    activePanel: selectedMainPanel,
  });
  fs.writeFileSync(path.join(directory, 'main.html'), '<editor-app></editor-app>\n');
  fs.writeFileSync(
    path.join(directory, 'secondary.html'),
    '<!doctype html><html><head></head><body><window-group-app></window-group-app><script type="module" src="/src/index.ts"></script></body></html>\n',
  );
  writeJson(path.join(directory, 'package.json'), {
    name,
    version: '1.0.0',
    private: true,
    'ce-editor': {
      kit: {
        menuRoot: { id: name.split('/').at(-1), label },
        layouts: { default: 'layout.json' },
        windowEntries: { main: 'main.html', secondary: 'secondary.html' },
        plugin: plugins.map((plugin) => plugin.name),
      },
    },
    harbors: {
      distribution: 'builtin',
      ci: { runner: 'ubuntu-latest' },
      docs: { summary: 'Framework-owned generic Kit fixture' },
      resources: [],
      storage: { legacyDataDirectories: [] },
      scripts: { build: 'build', test: 'test' },
    },
  });
  return {
    directory,
    name,
    primaryPlugin: selectedPrimaryPlugin,
    primaryPanel: selectedMainPanel ?? `${selectedPrimaryPlugin}.viewer`,
    observerPlugin,
    dispose: async () => {
      await fs.promises.rm(directory, { recursive: true, force: true });
    },
  };
}
