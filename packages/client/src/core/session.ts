import type { BootstrapInfo, PanelInstanceDescriptor, SessionInfo } from '@itharbors/plugin-types';

export type {
  BootstrapInfo,
  I18nChangeEvent,
  I18nVisibleSnapshot,
  KitMenuRoot,
  KitWindowEntries,
  LayoutNode,
  MenuTreeMenuNode,
  MenuTreeNode,
  MenuTreeSeparatorNode,
  PanelDescriptor,
  PanelInstanceDescriptor,
  SessionInfo,
  WindowDescriptor,
} from '@itharbors/plugin-types';

/** @deprecated Use PanelInstanceDescriptor from @itharbors/plugin-types. */
export type PanelInstanceSnapshot = PanelInstanceDescriptor;

export class ClientSession {
  sessionId: string;
  connected: boolean = false;
  sseActive: boolean = false;
  sessionInfo: SessionInfo | null = null;
  bootstrapInfo: BootstrapInfo | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }
}
