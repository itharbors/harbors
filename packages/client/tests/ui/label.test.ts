import { beforeEach, describe, expect, it } from 'vitest';
import { i18nStore } from '../../src/i18n/store';
import '../../src/ui/label';

describe('ce-label', () => {
  beforeEach(() => {
    i18nStore.hydrate({
      locale: 'zh-CN',
      defaultLocale: 'zh-CN',
      version: 1,
      currentMessages: { 'menu.file': '文件', 'menu.edit': '编辑' },
      defaultMessages: { 'menu.file': '文件', 'menu.edit': '编辑' },
    });
  });

  it('renders and refreshes when the i18n key changes', () => {
    const el = document.createElement('ce-label');
    el.setAttribute('i18n', 'menu.file');
    document.body.appendChild(el);

    expect(el.textContent).toBe('文件');

    el.setAttribute('i18n', 'menu.edit');
    expect(el.textContent).toBe('编辑');

    document.body.removeChild(el);
  });
});
