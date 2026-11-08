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

const WINDOW_COPY_OPENING_LEASE_MS = 30_000;

export class WindowManager {
  private readonly windows = new Map<string, StoredWindowDescriptor>();
  private readonly panelInstances = new Map<string, PanelInstanceDescriptor>();
  // Explicit window copies are presentation-specific and must never become
  // the reusable singleton for subsequent ordinary openPanel calls.
  private readonly windowCopies = new Set<string>();
  private readonly windowCopyOpeningLeases = new Map<string, ReturnType<typeof setTimeout>>();
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
    this.cancelWindowCopyOpeningLease(windowId);
    const windowGroup = this.windows.get(windowId);
    for (const panelInstanceId of windowGroup?.panelInstanceIds ?? []) {
      this.panelInstances.delete(panelInstanceId);
      this.windowCopies.delete(panelInstanceId);
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
    for (const windowGroupId of this.windowCopyOpeningLeases.keys()) this.cancelWindowCopyOpeningLease(windowGroupId);
    this.windows.clear();
    this.panelInstances.clear();
    this.windowCopies.clear();
  }

  openPanel(request: OpenPanelRequest, options: { forceNew?: boolean } = {}): OpenPanelResult {
    if (!options.forceNew && !request.multiInstance) {
      const existing = Array.from(this.panelInstances.values()).find((instance) => {
        return instance.panelName === request.panelName && instance.state !== 'closed' && !this.windowCopies.has(instance.id);
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

    if (options.forceNew) this.windowCopies.add(panelInstanceId);

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

    if (options.forceNew) this.startWindowCopyOpeningLease(windowGroupId, panelInstanceId);

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
      this.cancelWindowCopyOpeningLease(instance.windowGroupId);
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

    this.cancelWindowCopyOpeningLease(windowGroupId);

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
    this.windowCopies.delete(panelInstanceId);
    if (!instance.windowGroupId) return;

    this.cancelWindowCopyOpeningLease(instance.windowGroupId);

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

  private startWindowCopyOpeningLease(windowGroupId: string, panelInstanceId: string): void {
    const timer = setTimeout(() => {
      this.windowCopyOpeningLeases.delete(windowGroupId);
      const windowGroup = this.windows.get(windowGroupId);
      const instance = this.panelInstances.get(panelInstanceId);
      if (windowGroup?.kind === 'secondary' && windowGroup.state === 'opening'
        && instance?.windowGroupId === windowGroupId && this.windowCopies.has(panelInstanceId)) {
        this.closeWindowGroup(windowGroupId);
      }
    }, WINDOW_COPY_OPENING_LEASE_MS);
    timer.unref?.();
    this.windowCopyOpeningLeases.set(windowGroupId, timer);
  }

  private cancelWindowCopyOpeningLease(windowGroupId: string): void {
    const timer = this.windowCopyOpeningLeases.get(windowGroupId);
    if (!timer) return;
    clearTimeout(timer);
    this.windowCopyOpeningLeases.delete(windowGroupId);
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
