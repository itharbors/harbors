export interface LocalFilePickerOptions {
  accept?: string;
}

export interface LocalFileSaveOptions extends LocalFilePickerOptions {
  suggestedName?: string;
}

export interface PanelFileRuntime {
  openLocal(options?: LocalFilePickerOptions): Promise<string | null>;
  saveLocal(options?: LocalFileSaveOptions): Promise<string | null>;
}

export interface PanelContext {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
    broadcast(topic: string, ...args: unknown[]): void;
  };
  assets: {
    url(relativePath: string): string;
  };
  file: PanelFileRuntime;
  i18n: {
    getLocale(): string;
    t(key: string, params?: Record<string, string | number>): string;
    setLocale(locale: string): Promise<void>;
    subscribe(listener: (event: unknown) => void): () => void;
  };
  panel: {
    focus(name: string): void;
    setModalOpen(open: boolean): void;
  };
}

export interface PanelDefinition {
  mount?(ctx: PanelContext): void | Promise<void>;
  unmount?(): void | Promise<void>;
  methods?: Record<string, (...args: unknown[]) => unknown>;
}
