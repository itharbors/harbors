import { describe, it, expect, afterEach } from 'vitest';
import { i18nStore } from '../../src/i18n/store';
import '../../src/layout/panel';
import type { Panel } from '../../src/layout/panel';

describe('ce-panel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders header slot', () => {
    const el = document.createElement('ce-panel') as Panel;
    const header = document.createElement('span');
    header.setAttribute('slot', 'header');
    header.textContent = 'My Panel';
    el.appendChild(header);
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('slot[name="header"]')).not.toBeNull();
  });

  it('does not create iframe when src is empty', () => {
    const el = document.createElement('ce-panel') as Panel;
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('iframe')).toBeNull();
    expect(el.shadowRoot!.querySelector('.content slot')).not.toBeNull();
  });

  it('creates iframe when src is set', () => {
    const el = document.createElement('ce-panel') as Panel;
    el.setAttribute('src', '/editor?file=test.ts');
    document.body.appendChild(el);

    const iframe = el.shadowRoot!.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.src).toContain('/editor?file=test.ts');
    expect(iframe!.getAttribute('allowtransparency')).toBe('true');
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    const sandboxTokens = (iframe as HTMLIFrameElement).sandbox
      ? Array.from((iframe as HTMLIFrameElement).sandbox)
      : iframe!.getAttribute('sandbox')!.split(' ');
    expect(sandboxTokens).toEqual([
      'allow-scripts',
      'allow-same-origin',
    ]);
    expect((iframe as HTMLIFrameElement).style.background).toBe('transparent');
  });

  it('forces same-origin iframe document backgrounds to transparent', () => {
    const el = document.createElement('ce-panel') as Panel;
    el.setAttribute('src', '/editor');
    document.body.appendChild(el);

    const iframe = el.shadowRoot!.querySelector('iframe') as HTMLIFrameElement;
    const iframeDocument = document.implementation.createHTMLDocument('panel');
    iframeDocument.body.style.background = 'rgb(32, 32, 32)';
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      value: iframeDocument,
    });

    iframe.dispatchEvent(new Event('load'));

    expect(iframeDocument.documentElement.style.background).toBe('transparent');
    expect(iframeDocument.body.style.getPropertyValue('background')).toBe('transparent');
    expect(iframeDocument.getElementById('ce-panel-transparent-frame')?.textContent).toContain('background: transparent !important');
  });

  it('does not render a collapse button', () => {
    const el = document.createElement('ce-panel') as Panel;
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('.collapse-btn')).toBeNull();
  });

  it('keeps iframe visible even if legacy collapsed attribute is present', () => {
    const el = document.createElement('ce-panel') as Panel;
    el.setAttribute('src', '/editor');
    el.setAttribute('collapsed', '');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('iframe')).not.toBeNull();
  });

  it('updates translated attributes when the visible snapshot changes', () => {
    i18nStore.hydrate({
      locale: 'zh-CN',
      defaultLocale: 'zh-CN',
      version: 1,
      currentMessages: { 'panel.settings.title': '设置' },
      defaultMessages: { 'panel.settings.title': '设置' },
    });

    const el = document.createElement('ce-panel');
    el.setAttribute('title-i18n', 'panel.settings.title');
    document.body.appendChild(el);

    expect(el.getAttribute('title')).toBe('设置');

    i18nStore.replaceVisibleSnapshot(
      {
        locale: 'en-US',
        defaultLocale: 'zh-CN',
        version: 2,
        currentMessages: { 'panel.settings.title': 'Settings' },
        defaultMessages: { 'panel.settings.title': '设置' },
      },
      {
        type: 'messages-changed',
        version: 2,
        changedKeys: ['panel.settings.title'],
        affectsFallback: false,
      },
    );

    expect(el.getAttribute('title')).toBe('Settings');
  });

  it('hides overflowing slotted content from stretching the layout', () => {
    const el = document.createElement('ce-panel') as Panel;
    document.body.appendChild(el);

    const styles = el.shadowRoot!.querySelector('style')!.textContent || '';
    expect(styles).toContain(':host {');
    expect(styles).toContain('background: var(--ce-panel-bg, var(--ce-surface, #1a1a1a))');
    expect(styles).toContain('border: var(--ce-panel-border-width, 1px) solid var(--ce-panel-border-color, var(--ce-border, #444))');
    expect(styles).toContain('background: var(--ce-panel-header-bg, var(--ce-surface-raised, #2d2d2d))');
    expect(styles).toContain('.content {');
    expect(styles).toContain('background: var(--ce-panel-content-bg, var(--ce-surface, #1a1a1a))');
    expect(styles).toContain('iframe {');
    expect(styles).toContain('background: transparent');
    expect(styles).toContain('.content slot');
    expect(styles).toContain('min-width: 0');
    expect(styles).toContain('overflow: hidden');
  });

  describe('type="simple"', () => {
    it('renders slot content without iframe', () => {
      const el = document.createElement('ce-panel') as Panel;
      el.setAttribute('type', 'simple');
      el.innerHTML = '<div>inline content</div>';
      document.body.appendChild(el);

      expect(el.shadowRoot!.querySelector('iframe')).toBeNull();
      const slot = el.shadowRoot!.querySelector('.content slot');
      expect(slot).not.toBeNull();
    });

    it('creates iframe when src is set and keeps content chromeless', () => {
      const el = document.createElement('ce-panel') as Panel;
      el.setAttribute('type', 'simple');
      el.setAttribute('src', '/some-page');
      document.body.appendChild(el);

      expect(el.shadowRoot!.querySelector('iframe')).not.toBeNull();
      expect(el.shadowRoot!.querySelector('.header')).toBeNull();
    });

    it('default type is iframe (backward compatible)', () => {
      const el = document.createElement('ce-panel') as Panel;
      expect(el.getAttribute('type')).toBeNull();

      el.setAttribute('src', '/editor');
      document.body.appendChild(el);

      expect(el.shadowRoot!.querySelector('iframe')).not.toBeNull();
    });

    it('does not render header slot in simple mode', () => {
      const el = document.createElement('ce-panel') as Panel;
      el.setAttribute('type', 'simple');
      const header = document.createElement('span');
      header.setAttribute('slot', 'header');
      header.textContent = 'Status';
      el.appendChild(header);
      document.body.appendChild(el);

      const slot = el.shadowRoot!.querySelector('slot[name="header"]');
      expect(slot).toBeNull();
    });
  });
});
