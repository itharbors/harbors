import type { ContributeData } from '../plugin/types';
import type { I18nChangeEvent } from '../i18n/types';
import type { MenuContributionNode, MenuPlatform, MenuTreeNode, NormalizedMenuResult } from './types';
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
  private applicationState: NormalizedMenuResult = { tree: [], warnings: [] };
  private kitState: NormalizedMenuResult = { tree: [], warnings: [] };
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

  getApplicationState(): NormalizedMenuResult {
    return this.applicationState;
  }

  getKitState(): NormalizedMenuResult {
    return this.kitState;
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
    this.applicationState = { tree: [], warnings: [] };
    this.kitState = { tree: [], warnings: [] };
  }

  private rebuild(): void {
    const externalSources = Array.from(this.externals.values());
    const defaultSources = this.defaults ? [this.defaults] : [];
    const built = buildMenuTreeWithActions(
      externalSources,
      defaultSources,
      this.translate,
      this.platform,
    );
    const applicationBuilt = buildMenuTreeWithActions(
      [],
      defaultSources,
      this.translate,
      this.platform,
    );
    const applicationOwner = this.defaults?.pluginName;
    const kitActionIds = new Set(built.actions
      .filter((action) => action.pluginName !== applicationOwner)
      .map((action) => action.id));
    this.state = built.result;
    this.applicationState = applicationBuilt.result;
    this.kitState = {
      tree: pruneMenuTree(built.result.tree, kitActionIds),
      warnings: built.result.warnings.filter((warning) => warning.pluginName !== applicationOwner),
    };
    this.actions = new Map(built.actions.map((action) => [action.id, action]));
  }

  private notifyChange(): void {
    this.onChange?.(this.getState());
  }
}

function pruneMenuTree(nodes: MenuTreeNode[], actionIds: ReadonlySet<string>): MenuTreeNode[] {
  const result: MenuTreeNode[] = [];
  for (const node of nodes) {
    if (node.type === 'separator') continue;
    const children = pruneMenuTreeWithSeparators(node.children, actionIds);
    if (!actionIds.has(node.id) && children.every((child) => child.type === 'separator')) continue;
    result.push({ ...node, children });
  }
  return result;
}

function pruneMenuTreeWithSeparators(nodes: MenuTreeNode[], actionIds: ReadonlySet<string>): MenuTreeNode[] {
  const retained = nodes.flatMap((node): MenuTreeNode[] => {
    if (node.type === 'separator') return [node];
    const children = pruneMenuTreeWithSeparators(node.children, actionIds);
    return actionIds.has(node.id) || children.some((child) => child.type === 'menu')
      ? [{ ...node, children }]
      : [];
  });
  return retained.filter((node, index) => (
    node.type === 'menu'
    || (index > 0
      && index < retained.length - 1
      && retained[index - 1]?.type === 'menu'
      && retained[index + 1]?.type === 'menu')
  ));
}
