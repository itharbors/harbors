import type { PanelDefinition } from './panel';

declare global {
  interface Window {
    __panelDefinition?: PanelDefinition;
    editor: {
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
        setModalOpen(open: boolean): void;
      };
    };
  }
}

export {};
