import type { KitDescriptor } from '../framework/kit/types';
import type { EditorConfig } from '../framework/config';
import type { EditorI18n } from '../framework/i18n/types';
import type { MessageBroadcastRoute, MessageLocation, MessageRequestRoute } from '../framework/message/types';
import type { MenuContributionNode, MenuPlatform, NormalizedMenuResult } from '../framework/menu/types';
import type { PanelConstraints, PanelDefinition, PanelDescriptor, PanelRegistration } from '../framework/panel/types';
import type { PluginDefinition, PluginInfo } from '../framework/plugin/types';
import type { LayoutNode, OpenPanelResult as WindowOpenPanelResult, WindowSnapshot } from '../framework/window/types';

export interface PluginRuntime {
  readonly sessionId: string;
  config: EditorConfig;
  i18n: EditorI18n;
  message: {
    registerRequest(plugin: string, name: string, handler: MessageRequestRoute['handler'], location?: MessageLocation, methods?: string[]): void;
    registerBroadcast(plugin: string, topic: string, handler: MessageBroadcastRoute['handler'], location?: MessageLocation, methods?: string[]): void;
    unregisterRequest(plugin: string, name: string): void;
    unregisterBroadcast(plugin: string, topic: string): void;
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
    broadcast(topic: string, ...args: unknown[]): void;
  };
  panel: {
    register(name: string, modulePath: string, constraints?: PanelConstraints, owner?: string): void;
    unregister(name: string): void;
    getInfo(name: string): PanelDescriptor;
    getRegistration(name: string): PanelRegistration | undefined;
    list(): PanelDescriptor[];
  };
  plugin: {
    define(definition: PluginDefinition): void;
    getInfo(name: string): PluginInfo | undefined;
    listLoaded(): string[];
    listRegistered(): string[];
    callPlugin(name: string, method: string, ...args: unknown[]): unknown;
  };
  kit: {
    list(): KitDescriptor[];
    get(name: string): KitDescriptor | undefined;
    getCurrent(): KitDescriptor | undefined;
    switchKit(kitName: string): Promise<void>;
    applyLayout(input: string | LayoutNode): void;
    readonly layouts: string[];
  };
  menu: {
    attach(pluginName: string, contribute: import('../framework/plugin/types').ContributeData): void;
    detach(pluginName: string): void;
    setDefaults(items: MenuContributionNode[]): void;
    clearDefaults(): void;
    reset(): void;
    getState(): NormalizedMenuResult;
  };
  window: {
    getSnapshot(): WindowSnapshot;
    openPanel(panelName: string): WindowOpenPanelResult;
    markPanelInstanceFloating(panelInstanceId: string): void;
    markWindowGroupOpened(windowGroupId: string): void;
    closeWindowGroup(windowGroupId: string): void;
    setPanelInstanceState(panelInstanceId: string, state: 'open' | 'minimized'): void;
    closePanelInstance(panelInstanceId: string): void;
  };
}

export interface PanelRuntime {
  readonly sessionId: string;
  panelKey: string;
  assets: {
    url(relativePath: string): string;
  };
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
    broadcast(topic: string, ...args: unknown[]): void;
  };
  i18n: {
    getLocale(): string;
    t(key: string, params?: Record<string, unknown>): string;
    setLocale(locale: string): Promise<void>;
    subscribe(listener: (event: { type: string; version: number; locale?: string; changedKeys?: string[]; affectsFallback?: boolean }) => void): () => void;
  };
  panel: {
    focus(name: string): void;
    setModalOpen(open: boolean): void;
  };
  openPanel(panelName: string): Promise<BrowserOpenPanelResult>;
}

export interface Editor {
  readonly sessionId: string;
  isUsable(): boolean;
  dispose(): Promise<void>;
  config: EditorConfig;
  i18n: EditorI18n;
  plugin: {
    define(definition: PluginDefinition): void;
    register(path: string): Promise<void>;
    load(path: string): Promise<void>;
    unload(path: string): Promise<void>;
    unregister(path: string): void;
    getInfo(name: string): PluginInfo | undefined;
    listLoaded(): string[];
    listRegistered(): string[];
    callPlugin(name: string, method: string, ...args: unknown[]): unknown;
  };
  panel: {
    define(definition: PanelDefinition): void;
    register(name: string, modulePath: string, constraints?: PanelConstraints, owner?: string): void;
    unregister(name: string): void;
    getInfo(name: string): PanelDescriptor;
    getRegistration(name: string): PanelRegistration | undefined;
    list(): PanelDescriptor[];
    focus(name: string): void;
  };
  message: {
    registerRequest(plugin: string, name: string, handler: MessageRequestRoute['handler'], location?: MessageLocation, methods?: string[]): void;
    registerBroadcast(plugin: string, topic: string, handler: MessageBroadcastRoute['handler'], location?: MessageLocation, methods?: string[]): void;
    unregisterRequest(plugin: string, name: string): void;
    unregisterBroadcast(plugin: string, topic: string): void;
    queryRequest(plugin: string, name: string): MessageRequestRoute | undefined;
    queryBroadcast(topic: string): MessageBroadcastRoute[];
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
    broadcast(topic: string, ...args: unknown[]): void;
  };
  kit: {
    load(kitNameOrPath?: string): Promise<KitDescriptor>;
    register(descriptor: KitDescriptor): KitDescriptor;
    unregister(name: string): void;
    list(): KitDescriptor[];
    get(name: string): KitDescriptor | undefined;
    getCurrent(): KitDescriptor | undefined;
    switchKit(kitName: string): Promise<void>;
    applyLayout(input: string | LayoutNode): void;
    readonly layouts: string[];
  };
  menu: {
    getState(): NormalizedMenuResult;
    trigger(menuId: string): Promise<unknown>;
  };
  window: {
    getSnapshot(): WindowSnapshot;
    openPanel(panelName: string): WindowOpenPanelResult;
    markPanelInstanceFloating(panelInstanceId: string): void;
    markWindowGroupOpened(windowGroupId: string): void;
    closeWindowGroup(windowGroupId: string): void;
    setPanelInstanceState(panelInstanceId: string, state: 'open' | 'minimized'): void;
    closePanelInstance(panelInstanceId: string): void;
  };
}

export type PluginRuntimeHost = Omit<Editor, 'menu'> & {
  menu: PluginRuntime['menu'];
};

export interface BrowserEditor {
  readonly sessionId: string;
  i18n: Pick<EditorI18n, 'getLocale' | 'setLocale' | 't' | 'subscribe'>;
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
    broadcast(topic: string, ...args: unknown[]): void;
  };
  openPanel(panelName: string): Promise<BrowserOpenPanelResult>;
}

export type BrowserOpenPanelResult = WindowOpenPanelResult & {
  url: string | null;
};
