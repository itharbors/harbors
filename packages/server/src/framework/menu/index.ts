import type { ContributeData } from '../plugin/types';
import type { I18nChangeEvent } from '../i18n/types';
import type { MenuContributionNode, MenuPlatform, NormalizedMenuResult } from './types';
import { buildMenuTreeWithActions, normalizeMenuPlatform, type InternalMenuAction } from './normalize';

interface MenuContributionEntry {
  pluginName: string;
  loadOrder: number;
  items: MenuContributionNode[];
}

interface MenuModuleOptions {
  t?: (key: string) => string;
  subscribe?: (listener: (event: I18nChangeEvent) => void) => () => void;
  platform?: MenuPlatform;
  onChange?: (state: NormalizedMenuResult) => void;
}

export class MenuModule {
  private loadOrder = 0;
  private defaults: MenuContributionEntry | null = null;
  private externals = new Map<string, MenuContributionEntry>();
  private actions = new Map<string, InternalMenuAction>();
  private state: NormalizedMenuResult = {
    tree: [],
    warnings: [],
  };
  private readonly translate: (key: string) => string;
  private readonly disposeI18n: (() => void) | undefined;
  private readonly platform: MenuPlatform;
  private readonly onChange: ((state: NormalizedMenuResult) => void) | undefined;

  constructor(options: MenuModuleOptions = {}) {
    this.translate = options.t ?? ((key) => key);
    this.platform = options.platform ?? normalizeMenuPlatform(process.platform);
    this.onChange = options.onChange;
    this.disposeI18n = options.subscribe?.(() => {
      this.rebuild();
      this.notifyChange();
    });
    this.rebuild();
  }

  setDefaults(pluginName: string, items: MenuContributionNode[]): void {
    this.defaults = {
      pluginName,
      loadOrder: 0,
      items: JSON.parse(JSON.stringify(items)) as MenuContributionNode[],
    };
    this.rebuild();
    this.notifyChange();
  }

  clearDefaults(pluginName?: string): void {
    if (!this.defaults) return;
    if (pluginName && this.defaults.pluginName !== pluginName) return;
    this.defaults = null;
    this.rebuild();
    this.notifyChange();
  }

  attach(pluginName: string, contribute: ContributeData): void {
    const items = contribute.menu;
    if (!items) return;
    const snapshot = Array.isArray(items)
      ? JSON.parse(JSON.stringify(items)) as MenuContributionNode[]
      : [];


    const entry: MenuContributionEntry = {
      pluginName,
      loadOrder: this.loadOrder += 1,
      items: snapshot,
    };

    this.externals.set(pluginName, entry);
    this.rebuild();
    this.notifyChange();
  }

  detach(pluginName: string): void {
    const removedExternal = this.externals.delete(pluginName);
    if (removedExternal) {
      this.rebuild();
      this.notifyChange();
    }
  }

  reset(): void {
    this.externals.clear();
    this.rebuild();
    this.notifyChange();
  }

  getState(): NormalizedMenuResult {
    return this.state;
  }

  trigger(
    menuId: string,
    runtime: {
      request: (pluginName: string, message: string) => Promise<unknown>;
      triggerRole: (role: string) => Promise<unknown>;
    },
  ): Promise<unknown> {
    const action = this.actions.get(menuId);
    if (!action) throw new Error(`Menu item "${menuId}" not found`);
    if (action.message) return runtime.request(action.pluginName, action.message);
    if (action.role) return runtime.triggerRole(action.role);
    return Promise.resolve(undefined);
  }

  destroy(): void {
    this.disposeI18n?.();
    this.defaults = null;
    this.externals.clear();
    this.actions.clear();
    this.state = { tree: [], warnings: [] };
  }

  private rebuild(): void {
    const built = buildMenuTreeWithActions(
      Array.from(this.externals.values()),
      this.defaults ? [this.defaults] : [],
      this.translate,
      this.platform,
    );
    this.state = built.result;
    this.actions = new Map(built.actions.map((action) => [action.id, action]));
  }

  private notifyChange(): void {
    this.onChange?.(this.getState());
  }
}
