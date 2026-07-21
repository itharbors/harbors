import { describe, it, expect, vi } from 'vitest';
import '../../src/components/floating-panel-layer';
import { i18nStore } from '../../src/i18n/store';

describe('floating-panel-layer', () => {
  it('renders one floating panel and one minimized chip', () => {
    const layer = document.createElement('floating-panel-layer');
    layer.setAttribute('data-state', JSON.stringify([
      {
        id: 'p-1',
        panelName: '@itharbors/log.log',
        title: 'Log',
        src: '/api/assets/panel/%40itharbors%2Flog.log.html?sessionId=s1',
        state: 'open',
        position: { x: 80, y: 60 },
      },
      {
        id: 'p-2',
        panelName: '@itharbors/plugin-detail.detail',
        title: 'Detail',
        src: '/api/assets/panel/%40itharbors%2Fplugin-detail.detail.html?sessionId=s1',
        state: 'minimized',
        edge: 'left',
      },
    ]));
    document.body.appendChild(layer);

    expect(layer.getAttribute('data-count')).toBe('2');
    expect(layer.shadowRoot?.querySelectorAll('.floating-window')).toHaveLength(1);
    expect(layer.shadowRoot?.querySelectorAll('.edge-chip')).toHaveLength(1);

    layer.remove();
  });

  it('renders ce-panel title-i18n and refreshes minimized chip titles from i18n', async () => {
    i18nStore.hydrate({
      locale: 'zh-CN',
      defaultLocale: 'zh-CN',
      version: 1,
      currentMessages: { 'panel.log.title': '日志' },
      defaultMessages: { 'panel.log.title': '日志' },
    });
    const layer = document.createElement('floating-panel-layer');
    layer.setAttribute('data-state', JSON.stringify([
      {
        id: 'p-1',
        panelName: '@itharbors/log.log',
        title: 'Log',
        titleKey: 'panel.log.title',
        src: '/api/assets/panel/%40itharbors%2Flog.log.html?sessionId=s1',
        state: 'open',
      },
      {
        id: 'p-2',
        panelName: '@itharbors/log.log',
        title: 'Log',
        titleKey: 'panel.log.title',
        src: '/api/assets/panel/%40itharbors%2Flog.log.html?sessionId=s1',
        state: 'minimized',
      },
    ]));
    document.body.appendChild(layer);
    await Promise.resolve();

    expect(layer.shadowRoot?.querySelector('ce-panel')?.getAttribute('title-i18n')).toBe('panel.log.title');
    expect(layer.shadowRoot?.querySelector('.edge-chip')?.textContent?.trim()).toBe('日志');

    i18nStore.replaceVisibleSnapshot({
      locale: 'en-US',
      defaultLocale: 'zh-CN',
      version: 2,
      currentMessages: { 'panel.log.title': 'Log' },
      defaultMessages: { 'panel.log.title': '日志' },
    }, {
      type: 'messages-changed',
      version: 2,
      changedKeys: ['panel.log.title'],
      affectsFallback: false,
    });

    expect(layer.shadowRoot?.querySelector('.edge-chip')?.textContent?.trim()).toBe('Log');

    layer.remove();
  });

  it('emits minimize, restore, and close actions', async () => {
    const layer = document.createElement('floating-panel-layer');
    layer.setAttribute('data-state', JSON.stringify([
      {
        id: 'p-1',
        panelName: '@itharbors/log.log',
        title: 'Log',
        src: '/api/assets/panel/%40itharbors%2Flog.log.html?sessionId=s1',
        state: 'open',
      },
      {
        id: 'p-2',
        panelName: '@itharbors/plugin-detail.detail',
        title: 'Detail',
        src: '/api/assets/panel/%40itharbors%2Fplugin-detail.detail.html?sessionId=s1',
        state: 'minimized',
      },
    ]));
    const minimize = vi.fn();
    const restore = vi.fn();
    const close = vi.fn();
    layer.addEventListener('ce-floating-panel-minimize', minimize);
    layer.addEventListener('ce-floating-panel-restore', restore);
    layer.addEventListener('ce-floating-panel-close', close);
    document.body.appendChild(layer);
    await Promise.resolve();

    layer.shadowRoot?.querySelector<HTMLElement>('[data-floating-action="minimize"]')?.click();
    layer.shadowRoot?.querySelector<HTMLElement>('[data-floating-action="restore"]')?.click();
    layer.shadowRoot?.querySelector<HTMLElement>('[data-floating-action="close"]')?.click();

    expect(minimize).toHaveBeenCalledWith(expect.objectContaining({
      detail: { panelInstanceId: 'p-1' },
    }));
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({
      detail: { panelInstanceId: 'p-2' },
    }));
    expect(close).toHaveBeenCalledWith(expect.objectContaining({
      detail: { panelInstanceId: 'p-1' },
    }));

    layer.remove();
  });
});
