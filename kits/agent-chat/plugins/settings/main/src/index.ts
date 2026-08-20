import {
  SettingsSchemaError,
  sortSettingsPages,
  validateSettingsContribution,
  type SettingsPage,
  type SettingsPageContribution,
} from './schema.js';

declare const editor: any;

type RegisteredPage = Omit<SettingsPage, 'entry'> & { localPanel: string; requests: string[] };
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
      title: contribution.title,
      order: contribution.order ?? 0,
      requests: [...contribution.requests],
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

function assertRequestPage(input: unknown): { owner: string; name: string; args: unknown[] } {
  if (!isRecord(input)) throw new Error('settings page request must be an object');
  if (typeof input.owner !== 'string' || input.owner.trim() === '') throw new Error('settings page request owner is required');
  if (typeof input.name !== 'string' || input.name.trim() === '') throw new Error('settings page request name is required');
  if (!Array.isArray(input.args)) throw new Error('settings page request args must be an array');
  return { owner: input.owner, name: input.name, args: input.args };
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
      return sortSettingsPages(pages.values()).flatMap(({ owner, panel, title, order }) => {
        try {
          const entry = runtime.panel.getInfo(panel)?.entry;
          if (typeof entry !== 'string' || entry.length === 0) return [];
          return [{ owner, panel, title, order, entry }];
        } catch {
          return [];
        }
      });
    },

    requestPage(input: unknown) {
      const currentRuntime = assertRuntime();
      const request = assertRequestPage(input);
      const page = pages.get(request.owner);
      if (!page) throw new Error(`settings page owner is not registered: ${request.owner}`);
      if (!page.requests.includes(request.name)) {
        throw new Error(`settings page request is not allowed: ${request.owner}.${request.name}`);
      }
      return currentRuntime.message.request(request.owner, request.name, ...request.args);
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
