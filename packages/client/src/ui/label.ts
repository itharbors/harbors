import { i18nStore } from '../i18n/store';

export class CeLabel extends HTMLElement {
  static observedAttributes = ['i18n', 'params'];

  private disposeI18n: (() => void) | null = null;

  connectedCallback() {
    this.disposeI18n = i18nStore.subscribe((event) => {
      if (event.type === 'locale-changed' || event.changedKeys.includes(this.key)) {
        this.refresh();
      }
    });
    this.refresh();
  }

  disconnectedCallback() {
    this.disposeI18n?.();
    this.disposeI18n = null;
  }

  attributeChangedCallback() {
    this.refresh();
  }

  get key(): string {
    return this.getAttribute('i18n') || '';
  }

  private get params(): Record<string, unknown> {
    const raw = this.getAttribute('params');
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private refresh() {
    this.textContent = this.key ? i18nStore.t(this.key, this.params) : '';
  }
}

if (!customElements.get('ce-label')) {
  customElements.define('ce-label', CeLabel);
}
