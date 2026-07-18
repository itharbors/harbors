import type { I18nChangeEvent, I18nVisibleSnapshot, MenuTreeNode } from './bootstrap.js';
import type { WindowDescriptor } from './layout.js';
import type { ProtocolVersion } from './version.js';

export interface ProtocolEnvelope {
  protocolVersion: ProtocolVersion;
  type: string;
}

export interface ConnectedSSEEvent extends ProtocolEnvelope {
  type: 'connected';
  sessionId: string;
}

export interface HeartbeatSSEEvent extends ProtocolEnvelope {
  type: 'heartbeat';
  ts: number;
}

export interface PanelDispatchSSEEvent extends ProtocolEnvelope {
  type: 'panel-dispatch';
  panel: string;
  method: string;
  args: unknown[];
  requestId?: string;
}

export interface LayoutChangedSSEEvent extends ProtocolEnvelope {
  type: 'layout-changed';
  window: WindowDescriptor;
}

export interface MenuChangedSSEEvent extends ProtocolEnvelope {
  type: 'menu-changed';
  menuTree: MenuTreeNode[];
}

export type I18nChangedSSEEvent = ProtocolEnvelope & I18nChangeEvent & {
  i18n: I18nVisibleSnapshot;
  menuTree: MenuTreeNode[];
};

export type SSEEnvelope =
  | ConnectedSSEEvent
  | HeartbeatSSEEvent
  | PanelDispatchSSEEvent
  | LayoutChangedSSEEvent
  | MenuChangedSSEEvent
  | I18nChangedSSEEvent;

type WithoutProtocolVersion<T> = T extends ProtocolEnvelope
  ? Omit<T, 'protocolVersion'>
  : never;

export type UnversionedSSEEnvelope = WithoutProtocolVersion<SSEEnvelope>;

export type BrowserDispatchResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export interface BrowserDispatchResultInput {
  sessionId: string;
  requestId: string;
  result: BrowserDispatchResult;
}
