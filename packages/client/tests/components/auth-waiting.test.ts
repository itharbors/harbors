import { describe, expect, it, vi } from 'vitest';
import {
  renderAuthorizationUserPicker,
  renderWaitingForAuthorization,
} from '../../src/components/auth-waiting';

describe('remote authorization login', () => {
  it('shows only existing users and locks every card while one request is pending', async () => {
    const host = mount();
    let release!: () => void;
    const onSelect = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));

    renderAuthorizationUserPicker(host, [
      { userId: 'u1', displayName: '张三' },
      { userId: 'u2', displayName: '李四' },
    ], onSelect, vi.fn());

    expect(host.querySelector('h1')?.textContent).toBe('选择使用者');
    expect(host.textContent).not.toContain('新用户');
    expect(host.querySelectorAll('.remote-auth-user-card')).toHaveLength(2);
    const first = host.querySelector<HTMLButtonElement>('[data-user-id="u1"]')!;
    first.click();
    first.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect([...host.querySelectorAll<HTMLButtonElement>('.remote-auth-user-card')].every((button) => button.disabled)).toBe(true);
    release();
  });

  it('restores selection after a failed request', async () => {
    const host = mount();
    const onSelect = vi.fn().mockRejectedValue(new Error('offline'));
    renderAuthorizationUserPicker(host, [{ userId: 'u1', displayName: '张三' }], onSelect, vi.fn());

    const card = host.querySelector<HTMLButtonElement>('[data-user-id="u1"]')!;
    card.click();
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('申请发送失败'));
    expect(card.disabled).toBe(false);
    expect(document.activeElement).toBe(card);
  });

  it('renders the selected identity on the waiting page', () => {
    const host = mount();
    window.localStorage.setItem('harbors.deviceId', '12345678-abcd-efgh');
    renderWaitingForAuthorization(host, { userId: 'u1', displayName: '张三' });

    expect(host.querySelector('h1')?.textContent).toBe('等待主机授权');
    expect(host.textContent).toContain('张三');
    expect(host.textContent).toContain('12345678…efgh');
    expect(host.textContent).not.toContain('显示名');
  });
});

function mount(): HTMLElement {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  document.body.append(host);
  return host;
}
