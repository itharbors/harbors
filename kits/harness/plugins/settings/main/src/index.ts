import {
  SettingsSchemaError,
  sortSettingsPages,
  validateSettingsContribution,
  type SettingsPage,
  type SettingsPageContribution,
} from './schema.js';

declare const editor: any;

type RegisteredPage = Omit<SettingsPage, 'entry' | 'title'> & { localPanel: string };
let runtime: any = null;
const pages = new Map<string, RegisteredPage>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function broadcast(topic: string, ...args: unknown[]): void {
  try {
    runtime?.message?.broadcast(topic, ...args);
  } catch (error) {
    console.error(`[settings] broadcast ${topic} failed`, error);
  }
}

function assertRuntime(): any {
  if (!runtime) throw new Error('settings plugin not loaded');
  return runtime;
}

function assertContributionPanel(pluginName: string, contribute: Record<string, unknown>, localPanel: string): string {
  if (!isRecord(contribute.panel) || !Object.prototype.hasOwnProperty.call(contribute.panel, localPanel)) {
    throw new SettingsSchemaError(`settings.panel ${pluginName}.${localPanel} is not contributed by the plugin`);
  }
  return `${pluginName}.${localPanel}`;
}

function registerPage(pluginName: string, contribute: unknown): void {
  if (!runtime || !isRecord(contribute) || !Object.prototype.hasOwnProperty.call(contribute, 'settings')) return;
  try {
    if (!isRecord(contribute)) throw new SettingsSchemaError('contribution must be an object');
    const contribution = validateSettingsContribution(pluginName, contribute);
    const panel = assertContributionPanel(pluginName, contribute, contribution.panel);
    const action = pages.has(pluginName) ? 'replace' : 'attach';
    pages.set(pluginName, {
      owner: pluginName,
      panel,
      localPanel: contribution.panel,
      order: contribution.order ?? 0,
    });
    broadcast('settings.registry.changed', { action, owner: pluginName });
  } catch (error) {
    console.error(`[settings] ignored invalid contribution from ${pluginName}`, error);
  }
}

function unregisterPage(pluginName: string): void {
  if (!pages.delete(pluginName)) return;
  broadcast('settings.registry.changed', { action: 'detach', owner: pluginName });
}

const definition = {
  lifecycle: {
    load(context: any) {
      runtime = context;
    },
    unload() {
      pages.clear();
      runtime = null;
    },
    attach(pluginName: string, contribute: unknown) {
      registerPage(pluginName, contribute);
    },
    detach(pluginName: string) {
      unregisterPage(pluginName);
    },
  },
  methods: {
    getPages() {
      assertRuntime();
      const availablePages = [...pages.values()].flatMap(({ owner, panel, order }) => {
        try {
          const info = runtime.panel.getInfo(panel);
          const entry = info?.entry;
          const title = info?.title;
          if (typeof entry !== 'string' || entry.length === 0 || typeof title !== 'string' || title.trim() === '') return [];
          return [{ owner, panel, title, order, entry }];
        } catch {
          return [];
        }
      });
      return sortSettingsPages(availablePages);
    },

    openSettingsPanel() {
      const currentRuntime = assertRuntime();
      return currentRuntime.window.openPanel('settings.settings');
    },
  },
};

if (typeof editor !== 'undefined' && editor?.plugin?.define) editor.plugin.define(definition);

export { definition };
export type { SettingsPageContribution };
