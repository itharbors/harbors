import type { PanelConstraints, PanelDescriptor, PanelRegistration } from './types';

export class PanelModule {
  private panelMap = new Map<string, PanelRegistration>();
  private dispatcher?: (panelKey: string, method: string, args: unknown[]) => Promise<unknown>;

  register(name: string, modulePath: string, constraints: PanelConstraints = {}, owner = inferPanelOwner(name)): void {
    this.panelMap.set(name, {
      name,
      module: modulePath,
      constraints,
      owner,
    });
  }

  unregister(name: string): void {
    if (!this.panelMap.has(name)) {
      throw new Error(`Panel "${name}" is not registered`);
    }
    this.panelMap.delete(name);
  }

  getInfo(name: string): PanelDescriptor {
    const reg = this.panelMap.get(name);
    if (!reg) {
      throw new Error(`Panel "${name}" is not registered`);
    }
    return this.toDescriptor(reg);
  }

  getRegistration(name: string): PanelRegistration | undefined {
    return this.panelMap.get(name);
  }

  clearOwner(owner: string): void {
    for (const [name, reg] of this.panelMap) {
      if (reg.owner === owner) {
        this.panelMap.delete(name);
      }
    }
  }

  list(): PanelDescriptor[] {
    return Array.from(this.panelMap.values()).map((reg) => this.toDescriptor(reg));
  }

  focus(name: string): void {
    void name;
  }

  setDispatcher(dispatcher: (panelKey: string, method: string, args: unknown[]) => Promise<unknown>): void {
    this.dispatcher = dispatcher;
  }

  async dispatch(panelKey: string, method: string, args: unknown[]): Promise<unknown> {
    if (!this.panelMap.has(panelKey)) {
      throw new Error(`Panel "${panelKey}" is not registered`);
    }
    if (!this.dispatcher) {
      throw new Error(`Panel dispatcher is not configured for "${panelKey}"`);
    }
    return this.dispatcher(panelKey, method, args);
  }

  destroy(): void {
    this.panelMap.clear();
    this.dispatcher = undefined;
  }

  private toDescriptor(reg: PanelRegistration): PanelDescriptor {
    return {
      name: reg.name,
      entry: `/api/assets/panel/${encodeURIComponent(reg.name)}/index.html`,
      title: reg.constraints.title,
      titleKey: reg.constraints.titleKey,
      width: reg.constraints.width,
      height: reg.constraints.height,
      minWidth: reg.constraints.minWidth,
      minHeight: reg.constraints.minHeight,
      multiInstance: reg.constraints.multiInstance,
    };
  }
}

function inferPanelOwner(name: string): string {
  const separatorIndex = name.lastIndexOf('.');
  return separatorIndex > 0 ? name.slice(0, separatorIndex) : name;
}
