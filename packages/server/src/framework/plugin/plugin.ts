import type { ContributeData, PluginInfo, PluginModule } from './types';
import { PluginStatus } from './types';

export class Plugin {
  info: PluginInfo;
  status: PluginStatus = PluginStatus.Idle;
  instance: PluginModule | null = null;

  constructor(info: PluginInfo) {
    this.info = info;
  }

  get name(): string {
    return this.info.name;
  }

  get path(): string {
    return this.info.path;
  }

  get contribute(): ContributeData | undefined {
    return this.info.contribute;
  }

  setContribute(data: ContributeData): void {
    this.info.contribute = data;
  }
}
