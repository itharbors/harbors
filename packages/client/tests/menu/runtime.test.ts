import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMenuModeFromURL, mountMenuRuntime, type MenuRuntime } from '../../src/menu/runtime';

const kitTree = [{ type: 'menu' as const, id: 'view', label: '视图', children: [
  { type: 'menu' as const, id: 'view/panels', label: '面板', children: [
    { type: 'menu' as const, id: 'view/panels/ui', label: '界面规范', children: [] },
  ] },
] }];
const menuTree = [{ ...kitTree[0], children: [
  ...kitTree[0].children,
  { type: 'menu' as const, id: 'view/default', label: '默认操作', role: 'reload', children: [] },
] }];
const input = { sessionId: 'base::harness', menuTree, kitMenuTree: kitTree, applicationMenuTree: [], kitMenuRoot: null };
class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn();
  constructor(public url: string) { MockEventSource.instances.push(this); }
}

function button(root: ShadowRoot, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
  if (!found) throw new Error(`missing button: ${label}`);
  return found;
}
async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }

describe('mountMenuRuntime', () => {
  let runtime: MenuRuntime;
  let host: HTMLElement;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    fetchMock = vi.fn(async (url: string) => url === '/api/application/bootstrap'
      ? { ok: true, json: async () => ({ menu: { tree: [{ type: 'menu', id: 'app/file', label: '应用文件', children: [{ type: 'menu', id: 'app/private', label: '重启服务', children: [] }] }] } }) }
      : { ok: true, json: async () => ({ result: null }) });
    vi.stubGlobal('fetch', fetchMock);
    host = document.createElement('div'); document.body.append(host);
    runtime = mountMenuRuntime(input); runtime.attach(host);
  });
  afterEach(() => { runtime.dispose(); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('triggers only Kit leaves with the composite session and keeps application actions read-only', async () => {
    await settle();
    const shadow = host.querySelector('.web-menu-root')!.shadowRoot!;
    button(shadow, '视图').click(); button(shadow, '面板›').click();
    expect([...shadow.querySelectorAll('button')].some((node) => node.textContent?.includes('默认操作'))).toBe(false);
    button(shadow, '界面规范').click(); await settle();
    expect(fetchMock).toHaveBeenCalledWith('/api/menu/trigger', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ sessionId: 'base::harness', menuId: 'view/panels/ui', presentation: 'local' }),
    }));
    button(shadow, '应用菜单').click(); button(shadow, '应用文件›').click();
    expect(button(shadow, '重启服务').disabled).toBe(true);
    button(shadow, '重启服务').click(); await settle();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/application/menu/trigger'))).toBe(false);
  });

  it('updates and removes menu contributions without replacing the attached host and closes on outside click', async () => {
    await settle();
    const root = host.querySelector('.web-menu-root')!;
    const shadow = root.shadowRoot!;
    button(shadow, '视图').click();
    expect(button(shadow, '视图').getAttribute('aria-expanded')).toBe('true');
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(button(shadow, '视图').getAttribute('aria-expanded')).toBe('false');
    runtime.update({ ...input, sessionId: 'base::other', menuTree: [], kitMenuTree: [] });
    expect(host.querySelector('.web-menu-root')).toBe(root);
    expect([...shadow.querySelectorAll('button')].some((node) => node.textContent?.includes('界面规范'))).toBe(false);
  });

  it('renders shared menu paths from multiple plugin contributions and removes them dynamically', async () => {
    await settle();
    const shadow = host.querySelector('.web-menu-root')!.shadowRoot!;
    const second = { type: 'menu' as const, id: 'view/panels/other', label: '另一个插件', children: [] };
    const shared = [{ ...kitTree[0], children: [{ ...kitTree[0].children[0], children: [...kitTree[0].children[0].children, second] }] }];
    runtime.update({ ...input, kitMenuTree: shared });
    button(shadow, '视图').click(); button(shadow, '面板›').click();
    expect(button(shadow, '界面规范')).toBeTruthy();
    button(shadow, '另一个插件').click(); await settle();
    expect(fetchMock).toHaveBeenCalledWith('/api/menu/trigger', expect.objectContaining({ body: JSON.stringify({ sessionId: 'base::harness', menuId: 'view/panels/other', presentation: 'local' }) }));
    runtime.update(input);
    expect([...shadow.querySelectorAll('button')].some((node) => node.textContent === '另一个插件')).toBe(false);
  });

  it('shows no placeholder for empty Kit and application trees, including after updates', async () => {
    await settle();
    const shadow = host.querySelector('.web-menu-root')!.shadowRoot!;
    runtime.update({ ...input, kitMenuTree: [] });
    MockEventSource.instances[0].onmessage?.({ data: JSON.stringify({ type: 'application-bootstrap', bootstrap: { menu: { tree: [] } } }) });
    expect(shadow.querySelectorAll('.top')).toHaveLength(0);
    runtime.update(input);
    expect(button(shadow, '视图')).toBeTruthy();
    expect([...shadow.querySelectorAll('.top')].some((node) => node.textContent === '应用菜单')).toBe(false);
  });

  it('closes when focus moves to an iframe or browser window loses focus', async () => {
    await settle();
    const shadow = host.querySelector('.web-menu-root')!.shadowRoot!;
    const top = button(shadow, '视图');
    top.click();
    const iframe = document.createElement('iframe'); document.body.append(iframe);
    iframe.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    expect(top.getAttribute('aria-expanded')).toBe('false');
    top.click(); window.dispatchEvent(new Event('blur'));
    expect(top.getAttribute('aria-expanded')).toBe('false');
    iframe.remove();
  });

  it('supports top-level Kit actions, horizontal navigation and retains a useful focus after update', async () => {
    await settle();
    const shadow = host.querySelector('.web-menu-root')!.shadowRoot!;
    const direct = { type: 'menu' as const, id: 'quick', label: '快捷操作', children: [] };
    runtime.update({ ...input, menuTree: [...input.menuTree, direct], kitMenuTree: [...input.kitMenuTree, direct] });
    const top = button(shadow, '视图'); top.focus();
    top.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(shadow.activeElement).toBe(button(shadow, '快捷操作'));
    button(shadow, '快捷操作').click(); await settle();
    expect(fetchMock).toHaveBeenCalledWith('/api/menu/trigger', expect.objectContaining({ body: JSON.stringify({ sessionId: 'base::harness', menuId: 'quick', presentation: 'local' }) }));
    top.click(); button(shadow, '面板›').click(); button(shadow, '界面规范').focus();
    runtime.update(input);
    expect(shadow.activeElement?.textContent).toBe('视图');
    const refreshedTop = button(shadow, '视图'); refreshedTop.click();
    refreshedTop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(refreshedTop.getAttribute('aria-expanded')).toBe('false');
  });

  it('uses the updated composite session and renders Application Runtime updates as read-only', async () => {
    await settle();
    const shadow = host.querySelector('.web-menu-root')!.shadowRoot!;
    runtime.update({ ...input, sessionId: 'base::new-kit' });
    button(shadow, '视图').click(); button(shadow, '面板›').click(); button(shadow, '界面规范').click(); await settle();
    expect(fetchMock).toHaveBeenCalledWith('/api/menu/trigger', expect.objectContaining({ body: JSON.stringify({ sessionId: 'base::new-kit', menuId: 'view/panels/ui', presentation: 'local' }) }));
    MockEventSource.instances[0].onmessage?.({ data: JSON.stringify({ type: 'application-bootstrap', bootstrap: { menu: { tree: [{ type: 'menu', id: 'app/new', label: '新应用功能', children: [] }] } } }) });
    button(shadow, '应用菜单').click();
    expect(button(shadow, '新应用功能').disabled).toBe(true);
  });

  it('supports keyboard opening, nested navigation, Escape and closes the application event stream', async () => {
    await settle();
    const shadow = host.querySelector('.web-menu-root')!.shadowRoot!;
    const top = button(shadow, '视图'); top.focus(); top.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const panels = button(shadow, '面板›'); expect(shadow.activeElement).toBe(panels);
    panels.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(shadow.activeElement).toBe(button(shadow, '界面规范'));
    button(shadow, '界面规范').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(shadow.activeElement).toBe(top); expect(top.getAttribute('aria-expanded')).toBe('false');
    runtime.dispose(); expect(MockEventSource.instances[0].close).toHaveBeenCalled();
  });

  it('handles a blocked popup using the existing Session panel fallback', async () => {
    await settle();
    vi.spyOn(window, 'open').mockReturnValue(null);
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/menu/trigger') return { ok: true, json: async () => ({ result: { disposition: 'open-window-group', panelInstanceId: 'p1', panelName: 'ui-guide.main', windowGroupId: 'w1', carrier: 'window-group', url: '/window' } }) };
      if (url === '/api/panel-instance/fallback') return { ok: true, json: async () => ({ id: 'p1', panelName: 'ui-guide.main', state: 'open' }) };
      return { ok: true, json: async () => ({ menu: { tree: [] } }) };
    });
    const shadow = host.querySelector('.web-menu-root')!.shadowRoot!;
    button(shadow, '视图').click(); button(shadow, '面板›').click(); button(shadow, '界面规范').click(); await settle();
    expect(fetchMock).toHaveBeenCalledWith('/api/panel-instance/fallback', expect.objectContaining({ body: JSON.stringify({ sessionId: 'base::harness', panelInstanceId: 'p1' }) }));
    expect(post).toHaveBeenCalledWith({ type: 'ce-open-panel-floating', payload: { id: 'p1', panelName: 'ui-guide.main', state: 'open' } }, '*');
  });

  it('requests local presentation in a narrow viewport and emits the returned panel locally', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const opened = vi.fn(); host.addEventListener('ce-local-panel-open', opened);
    fetchMock.mockImplementation(async (url: string) => url === '/api/menu/trigger'
      ? { ok: true, json: async () => ({ result: { type: 'local-panel', panelName: 'preview.preview' } }) }
      : { ok: true, json: async () => ({ menu: { tree: [] } }) });
    const popup = vi.spyOn(window, 'open');
    const shadow = host.querySelector('.web-menu-root')!.shadowRoot!;
    button(shadow, '视图').click(); button(shadow, '面板›').click(); button(shadow, '界面规范').click(); await settle();
    expect(fetchMock).toHaveBeenCalledWith('/api/menu/trigger', expect.objectContaining({ body: JSON.stringify({ sessionId: 'base::harness', menuId: 'view/panels/ui', presentation: 'local' }) }));
    expect(opened).toHaveBeenCalledOnce();
    expect(opened.mock.calls[0][0].detail).toEqual({ panelName: 'preview.preview' });
    expect(popup).not.toHaveBeenCalled();
  });

  it('shows a user-visible error when the local panel is unavailable', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    host.addEventListener('ce-local-panel-open', (event) => event.preventDefault());
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ result: { type: 'local-panel', panelName: 'missing.panel' } }) }));
    const shadow = host.querySelector('.web-menu-root')!.shadowRoot!;
    button(shadow, '视图').click(); button(shadow, '面板›').click(); button(shadow, '界面规范').click(); await settle();
    const error = shadow.querySelector<HTMLElement>('.error')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('面板不可用或未注册');
  });

  it.each(['update', 'dispose'] as const)('ignores a pending local result after %s', async (action) => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    let resolveResponse!: (value: unknown) => void;
    fetchMock.mockImplementation((url: string) => url === '/api/menu/trigger'
      ? new Promise((resolve) => { resolveResponse = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ menu: { tree: [] } }) }));
    const opened = vi.fn(); host.addEventListener('ce-local-panel-open', opened);
    const shadow = host.querySelector('.web-menu-root')!.shadowRoot!;
    button(shadow, '视图').click(); button(shadow, '面板›').click(); button(shadow, '界面规范').click();
    if (action === 'update') runtime.update({ ...input }); else runtime.dispose();
    resolveResponse({ ok: true, json: async () => ({ result: { type: 'local-panel', panelName: 'preview.preview' } }) });
    await settle();
    expect(opened).not.toHaveBeenCalled();
  });

  it('parses the optional Web menu mode from the current URL', () => {
    window.history.replaceState({}, '', '/?menuMode=multi'); expect(getMenuModeFromURL()).toBe('multi');
    window.history.replaceState({}, '', '/'); expect(getMenuModeFromURL()).toBe('single');
  });
});
