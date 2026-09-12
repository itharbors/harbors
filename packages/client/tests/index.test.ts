import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchContext } from '@itharbors/plugin-types';
import { selectEditorSession, selectUrlSession, startClientApp, waitForAuthorization } from '../src/index';

describe('client main entry', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
    vi.unstubAllGlobals();
  });

  it('restores only a valid URL Session and canonicalizes storage', () => {
    window.localStorage.setItem('harbors.sessionId', 'stale');
    window.history.replaceState({}, '', '/?sessionId=s1');
    expect(selectUrlSession(context())).toBe('s1');
    expect(window.location.search).toBe('?session=s1');
    expect(window.localStorage.getItem('harbors.sessionId')).toBe('s1');
  });

  it('clears an invalid URL Session', () => {
    window.localStorage.setItem('harbors.sessionId', 'stale');
    window.history.replaceState({}, '', '/?session=missing');
    expect(selectUrlSession(context())).toBeNull();
    expect(window.location.search).toBe('');
    expect(window.localStorage.getItem('harbors.sessionId')).toBeNull();
  });

  it('does not restore from localStorage without a URL Session', () => {
    window.localStorage.setItem('harbors.sessionId', 's1');
    expect(selectUrlSession(context())).toBeNull();
    expect(window.location.search).toBe('');
    expect(window.localStorage.getItem('harbors.sessionId')).toBeNull();
  });

  it('opens an editor only for a visible URL or cached Session', () => {
    window.localStorage.setItem('harbors.sessionId', 's1');
    window.history.replaceState({}, '', '/?kit=default');
    expect(selectEditorSession(context())).toBe('s1');
    expect(window.location.search).toBe('?kit=default&session=s1');
  });

  it('clears an invalid editor route before returning to the picker', () => {
    window.localStorage.setItem('harbors.sessionId', 'missing');
    window.history.replaceState({}, '', '/kits/default?kit=default&page=main&sessionId=missing');
    expect(selectEditorSession(context())).toBeNull();
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
    expect(window.localStorage.getItem('harbors.sessionId')).toBeNull();
  });

  it('keeps resumeState through a failed reload retry', async () => {
    const host = mount();
    let kitAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/kits') {
        kitAttempts += 1;
        if (kitAttempts === 1) return new Response('{}', { status: 500 });
        return json({ kits: [{ id: 'default', name: 'default', label: 'Default' }] });
      }
      if (url === '/api/workbench/context') return json(context());
      throw new Error(`Unexpected request: ${url}`);
    }));

    await startClientApp({ step: 'session', selectedUserId: 'u1', selectedSessionId: null }, host);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('无法打开工作台入口');
    host.querySelector<HTMLButtonElement>('.kit-retry')!.click();
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('选择 Session'));
    expect(document.activeElement).toBe(host.querySelector('h1'));
  });

  it('clears URL and storage when Session selection is cancelled', async () => {
    const host = mount();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/kits') return json({ kits: [{ id: 'default', name: 'default', label: 'Default' }] });
      if (url === '/api/workbench/context') return json(context());
      throw new Error(`Unexpected request: ${url}`);
    }));

    await startClientApp(undefined, host);
    host.querySelector<HTMLButtonElement>('.kit-user-card[data-user-id="u1"]')!.click();
    host.querySelector<HTMLInputElement>('input[value="s1"]')!.click();
    expect(window.location.search).toBe('?session=s1');
    expect(window.localStorage.getItem('harbors.sessionId')).toBe('s1');
    host.querySelector<HTMLButtonElement>('.kit-session-clear')!.click();
    expect(window.location.search).toBe('');
    expect(window.localStorage.getItem('harbors.sessionId')).toBeNull();
  });

  it('declares the host browser chrome and coarse-landscape safe area', () => {
    const html = fs.readFileSync(path.resolve('index.html'), 'utf-8');
    expect(html).toContain('<meta name="theme-color" content="#111722">');
    expect(html).toContain('--app-viewport-safe-top: 0px;');
    expect(html).toContain('@media (orientation: landscape) and (any-pointer: coarse)');
    expect(html).toContain('max(20px, env(safe-area-inset-top, 0px))');
  });

  it('selects a remote user before requesting access and waits without reading workbench data', async () => {
    const host = mount();
    const user = { userId: 'u1', displayName: '张三' };
    let statusReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/auth/status') {
        statusReads += 1;
        if (statusReads === 1) return json({ status: 'unauthorized' });
        if (statusReads === 2) return json({ status: 'pending', requestedUser: user });
        return json({ status: 'authorized', user });
      }
      if (url === '/api/auth/users') return json({ users: [user] });
      if (url === '/api/auth/request') {
        expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ userId: 'u1' }) });
        return json({ status: 'pending', requestedUser: user }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const authorized = waitForAuthorization(host, 1);
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('选择使用者'));
    host.querySelector<HTMLButtonElement>('[data-user-id="u1"]')!.click();
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('等待主机授权'));
    await expect(authorized).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalledWith('/api/kits', expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith('/api/workbench/context', expect.anything());
  });

  it('gates the complete remote app until approval, then loads only the bound user context', async () => {
    const host = mount();
    const user = { userId: 'u1', displayName: '张三', createdAt: 1, updatedAt: 1 };
    const calls: string[] = [];
    let statusReads = 0;
    let approve!: () => void;
    const approval = new Promise<void>((resolve) => { approve = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === '/api/auth/status') {
        statusReads += 1;
        if (statusReads === 1) return json({ status: 'unauthorized' });
        if (statusReads === 2) return json({ status: 'pending', requestedUser: user });
        await approval;
        return json({ status: 'authorized', user });
      }
      if (url === '/api/auth/users') return json({ users: [user] });
      if (url === '/api/auth/request') return json({ status: 'pending', requestedUser: user }, 201);
      if (url === '/api/kits') return json({ kits: [{ id: 'default', name: 'default', label: 'Default' }] });
      if (url === '/api/workbench/context') return json({
        actor: 'user', currentUser: user, users: [user],
        sessions: [{ sessionId: 's1', ownerUserId: user.userId, createdAt: 1, lastAccessAt: 2 }],
      });
      throw new Error(`Unexpected request: ${url}`);
    }));

    const started = startClientApp(undefined, host, true, 20);
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('选择使用者'));
    expect(calls).toEqual(['/api/auth/status', '/api/auth/users']);
    host.querySelector<HTMLButtonElement>('[data-user-id="u1"]')!.click();
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('等待主机授权'));
    expect(calls).not.toContain('/api/kits');
    expect(calls).not.toContain('/api/workbench/context');
    approve();
    await started;
    expect(calls.slice(-2)).toEqual(['/api/kits', '/api/workbench/context']);
    expect(host.querySelector('h1')?.textContent).toBe('选择 Session');
    expect(host.textContent).toContain('张三');
  });

  it('restores an existing pending request and returns to user selection after rejection', async () => {
    const host = mount();
    const user = { userId: 'u1', displayName: '张三' };
    let statusReads = 0;
    let reject!: () => void;
    const rejection = new Promise<void>((resolve) => { reject = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/status') {
        statusReads += 1;
        if (statusReads === 1) return json({ status: 'pending', requestedUser: user });
        await rejection;
        return json({ status: 'unauthorized' });
      }
      if (url === '/api/auth/users') return json({ users: [user] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    void waitForAuthorization(host, 20);
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('等待主机授权'));
    expect(fetchMock.mock.calls.map(([input]) => String(input)).every((url) => url === '/api/auth/status')).toBe(true);
    reject();
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('选择使用者'));
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain('/api/auth/request');
  });
});

function context(): WorkbenchContext {
  return {
    actor: 'local-admin', currentUser: null,
    users: [{ userId: 'u1', displayName: '张三', createdAt: 1, updatedAt: 1 }],
    sessions: [{ sessionId: 's1', ownerUserId: 'u1', createdAt: 1, lastAccessAt: 2 }],
  };
}

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  return host;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
