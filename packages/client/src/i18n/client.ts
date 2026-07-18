import type { I18nVisibleSnapshot } from '../core/session';

export class I18nClient {
  constructor(private readonly sessionId: string) {}

  async setLocale(locale: string): Promise<I18nVisibleSnapshot> {
    const response = await fetch(`/api/i18n?sessionId=${encodeURIComponent(this.sessionId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale }),
    });
    if (!response.ok) {
      throw new Error(`Failed to set locale: ${response.status}`);
    }
    return await response.json() as I18nVisibleSnapshot;
  }
}
