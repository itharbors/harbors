import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  renderKitPicker,
  renderKitPickerError,
  renderKitPickerLoading,
} from '../../src/components/kit-picker';

describe('Kit picker', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders stable, semantic Kit links without leaking local paths', () => {
    const host = mountHost();

    renderKitPicker(host, [
      { id: 'mysql', name: '@itharbors/kit-mysql', label: 'MySQL' },
      { id: 'sqlite', name: '@itharbors/kit-sqlite', label: 'SQLite' },
    ], 'picker-session');

    expect(host.querySelector('main')?.getAttribute('aria-labelledby')).toBe('kit-picker-title');
    expect(host.querySelector('h1')?.textContent).toBe('选择工作台');
    expect(host.textContent).toContain('多 Kit 主机');
    expect(host.querySelector('[role="list"]')).not.toBeNull();
    const mysql = host.querySelector<HTMLAnchorElement>('[data-kit-id="mysql"]');
    expect(mysql?.getAttribute('href')).toBe('/kits/mysql?session=picker-session');
    expect(mysql?.textContent).toContain('MySQL');
    expect(mysql?.textContent).toContain('@itharbors/kit-mysql');
    expect(mysql?.textContent).toContain('打开工作台');
    expect(mysql?.querySelector('.kit-package')?.getAttribute('translate')).toBe('no');
    expect(mysql?.querySelector('.kit-route')?.getAttribute('translate')).toBe('no');
    expect(mysql?.querySelector('.kit-open-arrow')?.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('[data-kit-id="sqlite"]')?.getAttribute('href')).toBe('/kits/sqlite?session=picker-session');
    expect(host.textContent).not.toContain('/private');
  });

  it('renders a directional empty state without creating links', () => {
    const host = mountHost();

    renderKitPicker(host, [], 'picker-session');

    expect(host.textContent).toContain('没有可用的 Kit');
    expect(host.textContent).toContain('检查 kits 目录中的 package.json');
    expect(host.querySelector('a')).toBeNull();
  });

  it('renders loading and retryable failure states', () => {
    const host = mountHost();
    const retry = vi.fn();

    renderKitPickerLoading(host);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('正在读取 Kit');
    expect(host.querySelector('.kit-host-spinner')?.getAttribute('aria-hidden')).toBe('true');

    renderKitPickerError(host, retry);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('无法读取 Kit 列表');
    (host.querySelector('button') as HTMLButtonElement).click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('keeps Kit links disabled until an owned Session is selected', () => {
    const host = mountHost();
    const selected = vi.fn();
    renderKitPicker(host, [{ id: 'default', name: 'default', label: 'Default' }], {
      context: {
        actor: 'user',
        currentUser: { userId: 'u1', displayName: '张三', createdAt: 1, updatedAt: 1 },
        users: [{ userId: 'u1', displayName: '张三', createdAt: 1, updatedAt: 1 }],
        sessions: [{ sessionId: 's1', ownerUserId: 'u1', createdAt: 1, lastAccessAt: 2 }],
        ownerlessSessions: [],
      },
      selectedSessionId: null,
      onSessionSelected: selected,
      onSessionCleared: vi.fn(),
      onContextChanged: vi.fn(),
    });

    const link = host.querySelector<HTMLAnchorElement>('[data-kit-id="default"]')!;
    expect(link.getAttribute('aria-disabled')).toBe('true');
    const session = host.querySelector<HTMLSelectElement>('.workbench-context-field:nth-child(2) select')!;
    session.value = 's1';
    session.dispatchEvent(new Event('change'));
    expect(link.getAttribute('href')).toBe('/kits/default?session=s1');
    expect(selected).toHaveBeenCalledWith('s1');
    expect(host.textContent).toContain('张三');
  });

  it('clears the old Session through the parent callback when switching users', () => {
    const host = mountHost();
    window.localStorage.setItem('harbors.sessionId', 'old-session');
    window.history.replaceState({}, '', '/?session=old-session');
    const onSessionCleared = vi.fn(() => {
      window.localStorage.removeItem('harbors.sessionId');
      window.history.replaceState({}, '', '/');
    });
    const context = {
      actor: 'local-admin' as const,
      currentUser: null,
      users: [
        { userId: 'u1', displayName: '甲', createdAt: 1, updatedAt: 1 },
        { userId: 'u2', displayName: '乙', createdAt: 1, updatedAt: 1 },
      ],
      sessions: [{ sessionId: 'old-session', ownerUserId: 'u1', createdAt: 1, lastAccessAt: 2 }],
      ownerlessSessions: [],
    };
    renderKitPicker(host, [{ id: 'default', name: 'default', label: 'Default' }], {
      context, selectedSessionId: 'old-session', onSessionSelected: vi.fn(), onSessionCleared, onContextChanged: vi.fn(),
    });
    const user = host.querySelector<HTMLSelectElement>('.workbench-context-field select')!;
    user.value = 'u2';
    user.dispatchEvent(new Event('change'));
    expect(onSessionCleared).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem('harbors.sessionId')).toBeNull();
    expect(window.location.search).toBe('');

    renderKitPicker(host, [{ id: 'default', name: 'default', label: 'Default' }], {
      context, selectedSessionId: window.localStorage.getItem('harbors.sessionId'), onSessionSelected: vi.fn(), onSessionCleared, onContextChanged: vi.fn(),
    });
    expect(host.querySelector('.kit-link')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('claims the specifically selected ownerless Session', async () => {
    const host = mountHost();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderKitPicker(host, [], {
      context: {
        actor: 'local-admin', currentUser: null,
        users: [{ userId: 'u1', displayName: '甲', createdAt: 1, updatedAt: 1 }], sessions: [],
        ownerlessSessions: [
          { sessionId: 'legacy-one', ownerUserId: null, createdAt: 1, lastAccessAt: 1 },
          { sessionId: 'legacy-two', ownerUserId: null, createdAt: 2, lastAccessAt: 2 },
        ],
      },
      selectedSessionId: null, onSessionSelected: vi.fn(), onSessionCleared: vi.fn(), onContextChanged: vi.fn(),
    });
    const ownerless = host.querySelector<HTMLSelectElement>('.workbench-ownerless-select')!;
    ownerless.value = 'legacy-two';
    (host.querySelector('.workbench-context-action:last-of-type') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/workbench/session/legacy-two/claim');
  });

  it('defines the approved palette, keyboard focus, responsive layout, and reduced motion', () => {
    const css = fs.readFileSync(path.resolve('src/styles/kit-picker.css'), 'utf8');

    expect(css).toContain('#111722');
    expect(css).toContain('#182231');
    expect(css).toContain('#5b8def');
    expect(css).toContain('#a9c7f7');
    expect(css).toMatch(/:root\s*{[^}]*color-scheme:\s*dark;/s);
    expect(css).toMatch(/\.kit-picker-intro h1\s*{[^}]*white-space:\s*nowrap;/s);
    expect(css).toMatch(/\.kit-link:focus-visible/);
    expect(css).toMatch(/\.kit-link\s*{[^}]*touch-action:\s*manipulation;/s);
    expect(css).toMatch(/\.kit-count\s*{[^}]*font-variant-numeric:\s*tabular-nums;/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)/);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});

function mountHost(): HTMLElement {
  const host = document.createElement('div');
  host.id = 'app';
  document.body.append(host);
  return host;
}
