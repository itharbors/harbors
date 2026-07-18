import { describe, expect, it, vi } from 'vitest';
import { I18nModule } from '../../src/framework/i18n/index';

describe('I18nModule', () => {
  it('resolves current locale, then default locale, then key', () => {
    const i18n = new I18nModule({ defaultLocale: 'zh-CN', initialLocale: 'en-US' });

    i18n.registerMessages({
      'zh-CN': {
        'menu.file': '文件',
        'menu.edit': '编辑',
      },
      'en-US': {
        'menu.file': 'File',
      },
    });

    expect(i18n.t('menu.file')).toBe('File');
    expect(i18n.t('menu.edit')).toBe('编辑');
    expect(i18n.t('menu.missing')).toBe('menu.missing');
  });

  it('overrides earlier sources and restores the previous value on dispose', () => {
    const i18n = new I18nModule({ defaultLocale: 'zh-CN', initialLocale: 'zh-CN' });

    const disposeA = i18n.registerMessages({
      'zh-CN': {
        'panel.log.title': '日志',
      },
    });
    const disposeB = i18n.registerMessages({
      'zh-CN': {
        'panel.log.title': '运行日志',
      },
    });

    expect(i18n.t('panel.log.title')).toBe('运行日志');

    disposeB();
    expect(i18n.t('panel.log.title')).toBe('日志');

    disposeA();
    expect(i18n.t('panel.log.title')).toBe('panel.log.title');
  });

  it('reports only the changed visible keys when messages change', () => {
    const i18n = new I18nModule({ defaultLocale: 'zh-CN', initialLocale: 'en-US' });
    const listener = vi.fn();
    i18n.subscribe(listener);

    i18n.registerMessages({
      'zh-CN': {
        'menu.file': '文件',
        'menu.edit': '编辑',
      },
      'en-US': {
        'menu.file': 'File',
      },
    });

    expect(listener).toHaveBeenLastCalledWith({
      type: 'messages-changed',
      version: 1,
      changedKeys: ['menu.file', 'menu.edit'],
      affectsFallback: true,
    });
  });

  it('switches locale atomically and interpolates parameters', async () => {
    const i18n = new I18nModule({ defaultLocale: 'zh-CN', initialLocale: 'zh-CN' });
    const listener = vi.fn();
    i18n.subscribe(listener);

    i18n.registerMessages({
      'zh-CN': {
        'welcome.message': '你好，{name}',
      },
      'en-US': {
        'welcome.message': 'Hello, {name}',
      },
    });

    await i18n.setLocale('en-US');

    expect(i18n.t('welcome.message', { name: 'Claude' })).toBe('Hello, Claude');
    expect(listener).toHaveBeenLastCalledWith({
      type: 'locale-changed',
      locale: 'en-US',
      version: 2,
    });
  });
});
