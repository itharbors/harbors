import { randomUUID } from 'node:crypto';
import type {
  LegacyWindowDescriptorInput,
  OpenPanelRequest,
  OpenPanelResult,
  PanelInstanceDescriptor,
  WindowDescriptor,
  WindowSnapshot,
} from './types';

interface WindowManagerOptions {
  defaultWindows?: WindowDescriptor[];
  mainWindowId?: string;
  mainEntry?: string;
  secondaryEntry: string;
  mainLayout?: WindowDescriptor['layout'];
}

type StoredWindowDescriptor = WindowDescriptor & Pick<LegacyWindowDescriptorInput, 'title' | 'position' | 'defaultSize'>;

interface NormalizeWindowDescriptorOptions {
  defaultKind?: WindowDescriptor['kind'];
  defaultEntry?: string;
  defaultState?: WindowDescriptor['state'];
  createId?: () => string;
}

export class WindowManager {
  private readonly windows = new Map<string, StoredWindowDescriptor>();
  private readonly panelInstances = new Map<string, PanelInstanceDescriptor>();
  private readonly secondaryEntry: string;

  constructor(options?: WindowManagerOptions) {
    this.secondaryEntry = options?.secondaryEntry ?? '';

    if (!options) return;

    for (const windowGroup of options.defaultWindows ?? []) {
      this.windows.set(windowGroup.id, windowGroup);
    }

    if (options.defaultWindows || !options.mainWindowId || !options.mainEntry || !options.mainLayout) return;

    this.windows.set(options.mainWindowId, {
      id: options.mainWindowId,
      kind: 'main',
      type: 'panel-area',
      entry: options.mainEntry,
      state: 'open',
      layout: options.mainLayout,
      panelInstanceIds: [],
    });
  }

  create(descriptor: LegacyWindowDescriptorInput): string {
    const windowGroup = normalizeWindowDescriptorInput(descriptor, {
      defaultKind: 'secondary',
      defaultEntry: this.secondaryEntry,
      defaultState: 'open',
      createId: randomUUID,
    });
    this.windows.set(windowGroup.id, windowGroup);
    return windowGroup.id;
  }

  destroy(windowId: string): void {
    const windowGroup = this.windows.get(windowId);
    for (const panelInstanceId of windowGroup?.panelInstanceIds ?? []) {
      this.panelInstances.delete(panelInstanceId);
    }
    this.windows.delete(windowId);
  }

  closeWindowGroup(windowGroupId: string): void {
    const windowGroup = this.windows.get(windowGroupId);
    if (!windowGroup || windowGroup.kind !== 'secondary') return;

    this.destroy(windowGroupId);
  }

  list(): WindowDescriptor[] {
    return Array.from(this.windows.values(), toWindowDescriptor);
  }

  get(windowId: string): StoredWindowDescriptor | undefined {
    return this.windows.get(windowId);
  }

  focus(windowId: string): void {
    void windowId;
  }

  clear(): void {
    this.windows.clear();
    this.panelInstances.clear();
  }

  openPanel(request: OpenPanelRequest): OpenPanelResult {
    if (!request.multiInstance) {
      const existing = Array.from(this.panelInstances.values()).find((instance) => {
        return instance.panelName === request.panelName && instance.state !== 'closed';
      });

      if (existing) {
        return {
          disposition: 'reuse',
          panelInstanceId: existing.id,
          panelName: existing.panelName,
          windowGroupId: existing.windowGroupId,
          carrier: existing.carrier,
        };
      }
    }

    const panelInstanceId = randomUUID();
    const windowGroupId = randomUUID();

    this.panelInstances.set(panelInstanceId, {
      id: panelInstanceId,
      panelName: request.panelName,
      multiInstance: request.multiInstance,
      carrier: 'window-group',
      state: 'opening',
      windowGroupId,
    });
    this.windows.set(windowGroupId, {
      id: windowGroupId,
      kind: 'secondary',
      type: 'panel-area',
      entry: request.entry || this.secondaryEntry,
      state: 'opening',
      layout: request.layout,
      panelInstanceIds: [panelInstanceId],
    });

    return {
      disposition: 'open-window-group',
      panelInstanceId,
      panelName: request.panelName,
      windowGroupId,
      carrier: 'window-group',
    };
  }

  markFloating(panelInstanceId: string): PanelInstanceDescriptor {
    const instance = this.panelInstances.get(panelInstanceId);
    if (!instance) throw new Error(`Panel instance "${panelInstanceId}" not found`);

    if (instance.windowGroupId) {
      this.windows.delete(instance.windowGroupId);
    }

    const next: PanelInstanceDescriptor = {
      ...instance,
      carrier: 'floating',
      state: 'open',
      windowGroupId: null,
    };
    this.panelInstances.set(panelInstanceId, next);
    return next;
  }

  markWindowGroupOpened(windowGroupId: string): void {
    const windowGroup = this.windows.get(windowGroupId);
    if (!windowGroup) throw new Error(`Window group "${windowGroupId}" not found`);

    this.windows.set(windowGroupId, { ...windowGroup, state: 'open' });
    for (const panelInstanceId of windowGroup.panelInstanceIds) {
      const instance = this.panelInstances.get(panelInstanceId);
      if (instance) {
        this.panelInstances.set(panelInstanceId, { ...instance, state: 'open' });
      }
    }
  }

  closePanelInstance(panelInstanceId: string): void {
    const instance = this.panelInstances.get(panelInstanceId);
    if (!instance) return;

    this.panelInstances.delete(panelInstanceId);
    if (!instance.windowGroupId) return;

    const windowGroup = this.windows.get(instance.windowGroupId);
    if (!windowGroup) return;

    const nextIds = windowGroup.panelInstanceIds.filter((id) => id !== panelInstanceId);
    if (nextIds.length === 0 && windowGroup.kind === 'secondary') {
      this.windows.delete(windowGroup.id);
      return;
    }

    this.windows.set(windowGroup.id, { ...windowGroup, panelInstanceIds: nextIds });
  }

  setPanelInstanceState(panelInstanceId: string, state: 'open' | 'minimized'): PanelInstanceDescriptor {
    const instance = this.panelInstances.get(panelInstanceId);
    if (!instance) throw new Error(`Panel instance "${panelInstanceId}" not found`);

    const next = { ...instance, state };
    this.panelInstances.set(panelInstanceId, next);
    return next;
  }

  rearrange(windowId: string, targetLayout: WindowDescriptor['layout']): WindowDescriptor {
    const window = this.windows.get(windowId);
    if (!window) {
      throw new Error(`Window "${windowId}" not found`);
    }

    const next = { ...window, layout: targetLayout };
    this.windows.set(windowId, next);

    return toWindowDescriptor(next);
  }

  getSnapshot(): WindowSnapshot {
    return {
      windows: Array.from(this.windows.values(), toWindowDescriptor),
      panelInstances: Array.from(this.panelInstances.values()),
    };
  }

}

export function normalizeWindowDescriptorInput(
  descriptor: LegacyWindowDescriptorInput,
  options: NormalizeWindowDescriptorOptions = {},
): StoredWindowDescriptor {
  return {
    ...descriptor,
    id: descriptor.id || options.createId?.() || randomUUID(),
    kind: descriptor.kind ?? options.defaultKind ?? 'secondary',
    type: descriptor.type === 'floating' ? 'floating' : 'panel-area',
    entry: descriptor.entry ?? options.defaultEntry ?? '',
    state: descriptor.state ?? options.defaultState ?? 'open',
    layout: descriptor.layout,
    panelInstanceIds: descriptor.panelInstanceIds ?? [],
  };
}

export function toWindowDescriptor(windowGroup: StoredWindowDescriptor): WindowDescriptor {
  return {
    id: windowGroup.id,
    kind: windowGroup.kind,
    type: windowGroup.type,
    entry: windowGroup.entry,
    state: windowGroup.state,
    layout: windowGroup.layout,
    panelInstanceIds: windowGroup.panelInstanceIds,
  };
}
