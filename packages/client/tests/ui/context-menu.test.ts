import { describe, expect, it } from 'vitest';
import { i18nStore } from '../../src/i18n/store';
import '../../src/ui/context-menu';

describe('ce-context-menu', () => {
  it('renders menu at configured coordinates when open', () => {
    const el = document.createElement('ce-context-menu');
    el.setAttribute('open', '');
    el.setAttribute('x', '100');
    el.setAttribute('y', '200');
    el.innerHTML = '<div data-action="copy">Copy</div>';
    document.body.appendChild(el);

    const menu = el.shadowRoot!.querySelector('.menu') as HTMLElement;

    expect(menu).not.toBeNull();
    expect(menu.style.left).toBe('100px');
    expect(menu.style.top).toBe('200px');

    document.body.removeChild(el);
  });

  it('does not render menu when closed', () => {
    const el = document.createElement('ce-context-menu');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('.menu')).toBeNull();

    document.body.removeChild(el);
  });

  it('dispatches ce-context-action on item click', async () => {
    const el = document.createElement('ce-context-menu');
    el.setAttribute('open', '');
    el.innerHTML = '<div data-action="delete">Delete</div>';
    document.body.appendChild(el);

    const actionEvent = new Promise<string>((resolve) => {
      el.addEventListener('ce-context-action', ((event: CustomEvent<{ action: string }>) => {
        resolve(event.detail.action);
      }) as EventListener);
    });

    (el.shadowRoot!.querySelector('.menu-item') as HTMLElement).click();

    await expect(actionEvent).resolves.toBe('delete');

    document.body.removeChild(el);
  });

  it('closes after item click', () => {
    const el = document.createElement('ce-context-menu');
    el.setAttribute('open', '');
    el.innerHTML = '<div data-action="rename">Rename</div>';
    document.body.appendChild(el);

    (el.shadowRoot!.querySelector('.menu-item') as HTMLElement).click();

    expect(el.hasAttribute('open')).toBe(false);

    document.body.removeChild(el);
  });

  it('closes on backdrop click', () => {
    const el = document.createElement('ce-context-menu');
    el.setAttribute('open', '');
    el.innerHTML = '<div data-action="copy">Copy</div>';
    document.body.appendChild(el);

    (el.shadowRoot!.querySelector('.backdrop') as HTMLElement).click();

    expect(el.hasAttribute('open')).toBe(false);

    document.body.removeChild(el);
  });

  it('updates translated attributes when the visible snapshot changes', () => {
    i18nStore.hydrate({
      locale: 'zh-CN',
      defaultLocale: 'zh-CN',
      version: 1,
      currentMessages: { 'menu.context.title': '上下文菜单' },
      defaultMessages: { 'menu.context.title': '上下文菜单' },
    });

    const el = document.createElement('ce-context-menu');
    el.setAttribute('title-i18n', 'menu.context.title');
    document.body.appendChild(el);

    expect(el.getAttribute('title')).toBe('上下文菜单');

    i18nStore.replaceVisibleSnapshot(
      {
        locale: 'en-US',
        defaultLocale: 'zh-CN',
        version: 2,
        currentMessages: { 'menu.context.title': 'Context Menu' },
        defaultMessages: { 'menu.context.title': '上下文菜单' },
      },
      {
        type: 'messages-changed',
        version: 2,
        changedKeys: ['menu.context.title'],
        affectsFallback: false,
      },
    );

    expect(el.getAttribute('title')).toBe('Context Menu');

    document.body.removeChild(el);
  });
});
