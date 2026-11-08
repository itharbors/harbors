import { describe, it, expect, vi } from 'vitest';
import { updateFloatingGeometry } from '../../src/components/floating-panel-layer';
import { i18nStore } from '../../src/i18n/store';

describe('floating-panel-layer', () => {
  it('clamps movement and both resize corners while preserving the opposite edge', () => {
    const initial = { x: 100, y: 80, width: 420, height: 320 };
    expect(updateFloatingGeometry(initial, 'move', -500, 500, 800, 600)).toEqual({ x: 0, y: 280, width: 420, height: 320 });
    expect(updateFloatingGeometry(initial, 'resize-left', -200, 100, 800, 600)).toEqual({ x: 0, y: 80, width: 520, height: 420 });
    expect(updateFloatingGeometry(initial, 'resize-left', 1000, -1000, 800, 600)).toEqual({ x: 280, y: 80, width: 240, height: 180 });
    expect(updateFloatingGeometry(initial, 'resize-right', 1000, 1000, 800, 600)).toEqual({ x: 100, y: 80, width: 700, height: 520 });
    expect(updateFloatingGeometry(initial, 'move', 0, 0, 150, 100)).toEqual({ x: 0, y: 0, width: 150, height: 100 });
  });

  it('captures and cleans pointer gestures, commits on up and rolls back on cancel', () => {
    const layer = document.createElement('floating-panel-layer');
    layer.setAttribute('data-state', JSON.stringify([{ id: 'first', panelName: 'one.main', title: 'One', src: '/one', state: 'open' }]));
    document.body.append(layer);
    const floating = layer.shadowRoot!.querySelector<HTMLElement>('.floating-window')!;
    const toolbar = floating.querySelector<HTMLElement>('.floating-toolbar')!;
    const resize = floating.querySelector<HTMLElement>('[data-resize="left"]')!;
    const captured = vi.fn();
    const released = vi.fn();
    toolbar.setPointerCapture = captured;
    toolbar.releasePointerCapture = released;
    resize.setPointerCapture = captured;
    resize.releasePointerCapture = released;
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} });
    floating.getBoundingClientRect = () => ({ left: 100, top: 80, right: 520, bottom: 400, width: 420, height: 320, x: 100, y: 80, toJSON() {} });
    const pointer = (type: string, x: number, y: number, id = 1) => {
      const event = new MouseEvent(type, { bubbles: true, composed: true, button: 0, clientX: x, clientY: y });
      Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: true } });
      return event;
    };
    const committed = vi.fn();
    layer.addEventListener('ce-floating-panel-geometry', committed);
    floating.querySelector<HTMLElement>('[data-floating-action="close"]')!.dispatchEvent(pointer('pointerdown', 100, 80));
    expect(captured).not.toHaveBeenCalled();
    toolbar.dispatchEvent(pointer('pointerdown', 100, 80));
    expect(captured).toHaveBeenCalledWith(1);
    expect(layer.shadowRoot!.querySelector('.gesture-shield')).not.toBeNull();
    window.dispatchEvent(pointer('pointermove', 160, 110));
    expect(floating.style.left).toBe('160px');
    expect(floating.style.top).toBe('110px');
    window.dispatchEvent(pointer('pointerup', 160, 110));
    expect(committed).toHaveBeenCalledWith(expect.objectContaining({ detail: { panelInstanceId: 'first', position: { x: 160, y: 110 }, size: { width: 420, height: 320 } } }));
    expect(layer.shadowRoot!.querySelector('.gesture-shield')).toBeNull();
    expect(released).toHaveBeenCalledWith(1);

    resize.dispatchEvent(pointer('pointerdown', 100, 400, 2));
    window.dispatchEvent(pointer('pointermove', 50, 450, 2));
    expect(floating.style.left).toBe('50px');
    window.dispatchEvent(pointer('pointercancel', 50, 450, 2));
    expect(floating.style.left).toBe('100px');
    expect(committed).toHaveBeenCalledTimes(1);
    expect(layer.shadowRoot!.querySelector('.gesture-shield')).toBeNull();

    toolbar.dispatchEvent(pointer('pointerdown', 100, 80, 3));
    toolbar.dispatchEvent(pointer('lostpointercapture', 100, 80, 3));
    expect(layer.shadowRoot!.querySelector('.gesture-shield')).toBeNull();
    expect(committed).toHaveBeenCalledTimes(1);
    toolbar.dispatchEvent(pointer('pointerdown', 100, 80, 4));
    layer.remove();
    expect(layer.shadowRoot!.querySelector('.gesture-shield')).toBeNull();
    window.dispatchEvent(pointer('pointerup', 150, 100, 4));
    expect(committed).toHaveBeenCalledTimes(1);
  });

  it('preserves existing iframe documents through other instances', async () => {
    const layer = document.createElement('floating-panel-layer');
    const first = { id: 'first', panelName: 'one.main', title: 'One', src: '/one', state: 'open' };
    const second = { id: 'second', panelName: 'two.main', title: 'Two', src: '/two', state: 'open' };
    const setItems = (items: unknown[]) => layer.setAttribute('data-state', JSON.stringify(items));
    const getIframe = (id: string) => layer.shadowRoot!
      .querySelector(`.floating-window[data-panel-instance-id="${id}"] ce-panel`)
      ?.shadowRoot?.querySelector('iframe');
    setItems([first, second]);
    document.body.append(layer);
    await Promise.resolve();
    const firstFrame = getIframe('first')!;
    const secondFrame = getIframe('second')!;
    Object.defineProperty(firstFrame, 'contentDocument', { configurable: true, value: document.implementation.createHTMLDocument('draft') });
    firstFrame.contentDocument!.body.innerHTML = '<input value="草稿">';
    const input = firstFrame.contentDocument!.querySelector('input')!;
    input.value = '未保存草稿';
    firstFrame.contentDocument!.documentElement.scrollTop = 25;

    const third = { id: 'third', panelName: 'three.main', title: 'Three', src: '/three', state: 'open' };
    setItems([first, second, third]);
    expect(getIframe('first')).toBe(firstFrame);
    expect(getIframe('second')).toBe(secondFrame);
    expect(firstFrame.contentDocument!.querySelector('input')!.value).toBe('未保存草稿');
    expect(firstFrame.contentDocument!.documentElement.scrollTop).toBe(25);
    setItems([first, second]);
    expect(getIframe('first')).toBe(firstFrame);
    expect(getIframe('second')).toBe(secondFrame);
    layer.remove();
  });

  it('renders two floating panels', () => {
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
        state: 'open',
      },
    ]));
    document.body.appendChild(layer);

    expect(layer.getAttribute('data-count')).toBe('2');
    expect(layer.shadowRoot?.querySelectorAll('.floating-window')).toHaveLength(2);
    expect(layer.shadowRoot?.querySelectorAll('.edge-chip')).toHaveLength(0);

    layer.remove();
  });

  it('renders ce-panel title-i18n and refreshes floating titles from i18n', async () => {
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
        state: 'open',
      },
    ]));
    document.body.appendChild(layer);
    await Promise.resolve();

    expect(layer.shadowRoot?.querySelector('ce-panel')?.getAttribute('title-i18n')).toBe('panel.log.title');
    expect(layer.shadowRoot?.querySelector('.floating-title')?.textContent?.trim()).toBe('日志');

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

    expect(layer.shadowRoot?.querySelector('.floating-title')?.textContent?.trim()).toBe('Log');

    layer.remove();
  });

  it('emits close actions', async () => {
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
        state: 'open',
      },
    ]));
    const close = vi.fn();
    layer.addEventListener('ce-floating-panel-close', close);
    document.body.appendChild(layer);
    await Promise.resolve();

    layer.shadowRoot?.querySelector<HTMLElement>('[data-floating-action="close"]')?.click();

    expect(close).toHaveBeenCalledWith(expect.objectContaining({
      detail: { panelInstanceId: 'p-1' },
    }));

    layer.remove();
  });

  it('updates only the affected floating iframe for availability changes', async () => {
    const layer = document.createElement('floating-panel-layer');
    layer.setAttribute('data-state', JSON.stringify([
      {
        id: 'p-1',
        panelName: '@itharbors/log.log',
        title: 'Log',
        src: '/log?sessionId=s1',
        state: 'open',
      },
      {
        id: 'p-2',
        panelName: '@itharbors/plugin-list.list',
        title: 'List',
        src: '/list?sessionId=s1',
        state: 'open',
      },
    ]));
    document.body.appendChild(layer);
    await Promise.resolve();

    const panels = Array.from(layer.shadowRoot!.querySelectorAll('ce-panel'));
    const otherIframe = panels[1].shadowRoot!.querySelector('iframe');
    (layer as HTMLElement & { updatePanelAvailability: (input: unknown) => void }).updatePanelAvailability({
      panelName: '@itharbors/log.log',
      src: '/log?sessionId=s1&panelRevision=2',
      state: 'unavailable',
      revision: 2,
    });

    expect(panels[0].shadowRoot!.querySelector('iframe')).toBeNull();
    expect(panels[0].shadowRoot!.querySelector('.unavailable')?.textContent).toBe('插件未加载');
    expect(panels[1].shadowRoot!.querySelector('iframe')).toBe(otherIframe);

    (layer as HTMLElement & { updatePanelAvailability: (input: unknown) => void }).updatePanelAvailability({
      panelName: '@itharbors/log.log',
      src: '/log?sessionId=s1&panelRevision=3',
      state: 'available',
      revision: 3,
    });
    expect(panels[0].shadowRoot!.querySelector('iframe')?.getAttribute('src')).toBe('/log?sessionId=s1&panelRevision=3');
    expect(panels[0].getAttribute('data-panel-revision')).toBe('3');
    expect(panels[1].shadowRoot!.querySelector('iframe')).toBe(otherIframe);

    layer.remove();
  });
});
