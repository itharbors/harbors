import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { I18nClient } from '../../src/i18n/client';

describe('I18nClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        locale: 'en-US',
        defaultLocale: 'zh-CN',
        version: 2,
        currentMessages: { 'menu.file': 'File' },
        defaultMessages: { 'menu.file': '文件' },
      }),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('posts locale updates to the i18n route for the session', async () => {
    const client = new I18nClient('test-session-123');

    const snapshot = await client.setLocale('en-US');

    expect(fetchMock).toHaveBeenCalledWith('/api/i18n?sessionId=test-session-123', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'en-US' }),
    });
    expect(snapshot.locale).toBe('en-US');
  });
});
