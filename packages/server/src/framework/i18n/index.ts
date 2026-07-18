import type { EditorI18n, I18nChangeEvent, I18nVisibleSnapshot, MessagesBundle } from './types';

interface I18nModuleOptions {
  defaultLocale: string;
  initialLocale?: string;
  isLocalePrepared?: (locale: string) => Promise<boolean> | boolean;
}

interface SourceLayer {
  sourceId: string;
  bundle: MessagesBundle;
}

export class I18nModule implements EditorI18n {
  private locale: string;
  private readonly defaultLocale: string;
  private version = 0;
  private sourceCounter = 0;
  private readonly listeners = new Set<(event: I18nChangeEvent) => void>();
  private readonly layers: SourceLayer[] = [];
  private readonly isLocalePrepared?: I18nModuleOptions['isLocalePrepared'];

  constructor(options: I18nModuleOptions) {
    this.defaultLocale = options.defaultLocale;
    this.locale = options.initialLocale ?? options.defaultLocale;
    this.isLocalePrepared = options.isLocalePrepared;
  }

  getLocale(): string {
    return this.locale;
  }

  getDefaultLocale(): string {
    return this.defaultLocale;
  }

  t(key: string, params: Record<string, unknown> = {}): string {
    const raw = this.lookup(this.locale, key) ?? this.lookup(this.defaultLocale, key) ?? key;
    return interpolate(raw, params);
  }

  registerMessages(bundle: MessagesBundle): () => void {
    const sourceId = `source-${this.sourceCounter += 1}`;
    const previous = this.getVisibleSnapshot();
    this.layers.push({ sourceId, bundle: cloneBundle(bundle) });
    this.emitVisibleChanges(previous);

    return () => {
      const index = this.layers.findIndex((layer) => layer.sourceId === sourceId);
      if (index < 0) return;
      const beforeDispose = this.getVisibleSnapshot();
      this.layers.splice(index, 1);
      this.emitVisibleChanges(beforeDispose);
    };
  }

  async setLocale(locale: string): Promise<void> {
    if (locale === this.locale) return;

    const prepared = await this.isLocalePrepared?.(locale);
    if (prepared === false) {
      throw new Error(`Locale "${locale}" is not prepared`);
    }

    this.locale = locale;
    this.version += 1;
    this.emit({ type: 'locale-changed', locale, version: this.version });
  }

  subscribe(listener: (event: I18nChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getVisibleSnapshot(): I18nVisibleSnapshot {
    return {
      locale: this.locale,
      defaultLocale: this.defaultLocale,
      version: this.version,
      currentMessages: this.buildLocaleMap(this.locale),
      defaultMessages: this.buildLocaleMap(this.defaultLocale),
    };
  }

  destroy(): void {
    this.listeners.clear();
    this.layers.length = 0;
  }

  private lookup(locale: string, key: string): string | undefined {
    for (let index = this.layers.length - 1; index >= 0; index -= 1) {
      const value = this.layers[index].bundle[locale]?.[key];
      if (value !== undefined) return value;
    }
    return undefined;
  }

  private buildLocaleMap(locale: string): Record<string, string> {
    const map: Record<string, string> = {};
    for (const layer of this.layers) {
      Object.assign(map, layer.bundle[locale] ?? {});
    }
    return map;
  }

  private emitVisibleChanges(previous: I18nVisibleSnapshot): void {
    const next = this.getVisibleSnapshot();
    const changedKeys = Array.from(new Set([
      ...Object.keys(previous.currentMessages),
      ...Object.keys(previous.defaultMessages),
      ...Object.keys(next.currentMessages),
      ...Object.keys(next.defaultMessages),
    ])).filter((key) => {
      const before = previous.currentMessages[key] ?? previous.defaultMessages[key] ?? key;
      const after = next.currentMessages[key] ?? next.defaultMessages[key] ?? key;
      return before !== after;
    });

    if (changedKeys.length === 0) return;

    this.version += 1;
    this.emit({
      type: 'messages-changed',
      version: this.version,
      changedKeys,
      affectsFallback: changedKeys.some((key) => (
        previous.currentMessages[key] === undefined || next.currentMessages[key] === undefined
      )),
    });
  }

  private emit(event: I18nChangeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function cloneBundle(bundle: MessagesBundle): MessagesBundle {
  return Object.fromEntries(
    Object.entries(bundle).map(([locale, messages]) => [locale, { ...messages }]),
  );
}

function interpolate(message: string, params: Record<string, unknown>): string {
  return message.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}
