import type {
  MenuContributionNode,
  MenuPlatform,
  MenuTreeMenuNode,
  MenuTreeNode,
  MenuWarning,
  NormalizedMenuResult,
} from './types';

export interface MenuContributionSource {
  pluginName: string;
  loadOrder: number;
  items: MenuContributionNode[];
}

export const normalizeMenuPlatform = (platform?: string): MenuPlatform => {
  if (platform === 'darwin' || platform === 'win32') {
    return platform;
  }

  return 'linux';
};

interface CandidateEntry {
  node: MenuContributionNode;
  pluginName: string;
  loadOrder: number;
  entryIndex: number;
}

interface SortMeta {
  order?: number;
  loadOrder: number;
  entryIndex: number;
  id: string;
}

interface InternalMenuNode extends MenuTreeMenuNode {
  sortMeta: SortMeta;
  pluginName?: string;
  message?: string;
}

interface InternalSeparatorNode extends Extract<MenuTreeNode, { type: 'separator' }> {
  sortMeta: SortMeta;
}

type InternalChildNode = InternalMenuNode | InternalSeparatorNode;

export interface InternalMenuAction {
  id: string;
  pluginName: string;
  message?: string;
  role?: string;
}

export interface InternalMenuBuildResult {
  result: NormalizedMenuResult;
  actions: InternalMenuAction[];
}

const compareBySortMeta = (a: SortMeta, b: SortMeta): number => {
  const orderA = a.order ?? 0;
  const orderB = b.order ?? 0;

  if (orderA !== orderB) {
    return orderA - orderB;
  }

  if (a.loadOrder !== b.loadOrder) {
    return a.loadOrder - b.loadOrder;
  }

  if (a.entryIndex !== b.entryIndex) {
    return a.entryIndex - b.entryIndex;
  }

  return a.id.localeCompare(b.id);
};

const isInvalidId = (id: string): boolean => {
  if (id.length === 0) {
    return true;
  }

  if (id.startsWith('/') || id.endsWith('/')) {
    return true;
  }

  return id.split('/').some((segment) => segment.length === 0);
};

const sortTree = (nodes: InternalMenuNode[]): MenuTreeNode[] => {
  return [...nodes]
    .sort((a, b) => compareBySortMeta(a.sortMeta, b.sortMeta))
    .map((node) => ({
      type: 'menu',
      id: node.id,
      label: node.label,
      ...(node.labelKey === undefined ? {} : { labelKey: node.labelKey }),
      ...(node.role === undefined ? {} : { role: node.role }),
      ...(node.accelerator === undefined ? {} : { accelerator: node.accelerator }),
      children: (node.children as InternalChildNode[])
        .slice()
        .sort((left, right) => compareBySortMeta(left.sortMeta, right.sortMeta))
        .map((child) => {
          if (child.type === 'separator') {
            return {
              type: 'separator',
              id: child.id,
            };
          }

          return sortTree([child])[0] as MenuTreeNode;
        }),
    }));
};

const filterSourcesByPlatform = (
  sources: MenuContributionSource[],
  platform: MenuPlatform,
): MenuContributionSource[] => {
  return sources
    .map((source) => ({
      ...source,
      items: source.items.filter((item) => item.platforms === undefined || item.platforms.includes(platform)),
    }))
    .filter((source) => source.items.length > 0);
};

export function buildMenuTree(
  externalSources: MenuContributionSource[],
  defaultSources: MenuContributionSource[] = [],
  translate: (key: string) => string = (key) => key,
  platform?: string,
): NormalizedMenuResult {
  return buildMenuTreeWithActions(externalSources, defaultSources, translate, platform).result;
}

export function buildMenuTreeWithActions(
  externalSources: MenuContributionSource[],
  defaultSources: MenuContributionSource[] = [],
  translate: (key: string) => string = (key) => key,
  platform?: string,
): InternalMenuBuildResult {
  const currentPlatform = normalizeMenuPlatform(platform ?? process.platform);
  const filteredExternalSources = filterSourcesByPlatform(externalSources, currentPlatform);
  const filteredDefaultSources = filterSourcesByPlatform(defaultSources, currentPlatform);
  const activeSources = [...filteredDefaultSources, ...filteredExternalSources];
  const warnings: MenuWarning[] = [];
  const acceptedMenus = new Map<string, InternalMenuNode>();
  const rootNodes: InternalMenuNode[] = [];

  for (const source of activeSources) {
    source.items.forEach((node, entryIndex) => {
      if (isInvalidId(node.id)) {
        warnings.push({ code: 'invalid-id', id: node.id, pluginName: source.pluginName });
        return;
      }

      const parentId = node.id.includes('/') ? node.id.slice(0, node.id.lastIndexOf('/')) : undefined;

      if (node.type === 'separator') {
        if (parentId === undefined) {
          warnings.push({ code: 'root-separator', id: node.id, pluginName: source.pluginName });
          return;
        }

        const parent = acceptedMenus.get(parentId);
        if (!parent) {
          warnings.push({ code: 'missing-parent', id: node.id, pluginName: source.pluginName });
          return;
        }

        (parent.children as InternalChildNode[]).push({
          type: 'separator',
          id: node.id,
          ...(node.order === undefined ? {} : { order: node.order }),
          sortMeta: {
            order: node.order,
            loadOrder: source.loadOrder,
            entryIndex,
            id: node.id,
          },
        });
        return;
      }

      const existing = acceptedMenus.get(node.id);
      if (existing) {
        if (node.message) {
          warnings.push({ code: 'duplicate-action-menu', id: node.id, pluginName: source.pluginName });
        } else {
          warnings.push({ code: 'duplicate-structural-menu', id: node.id, pluginName: source.pluginName });
        }
        return;
      }

      if (parentId !== undefined) {
        const parent = acceptedMenus.get(parentId);
        if (!parent) {
          warnings.push({ code: 'missing-parent', id: node.id, pluginName: source.pluginName });
          return;
        }

        if (parent.message !== undefined) {
          parent.message = undefined;
          parent.pluginName = undefined;
          warnings.push({ code: 'menu-node-became-container', id: parent.id, pluginName: source.pluginName });
        }
      }

      const internalNode: InternalMenuNode = {
        type: 'menu',
        id: node.id,
        label: node.labelKey ? translate(node.labelKey) : (node.label ?? node.id.split('/').pop() ?? node.id),
        ...(node.labelKey === undefined ? {} : { labelKey: node.labelKey }),
        ...(node.message === undefined ? {} : { message: node.message }),
        ...(node.message === undefined && node.role === undefined ? {} : { pluginName: source.pluginName }),
        ...(node.role === undefined ? {} : { role: node.role }),
        ...(node.accelerator === undefined ? {} : { accelerator: node.accelerator }),
        children: [],
        sortMeta: {
          order: node.order,
          loadOrder: source.loadOrder,
          entryIndex,
          id: node.id,
        },
      };

      acceptedMenus.set(node.id, internalNode);

      if (parentId === undefined) {
        rootNodes.push(internalNode);
      } else {
        acceptedMenus.get(parentId)?.children.push(internalNode);
      }
    });
  }

  return {
    result: {
      tree: sortTree(rootNodes),
      warnings,
    },
    actions: Array.from(acceptedMenus.values())
      .filter((node) => node.message !== undefined || node.role !== undefined)
      .map((node) => ({
        id: node.id,
        pluginName: node.pluginName ?? '',
        ...(node.message === undefined ? {} : { message: node.message }),
        ...(node.role === undefined ? {} : { role: node.role }),
      })),
  };
}
