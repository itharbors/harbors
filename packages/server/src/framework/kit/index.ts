import { normalizeWindowDescriptorInput, toWindowDescriptor } from '../window/index';
import type { KitDescriptor, KitLayoutConfig, KitLayoutInputConfig, KitWindowEntries } from './types';

export class KitModule {
  private kits = new Map<string, KitDescriptor>();
  private activeKitName: string | null = null;

  register(descriptor: KitDescriptor): KitDescriptor {
    this.kits.set(descriptor.name, descriptor);
    return descriptor;
  }

  unregister(name: string): void {
    this.kits.delete(name);
    if (this.activeKitName === name) {
      this.activeKitName = null;
    }
  }

  list(): KitDescriptor[] {
    return Array.from(this.kits.values());
  }

  get(name: string): KitDescriptor | undefined {
    return this.kits.get(name);
  }

  getCurrent(): KitDescriptor | undefined {
    return this.activeKitName ? this.kits.get(this.activeKitName) : undefined;
  }

  switchKit(kitName: string): void {
    if (!this.kits.has(kitName)) {
      throw new Error(`Kit "${kitName}" not found`);
    }
    this.activeKitName = kitName;
  }

  getLayout(name: string): KitLayoutConfig | undefined {
    const kit = this.getCurrent();
    if (!kit) return undefined;
    return kit.layouts[name];
  }

  listLayouts(): string[] {
    const kit = this.getCurrent();
    if (!kit) return [];
    return Object.keys(kit.layouts);
  }

  reset(): void {
    this.kits.clear();
    this.activeKitName = null;
  }
}

export function normalizeKitLayoutConfig(
  input: KitLayoutInputConfig,
  windowEntries: KitWindowEntries,
): KitLayoutConfig {
  return {
    ...input,
    windows: input.windows.map((window, index) => {
      const defaultKind = index === 0 ? 'main' : 'secondary';
      const kind = window.kind ?? defaultKind;
      return toWindowDescriptor(normalizeWindowDescriptorInput(window, {
        defaultKind,
        defaultEntry: kind === 'main' ? windowEntries.main : windowEntries.secondary,
        defaultState: 'open',
      }));
    }),
  };
}
