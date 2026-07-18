import { describe, expect, it } from 'vitest';
import { createI18nStore } from '../../src/i18n/store';

describe('createI18nStore', () => {
  it('uses current messages, then default messages, then key', () => {
    const store = createI18nStore();
    store.hydrate({
      locale: 'en-US',
      defaultLocale: 'zh-CN',
      version: 1,
      currentMessages: { 'menu.file': 'File' },
      defaultMessages: { 'menu.file': '文件', 'menu.edit': '编辑' },
    });

    expect(store.t('menu.file')).toBe('File');
    expect(store.t('menu.edit')).toBe('编辑');
    expect(store.t('menu.help')).toBe('menu.help');
  });

  it('interpolates parameters and notifies subscribers on replacement', () => {
    const store = createI18nStore();
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));

    store.replaceVisibleSnapshot(
      {
        locale: 'zh-CN',
        defaultLocale: 'zh-CN',
        version: 2,
        currentMessages: { welcome: '你好，{name}' },
        defaultMessages: { welcome: '你好，{name}' },
      },
      { type: 'messages-changed', version: 2, changedKeys: ['welcome'], affectsFallback: false },
    );

    expect(store.t('welcome', { name: 'Claude' })).toBe('你好，Claude');
    expect(events).toEqual([
      { type: 'messages-changed', version: 2, changedKeys: ['welcome'], affectsFallback: false },
    ]);
  });
});
