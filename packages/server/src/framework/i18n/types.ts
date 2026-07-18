export type MessagesBundle = Record<string, Record<string, string>>;

export type I18nChangeEvent =
  | {
      type: 'locale-changed';
      locale: string;
      version: number;
    }
  | {
      type: 'messages-changed';
      version: number;
      changedKeys: string[];
      affectsFallback: boolean;
    };

export interface I18nVisibleSnapshot {
  locale: string;
  defaultLocale: string;
  version: number;
  currentMessages: Record<string, string>;
  defaultMessages: Record<string, string>;
}

export interface EditorI18n {
  getLocale(): string;
  getDefaultLocale(): string;
  setLocale(locale: string): Promise<void>;
  t(key: string, params?: Record<string, unknown>): string;
  registerMessages(bundle: MessagesBundle): () => void;
  subscribe(listener: (event: I18nChangeEvent) => void): () => void;
  getVisibleSnapshot(): I18nVisibleSnapshot;
}
