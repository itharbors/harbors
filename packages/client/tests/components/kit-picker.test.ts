import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchContext } from '@itharbors/plugin-types';
import { renderKitPicker, renderKitPickerError, type KitPickerOptions } from '../../src/components/kit-picker';

const kits = [
  { id: 'default', name: '@itharbors/kit-default', label: 'Default Kit' },
  { id: 'harness', name: '@itharbors/kit-harness', label: 'Harbors Harness' },
];

describe('Kit picker login flow', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/');
    vi.unstubAllGlobals();
  });

  it('keeps the legacy overload on the Kit step', () => {
    const host = mount();
    renderKitPicker(host, kits, 'picker-session');
    expect(host.querySelector('h1')?.textContent).toBe('选择工作台');
    expect(host.querySelector('[data-kit-id="default"]')?.textContent).toContain('Default Kit');
    expect(host.querySelector('.kit-user-grid')).toBeNull();
  });

  it('shows only login-style user buttons on the first local step', () => {
    const host = mount();
    renderKitPicker(host, kits, opts());
    expect(host.querySelector('h1')?.textContent).toBe('选择使用者');
    expect(host.querySelectorAll('.kit-user-avatar')).toHaveLength(2);
    expect(host.querySelector('.kit-user-card')?.tagName).toBe('DIV');
    expect(host.querySelector('.kit-user-card')?.getAttribute('role')).toBe('button');
    expect(host.textContent).toContain('新用户');
    expect(host.querySelector('.kit-session-fieldset')).toBeNull();
    expect(host.querySelector('.kit-list')).toBeNull();
  });

  it('moves user → optional Session → Kit and supports back', () => {
    const host = mount();
    const cleared = vi.fn();
    renderKitPicker(host, kits, opts({ onSessionCleared: cleared }));
    click(host, '.kit-user-card[data-user-id="u1"]');
    expect(host.querySelector('h1')?.textContent).toBe('选择 Session');
    expect(cleared).toHaveBeenCalledOnce();
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    expect(host.querySelector<HTMLInputElement>('input:checked')?.value).toBe('s2');
    expect(host.textContent).toContain('不选择，创建新 Session');
    expect(host.querySelector('.kit-list')).toBeNull();
    click(host, 'input[value="s1"]');
    click(host, '.kit-primary-action');
    expect(host.querySelector('h1')?.textContent).toBe('选择工作台');
    expect(host.querySelector('.kit-back-action')?.textContent).toBe('← 上一步 · 选择 Session');
    click(host, '.kit-back-action');
    expect(host.querySelector('h1')?.textContent).toBe('选择 Session');
    expect(host.querySelector('.kit-back-action')?.textContent).toBe('← 上一步 · 选择用户');
    click(host, '.kit-back-action');
    expect(host.querySelector('h1')?.textContent).toBe('选择使用者');
  });

  it('creates on Session continue, persists, then opens Kit without another POST', async () => {
    const host = mount();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls.push('post');
      return new Response(JSON.stringify({ sessionId: 'new-session', ownerUserId: 'u1', createdAt: 1, lastAccessAt: 1 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderKitPicker(host, kits, opts({
      onSessionSelected: (id) => calls.push(`persist:${id}`),
      navigate: (href) => calls.push(`navigate:${href}`),
    }));
    click(host, '.kit-user-card[data-user-id="u1"]');
    click(host, '.kit-session-clear');
    calls.length = 0;
    click(host, '.kit-primary-action');
    await vi.waitFor(() => expect(calls).toEqual(['post', 'persist:new-session']));
    expect(host.querySelector('h1')?.textContent).toBe('选择工作台');
    expectFeedback(host, 'success', '已创建 Session new-session');
    expect(host.querySelector('.kit-flow-live')?.textContent).toBe('请选择工作台');
    expect(host.querySelector('.kit-picker-eyebrow')?.textContent).toContain('new-session');
    click(host, '[data-kit-id="default"]');
    expect(calls).toEqual(['post', 'persist:new-session', 'navigate:/kits/default?session=new-session']);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ userId: 'u1' });
    click(host, '.kit-back-action');
    expect(host.querySelector<HTMLInputElement>('input[value="new-session"]')?.checked).toBe(true);
  });

  it('reuses an existing Session without POST and permits clearing it', () => {
    const host = mount();
    const fetchMock = vi.fn();
    const selected = vi.fn();
    const navigate = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderKitPicker(host, kits, opts({ onSessionSelected: selected, navigate }));
    click(host, '.kit-user-card[data-user-id="u1"]');
    click(host, 'input[value="s1"]');
    click(host, '.kit-primary-action');
    click(host, '[data-kit-id="harness"]');
    expect(selected).toHaveBeenCalledWith('s1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/kits/harness?session=s1');
    click(host, '.kit-back-action');
    click(host, '.kit-session-clear');
    expect(host.querySelector('input:checked')).toBeNull();
  });

  it('confirms Session deletion in place and clears a deleted selection', async () => {
    const host = mount();
    const cleared = vi.fn();
    let complete!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { complete = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    renderKitPicker(host, kits, opts({ onSessionCleared: cleared }));
    click(host, '.kit-user-card[data-user-id="u1"]');
    click(host, 'input[value="s1"]');

    expect(host.querySelectorAll('.kit-session-entry')).toHaveLength(2);
    click(host, '.kit-session-entry:has(input[value="s1"]) .kit-session-delete');
    expect(host.querySelector('.kit-session-delete-confirm')?.getAttribute('aria-label')).toBe('确认删除 Session s1');
    click(host, '.kit-session-delete-cancel');
    expect(host.querySelector('.kit-session-delete-confirm')).toBeNull();

    click(host, '.kit-session-entry:has(input[value="s1"]) .kit-session-delete');
    click(host, '.kit-session-delete-confirm');
    expect(host.querySelector('.kit-session-delete-warning')?.textContent).toContain('永久删除状态');
    expect(host.querySelector('.kit-flow-section')?.getAttribute('aria-busy')).toBe('true');
    expect([...host.querySelectorAll<HTMLButtonElement | HTMLInputElement>('.kit-flow-section button, .kit-flow-section input')]
      .every((control) => control.disabled)).toBe(true);
    click(host, '.kit-primary-action');
    expect(fetchMock).toHaveBeenCalledOnce();
    complete(new Response(null, { status: 204 }));
    await vi.waitFor(() => expect(host.querySelectorAll('.kit-session-entry')).toHaveLength(1));
    expectFeedback(host, 'success', '已删除 Session s1');
    expect(host.querySelector('.kit-flow-live')?.textContent).not.toContain('正在删除');
    expect(fetchMock).toHaveBeenCalledWith('/api/session/s1', { method: 'DELETE' });
    expect(cleared).toHaveBeenCalledTimes(2);
    expect(host.querySelector('input[value="s1"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('input:checked')?.value).toBe('s2');
  });

  it('keeps a Session selected when deletion fails', async () => {
    const host = mount();
    const cleared = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    renderKitPicker(host, kits, opts({ onSessionCleared: cleared }));
    click(host, '.kit-user-card[data-user-id="u1"]');
    click(host, 'input[value="s1"]');
    click(host, '.kit-session-entry:has(input[value="s1"]) .kit-session-delete');
    click(host, '.kit-session-delete-confirm');

    await vi.waitFor(() => expectFeedback(host, 'error', '未能删除 Session s1，请重试。'));
    expect(document.activeElement).toBe(host.querySelector('.kit-session-entry:has(input[value="s1"]) .kit-session-delete'));
    expect(host.querySelector('.kit-session-action-error')).toBeNull();
    expect(host.querySelector('.kit-flow-live')?.textContent).toBe('');
    expect(host.querySelector<HTMLInputElement>('input[value="s1"]')?.checked).toBe(true);
    expect(host.querySelectorAll('.kit-session-entry')).toHaveLength(2);
    expect(cleared).toHaveBeenCalledOnce();
  });

  it('preserves an explicit new-Session choice when deleting an unselected Session', async () => {
    const host = mount();
    const selected = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    renderKitPicker(host, kits, opts({ onSessionSelected: selected }));
    click(host, '.kit-user-card[data-user-id="u1"]');
    expect(selected).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenLastCalledWith('s2');
    click(host, '.kit-session-clear');
    click(host, '.kit-session-entry:has(input[value="s1"]) .kit-session-delete');
    click(host, '.kit-session-delete-confirm');

    await vi.waitFor(() => expect(host.querySelector('input[value="s1"]')).toBeNull());
    expect(host.querySelector('input:checked')).toBeNull();
    expect(selected).toHaveBeenCalledOnce();
    expect(host.querySelector('.kit-flow-live')?.textContent).toBe('');
  });

  it('clears deletion progress after removing the last Session', async () => {
    const context = baseContext();
    context.sessions = context.sessions.filter((session) => session.sessionId === 's1' || session.ownerUserId === 'u2');
    const host = mount();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    renderKitPicker(host, kits, opts({ context }));
    click(host, '.kit-user-card[data-user-id="u1"]');
    click(host, '.kit-session-delete');
    click(host, '.kit-session-delete-confirm');

    await vi.waitFor(() => expect(host.querySelector('.kit-session-entry')).toBeNull());
    expectFeedback(host, 'success', '已删除 Session s1');
    expect(host.querySelector('.kit-flow-live')?.textContent).toBe('');
  });

  it('shares a creation lock and recovers after a failure', async () => {
    const host = mount();
    let complete!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { complete = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    renderKitPicker(host, kits, opts({ navigate: vi.fn() }));
    click(host, '.kit-user-card[data-user-id="u1"]');
    click(host, '.kit-session-clear');
    click(host, '.kit-primary-action');
    click(host, '.kit-primary-action');
    click(host, 'input[value="s1"]');
    click(host, '.kit-session-clear');
    click(host, '.kit-back-action');
    click(host, '.kit-secondary-action');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(host.querySelector('.kit-flow-section')?.getAttribute('aria-busy')).toBe('true');
    expect([...host.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('.kit-flow-section button, .kit-flow-section input, .kit-flow-section select')]
      .every((control) => control.disabled)).toBe(true);
    expect(host.querySelector('h1')?.textContent).toBe('选择 Session');
    expect(host.querySelector('input:checked')).toBeNull();
    complete(new Response('{}', { status: 500 }));
    await vi.waitFor(() => expectFeedback(host, 'error', '未能创建 Session，请检查连接后重试。'));
    expect(host.querySelector('h1')?.textContent).toBe('选择 Session');
    expect(host.querySelector('.kit-flow-section')?.getAttribute('aria-busy')).toBe('false');
    expect(host.querySelector<HTMLButtonElement>('.kit-primary-action')?.disabled).toBe(false);
    expect(document.activeElement).toBe(host.querySelector('.kit-primary-action'));
    expect(host.querySelector('.kit-creation-error')).toBeNull();
    expect(host.querySelector('.kit-flow-live')?.textContent).toBe('');
  });

  it('lets an explicit resume state override an URL-restored Session and focuses its title after mounting', async () => {
    const first = mount();
    renderKitPicker(first, kits, opts({ selectedSessionId: 's1' }));
    expect(first.querySelector('h1')?.textContent).toBe('选择工作台');
    first.remove();
    const resumed = mount();
    renderKitPicker(resumed, kits, opts({
      selectedSessionId: 's1',
      resumeState: { step: 'session', selectedUserId: 'u1', selectedSessionId: 's1' },
    }));
    expect(resumed.querySelector('h1')?.textContent).toBe('选择 Session');
    expect(resumed.querySelector<HTMLInputElement>('input[value="s1"]')?.checked).toBe(true);
    await vi.waitFor(() => expect(document.activeElement).toBe(resumed.querySelector('h1')));

    const createNew = mount();
    const selected = vi.fn();
    renderKitPicker(createNew, kits, opts({
      onSessionSelected: selected,
      resumeState: { step: 'session', selectedUserId: 'u1', selectedSessionId: null, createNewSession: true },
    }));
    expect(createNew.querySelector('input:checked')).toBeNull();
    expect(selected).not.toHaveBeenCalled();
  });

  it('fixes remote actors to currentUser and blocks a missing identity', () => {
    const context = baseContext();
    context.actor = 'user';
    context.currentUser = context.users[1];
    const host = mount();
    const selected = vi.fn();
    renderKitPicker(host, kits, opts({ context, onSessionSelected: selected }));
    expect(host.querySelector('h1')?.textContent).toBe('选择 Session');
    expect(host.textContent).toContain('李四');
    expect(host.querySelector<HTMLInputElement>('input:checked')?.value).toBe('s3');
    expect(selected).toHaveBeenCalledWith('s3');
    expect(host.querySelector('.kit-back-action')).toBeNull();
    expect(host.querySelectorAll('.kit-tab')).toHaveLength(1);
    const broken = mount();
    renderKitPicker(broken, kits, opts({ context: { ...context, currentUser: null } }));
    expect(broken.querySelector('[role="alert"]')?.textContent).toContain('身份不可用');
    expect(broken.querySelector('.kit-list')).toBeNull();
  });

  it('approves a requested remote identity without offering a user override', async () => {
    const host = mount();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/auth/pending') return json({ pending: [{
        deviceId: 'remote-device', ip: '203.0.113.9', userAgent: 'Browser', requestedAt: 1,
        displayName: '', requestedUserId: 'u1',
      }] });
      if (url === '/api/auth/authorized') return json({ authorized: [] });
      if (url === '/api/workbench/context') return json(baseContext());
      if (url === '/api/auth/approve/remote-device') {
        expect(init).toMatchObject({ method: 'POST', body: '{}' });
        return json({ userId: 'u1' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderKitPicker(host, kits, opts());
    click(host, '.kit-tab:nth-child(2)');

    await vi.waitFor(() => expect(host.querySelector('.auth-device-item')?.textContent).toContain('申请用户: 张三'));
    expect(host.querySelector('.auth-user-select')).toBeNull();
    click(host, '.auth-btn-approve');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/approve/remote-device', expect.objectContaining({ body: '{}' })));
  });

  it('resumes after creating a user and claiming an ownerless Session', async () => {
    const createHost = mount();
    const createChanged = vi.fn();
    const createFetch = vi.fn(async () => new Response(JSON.stringify({ userId: 'u3' }), { status: 200 }));
    vi.stubGlobal('fetch', createFetch);
    renderKitPicker(createHost, kits, opts({ onContextChanged: createChanged }));
    const createCard = createHost.querySelector<HTMLElement>('.kit-user-create')!;
    click(createHost, '.kit-user-create');
    expect(createHost.querySelector<HTMLDivElement>('.kit-user-grid')?.hidden).toBe(false);
    expect(createHost.querySelector('.kit-user-editor')?.parentElement).toBe(createHost.querySelector('.kit-user-grid'));
    expect(createHost.querySelectorAll('.kit-user-card[data-user-id]')).toHaveLength(2);
    const createInput = createHost.querySelector<HTMLInputElement>('.kit-user-editor-input')!;
    expect(createInput.closest('.kit-user-card')).toBe(createCard);
    expect(createCard.getAttribute('role')).toBeNull();
    createInput.value = '新用户';
    createInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(createChanged).toHaveBeenCalledWith({
      step: 'session',
      selectedUserId: 'u3',
      selectedSessionId: null,
      feedback: { kind: 'success', message: '已创建用户“新用户”' },
    }));
    expect(createHost.querySelector('.kit-flow-live')?.textContent).toBe('');
    expect(createFetch).toHaveBeenCalledWith('/api/workbench/user', expect.objectContaining({ method: 'POST', body: JSON.stringify({ displayName: '新用户' }) }));
    const refreshedContext = baseContext();
    refreshedContext.users.push({ userId: 'u3', displayName: '新用户', createdAt: 2, updatedAt: 2 });
    renderKitPicker(createHost, kits, opts({ context: refreshedContext, resumeState: createChanged.mock.calls[0][0] }));
    expect(createHost.querySelector('h1')?.textContent).toBe('选择 Session');
    expectFeedback(createHost, 'success', '已创建用户“新用户”');

    const claimHost = mount();
    const claimCalls: string[] = [];
    window.localStorage.setItem('harbors.sessionId', 's1');
    window.history.replaceState({}, '', '/?session=s1');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderKitPicker(claimHost, kits, opts({
      onSessionSelected: (sessionId) => {
        claimCalls.push(`persist:${sessionId}`);
        window.localStorage.setItem('harbors.sessionId', sessionId);
        window.history.replaceState({}, '', `/?session=${sessionId}`);
      },
      onContextChanged: (state) => claimCalls.push(`reload:${state?.selectedSessionId}`),
    }));
    click(claimHost, '.kit-user-card[data-user-id="u1"]');
    claimHost.querySelector<HTMLSelectElement>('.workbench-ownerless-select')!.value = 'legacy-two';
    click(claimHost, '.kit-secondary-action');
    await vi.waitFor(() => expect(claimCalls).toEqual(['persist:s2', 'persist:legacy-two', 'reload:legacy-two']));
    expect(window.location.search).toBe('?session=legacy-two');
    expect(window.localStorage.getItem('harbors.sessionId')).toBe('legacy-two');
  });

  it('edits user names inline without relying on browser prompts', async () => {
    const host = mount();
    const changed = vi.fn();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderKitPicker(host, kits, opts({ onContextChanged: changed }));

    click(host, '.kit-user-rename');
    const firstInput = host.querySelector<HTMLInputElement>('.kit-user-editor-input')!;
    expect(firstInput.value).toBe('张三');
    firstInput.value = '未保存的名称';
    firstInput.dispatchEvent(new FocusEvent('blur'));
    expect(host.querySelector('.kit-user-editor')).toBeNull();
    expect(host.textContent).toContain('张三');
    expect(fetchMock).not.toHaveBeenCalled();

    click(host, '.kit-user-rename');
    const escapeInput = host.querySelector<HTMLInputElement>('.kit-user-editor-input')!;
    escapeInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(host.querySelector('.kit-user-editor')).toBeNull();
    expect(host.querySelectorAll('.kit-user-card[data-user-id]')).toHaveLength(2);

    click(host, '.kit-user-rename');
    const input = host.querySelector<HTMLInputElement>('.kit-user-editor-input')!;
    input.value = '新的张三';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith({
      step: 'user',
      selectedUserId: null,
      selectedSessionId: null,
      feedback: { kind: 'success', message: '已将用户重命名为“新的张三”' },
    }));
    expect(host.querySelector('.kit-flow-live')?.textContent).toBe('');
    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/user/u1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ displayName: '新的张三' }) }));
  });

  it('reveals compact user actions and confirms deletion in place', async () => {
    const host = mount();
    const changed = vi.fn();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    renderKitPicker(host, kits, opts({ onContextChanged: changed }));

    expect(host.querySelectorAll('.kit-user-actions')).toHaveLength(2);
    expect(host.querySelectorAll('.kit-user-action')).toHaveLength(4);
    click(host, '.kit-user-delete');
    expect(host.querySelector('.kit-user-delete-confirm')?.textContent).toBe('删除');
    expect(host.querySelector('.kit-user-delete-confirm')?.getAttribute('aria-label')).toBe('确认删除 张三');
    expect(host.querySelector('.kit-user-delete-cancel')?.getAttribute('aria-label')).toBe('取消删除 张三');
    click(host, '.kit-user-delete-cancel');
    expect(host.querySelectorAll('.kit-user-delete-confirm')).toHaveLength(0);

    click(host, '.kit-user-delete');
    click(host, '.kit-user-delete-confirm');
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith({
      step: 'user',
      selectedUserId: null,
      selectedSessionId: null,
      feedback: { kind: 'success', message: '已删除用户“张三”' },
    }));
    expect(host.querySelector('.kit-flow-live')?.textContent).toBe('');
    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/user/u1', { method: 'DELETE' });
  });

  it('keeps an in-use user and explains the deletion recovery path in a Tip', async () => {
    const host = mount();
    const changed = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 409 })));
    renderKitPicker(host, kits, opts({ onContextChanged: changed }));

    click(host, '.kit-user-delete');
    click(host, '.kit-user-delete-confirm');
    await vi.waitFor(() => expectFeedback(
      host,
      'error',
      '无法删除“张三”：该用户仍有关联 Session、授权设备或待授权请求。请先删除 Session，并在“授权管理”撤销或拒绝关联设备。',
    ));
    expect(host.querySelectorAll('.kit-user-card[data-user-id]')).toHaveLength(2);
    expect(host.querySelector('.kit-user-rename')).not.toBeNull();
    expect(host.querySelector('.kit-user-action-error')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('.kit-user-delete'));
    expect(host.querySelector('.kit-flow-live')?.textContent).toBe('');
    expect(changed).not.toHaveBeenCalled();
  });

  it('keeps failed user edits inline while presenting their result as an accessible Tip', async () => {
    const createHost = mount();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    renderKitPicker(createHost, kits, opts());
    click(createHost, '.kit-user-create');
    const createInput = createHost.querySelector<HTMLInputElement>('.kit-user-editor-input')!;
    createInput.value = '保留的名称';
    createInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expectFeedback(createHost, 'error', '未能创建用户，请检查连接后重试。'));
    expect(createHost.querySelector<HTMLInputElement>('.kit-user-editor-input')?.value).toBe('保留的名称');
    expect(document.activeElement).toBe(createInput);
    expect(createHost.querySelector('.kit-flow-live')?.textContent).toBe('');

    createHost.remove();
    const renameHost = mount();
    renderKitPicker(renameHost, kits, opts());
    click(renameHost, '.kit-user-rename');
    const renameInput = renameHost.querySelector<HTMLInputElement>('.kit-user-editor-input')!;
    renameInput.value = '未保存的新名称';
    renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expectFeedback(renameHost, 'error', '未能保存用户名称，请检查连接后重试。'));
    expect(renameHost.querySelector<HTMLInputElement>('.kit-user-editor-input')?.value).toBe('未保存的新名称');
    expect(document.activeElement).toBe(renameInput);
    expect(renameHost.querySelector('.kit-flow-live')?.textContent).toBe('');
  });

  it('uses a generic user deletion Tip for non-conflict failures', async () => {
    const host = mount();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    renderKitPicker(host, kits, opts());

    click(host, '.kit-user-delete');
    click(host, '.kit-user-delete-confirm');
    await vi.waitFor(() => expectFeedback(host, 'error', '未能删除用户“张三”，请重试。'));
    expect(document.activeElement).toBe(host.querySelector('.kit-user-delete'));
    expect(host.querySelector('.kit-flow-live')?.textContent).toBe('');
  });

  it('replaces Tips and separates visible duration from final removal', async () => {
    vi.useFakeTimers();
    const successHost = mount();
    renderKitPicker(successHost, kits, opts({
      resumeState: {
        step: 'user', selectedUserId: null, selectedSessionId: null,
        feedback: { kind: 'success', message: '已完成操作' },
      },
    }));
    expectFeedback(successHost, 'success', '已完成操作');
    vi.advanceTimersByTime(3_999);
    expect(successHost.querySelector('.kit-feedback-leaving')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(successHost.querySelector('.kit-feedback-tip')?.classList).toContain('kit-feedback-leaving');
    vi.advanceTimersByTime(199);
    expect(successHost.querySelector('.kit-feedback-tip')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(successHost.querySelector('.kit-feedback-tip')).toBeNull();

    successHost.remove();
    const errorHost = mount();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    renderKitPicker(errorHost, kits, opts());
    click(errorHost, '.kit-user-delete');
    click(errorHost, '.kit-user-delete-confirm');
    await Promise.resolve();
    await Promise.resolve();
    expectFeedback(errorHost, 'error', '未能删除用户“张三”，请重试。');
    vi.advanceTimersByTime(4_000);

    click(errorHost, '.kit-user-choice:nth-child(2) .kit-user-delete');
    click(errorHost, '.kit-user-choice:nth-child(2) .kit-user-delete-confirm');
    await Promise.resolve();
    await Promise.resolve();
    expect(errorHost.querySelectorAll('.kit-feedback-tip')).toHaveLength(1);
    expectFeedback(errorHost, 'error', '未能删除用户“李四”，请重试。');
    vi.advanceTimersByTime(4_000);
    expect(errorHost.querySelector('.kit-feedback-leaving')).toBeNull();
    vi.advanceTimersByTime(4_000);
    expect(errorHost.querySelector('.kit-feedback-tip')?.classList).toContain('kit-feedback-leaving');
    vi.advanceTimersByTime(199);
    expect(errorHost.querySelector('.kit-feedback-tip')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(errorHost.querySelector('.kit-feedback-tip')).toBeNull();
  });

  it('removes reduced-motion Tips deterministically and never intercepts workbench actions', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const host = mount();
    renderKitPicker(host, kits, opts({
      resumeState: {
        step: 'user', selectedUserId: null, selectedSessionId: null,
        feedback: { kind: 'success', message: '已完成操作' },
      },
    }));

    expect(host.querySelector('.kit-feedback-region')?.parentElement).toBe(host.querySelector('.kit-picker-body'));
    expect(host.querySelector('.kit-feedback-region')?.nextElementSibling).toBe(host.querySelector('.kit-flow-live'));
    click(host, '.kit-user-card[data-user-id="u1"]');
    expect(host.querySelector('h1')?.textContent).toBe('选择 Session');
    expectFeedback(host, 'success', '已完成操作');
    vi.advanceTimersByTime(4_000);
    expect(host.querySelector('.kit-feedback-tip')).toBeNull();
  });

  it('uses floating feedback and approved responsive/a11y tokens', () => {
    const host = mount();
    renderKitPickerError(host, vi.fn());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('无法打开工作台入口');
    const css = fs.readFileSync(path.resolve('src/styles/kit-picker.css'), 'utf8');
    expect(css).toContain('#111722');
    expect(css).toContain('#182231');
    expect(css).toContain('#5b8def');
    expect(css).toContain('#a9c7f7');
    expect(css).toMatch(/\.kit-masthead\s*{[^}]*padding:\s*18px 0;/s);
    expect(css).toMatch(/\.kit-user-card:focus-visible/);
    expect(css).toMatch(/\.kit-user-card:hover\s*{[^}]*background:\s*transparent;/s);
    expect(css).toMatch(/\.kit-user-choice:hover \.kit-user-actions/);
    expect(css).toMatch(/\.kit-user-choice:focus-within \.kit-user-actions/);
    expect(css).toMatch(/\.kit-user-action\s*{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/s);
    expect(css).toMatch(/\.kit-flow-step-kit \.kit-step-nav,[^}]*\.kit-flow-step-kit \.kit-berth\s*{[^}]*width:\s*min\(860px, 100%\);/s);
    expect(css).toMatch(/\.kit-session-entry:hover \.kit-session-actions/);
    expect(css).toMatch(/\.kit-session-entry:focus-within \.kit-session-actions/);
    expect(css).toMatch(/\.kit-session-action\s*{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/s);
    expect(css).toMatch(/\.kit-user-editor-input:focus\s*{[^}]*outline:\s*none;/s);
    expect(css).toMatch(/\.kit-user-editor-input:focus-visible\s*{[^}]*border-bottom-color:[^}]*outline:\s*none;/s);
    expect(css).toMatch(/\.kit-picker-intro h1:focus\s*{[^}]*outline:\s*none;/s);
    expect(css).toMatch(/\.kit-feedback-region\s*{[^}]*position:\s*fixed;[^}]*pointer-events:\s*none;/s);
    expect(css).toMatch(/\.kit-feedback-tip\s*{[^}]*width:\s*min\(420px, 100%\);[^}]*pointer-events:\s*none;/s);
    expect(css).toContain('env(safe-area-inset-top)');
    expect(css).toContain('env(safe-area-inset-left)');
    expect(css).toContain('env(safe-area-inset-right)');
    expect(css).toMatch(/\.kit-feedback-message\s*{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(css).not.toMatch(/\.kit-user-action-error\s*{/);
    expect(css).not.toMatch(/\.kit-session-action-error\s*{/);
    expect(css).toContain('env(safe-area-inset-bottom)');
    expect(css).toMatch(/grid-template-columns:\s*repeat\(2/);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toMatch(/\.kit-flow-stage\s*{[^}]*animation:\s*none;/s);
    expect(css).toMatch(/\.kit-feedback-tip,[^}]*\.kit-feedback-leaving\s*{[^}]*animation:\s*none;[^}]*transform:\s*none;/s);
    const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
    expect(html).toMatch(/#app\s*{[^}]*overflow:\s*clip;/s);
  });
});

function baseContext(): WorkbenchContext {
  return {
    actor: 'local-admin', currentUser: null,
    users: [
      { userId: 'u1', displayName: '张三', createdAt: 1, updatedAt: 1 },
      { userId: 'u2', displayName: '李四', createdAt: 1, updatedAt: 1 },
    ],
    sessions: [
      { sessionId: 's1', ownerUserId: 'u1', createdAt: 1, lastAccessAt: 3 },
      { sessionId: 's2', ownerUserId: 'u1', createdAt: 2, lastAccessAt: 4 },
      { sessionId: 's3', ownerUserId: 'u2', createdAt: 3, lastAccessAt: 5 },
    ],
    ownerlessSessions: [
      { sessionId: 'legacy-one', ownerUserId: null, createdAt: 1, lastAccessAt: 1 },
      { sessionId: 'legacy-two', ownerUserId: null, createdAt: 2, lastAccessAt: 2 },
    ],
  };
}

function opts(overrides: Partial<KitPickerOptions> = {}): KitPickerOptions {
  return { context: baseContext(), selectedSessionId: null, onSessionSelected: vi.fn(), onSessionCleared: vi.fn(), onContextChanged: vi.fn(), ...overrides };
}

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  return host;
}

function click(host: HTMLElement, selector: string): void {
  const target = host.querySelector<HTMLElement>(selector);
  if (!target) throw new Error(`Missing target: ${selector}`);
  target.click();
}

function expectFeedback(host: HTMLElement, kind: 'success' | 'error', message: string): void {
  const feedback = host.querySelector<HTMLElement>('.kit-feedback-tip');
  expect(feedback?.textContent).toContain(message);
  expect(feedback?.getAttribute('role')).toBe(kind === 'success' ? 'status' : 'alert');
  expect(feedback?.getAttribute('aria-live')).toBe(kind === 'success' ? 'polite' : 'assertive');
  expect(feedback?.getAttribute('aria-atomic')).toBe('true');
  expect(feedback?.getAttribute('tabindex')).toBeNull();
  expect(feedback?.querySelector('.kit-feedback-mark')?.getAttribute('aria-hidden')).toBe('true');
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
