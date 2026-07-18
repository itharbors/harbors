export interface PanelContext {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
    broadcast(topic: string, ...args: unknown[]): void;
  };
  assets: {
    url(relativePath: string): string;
  };
  i18n: {
    getLocale(): string;
    t(key: string, params?: Record<string, string | number>): string;
    setLocale(locale: string): Promise<void>;
    subscribe(listener: (event: unknown) => void): () => void;
  };
  panel: {
    focus(name: string): void;
  };
}

export interface PanelDefinition {
  mount?(ctx: PanelContext): void | Promise<void>;
  unmount?(): void | Promise<void>;
  methods?: Record<string, (...args: unknown[]) => unknown>;
}
