import { describe, expect, it, vi } from 'vitest';
import { MenuModule } from '../../src/framework/menu/index';

describe('menu ownership', () => {
  it('does not ship a framework-owned default menu', () => {
    const menu = new MenuModule();
    expect(menu.getState()).toEqual({ tree: [], warnings: [] });
  });

  it('keeps public menu tree free of pluginName/message metadata and exposes role', () => {
    const menu = new MenuModule();
    menu.attach('menu', {
      menu: [
        { type: 'menu', id: 'edit', label: 'Edit' },
        { type: 'menu', id: 'edit/undo', label: 'Undo', role: 'undo' },
      ],
    });

    expect(menu.getState().tree).toEqual([
      {
        type: 'menu',
        id: 'edit',
        label: 'Edit',
        children: [
          {
            type: 'menu',
            id: 'edit/undo',
            label: 'Undo',
            role: 'undo',
            children: [],
          },
        ],
      },
    ]);
  });

  it('triggers message-backed items through the internal action registry', async () => {
    const menu = new MenuModule();
    const request = vi.fn().mockResolvedValue({ ok: true });
    menu.attach('menu', {
      menu: [
        { type: 'menu', id: 'file', label: 'File' },
        { type: 'menu', id: 'file/new', label: 'New', message: 'newSession' },
      ],
    });

    await menu.trigger('file/new', { request, triggerRole: vi.fn() });

    expect(request).toHaveBeenCalledWith('menu', 'newSession');
  });

  it('uses an owner-scoped local message only when explicitly requested and declared', async () => {
    const menu = new MenuModule();
    const request = vi.fn(async (owner: string, name: string) => ({ owner, name }));
    const resolveLocalPanel = vi.fn((owner: string, value: unknown) => ({ owner, value }));
    const runtime = { request, resolveLocalPanel, triggerRole: vi.fn() };
    menu.attach('alpha', { menu: [
      { type: 'menu', id: 'view', label: 'View' },
      { type: 'menu', id: 'view/local', label: 'Local', message: 'open', localMessage: 'getLocal' },
      { type: 'menu', id: 'view/legacy', label: 'Legacy', message: 'openLegacy' },
    ] });

    expect(JSON.stringify(menu.getState())).not.toContain('localMessage');
    await expect(menu.trigger('view/local', runtime)).resolves.toEqual({ owner: 'alpha', name: 'open' });
    await expect(menu.trigger('view/local', runtime, 'local')).resolves.toEqual({ owner: 'alpha', value: { owner: 'alpha', name: 'getLocal' } });
    await expect(menu.trigger('view/legacy', runtime, 'local')).resolves.toEqual({ owner: 'alpha', name: 'openLegacy' });
    expect(request.mock.calls).toEqual([['alpha', 'open'], ['alpha', 'getLocal'], ['alpha', 'openLegacy']]);
    expect(resolveLocalPanel).toHaveBeenCalledOnce();
  });

  it('fails closed for malformed declarations, rejected requests, and actions replaced while awaiting', async () => {
    const menu = new MenuModule();
    const resolveLocalPanel = vi.fn((owner: string, value: unknown) => ({ owner, value }));
    const request = vi.fn(async () => { throw new Error('local request failed'); });
    menu.attach('alpha', { menu: [{ type: 'menu', id: 'bad', message: 'open', localMessage: 7 }] });
    await expect(menu.trigger('bad', { request, resolveLocalPanel, triggerRole: vi.fn() }, 'local')).rejects.toThrow('Invalid local menu action');
    expect(request).not.toHaveBeenCalled();

    menu.attach('alpha', { menu: [{ type: 'menu', id: 'view', message: 'open', localMessage: 'getLocal' }] });
    await expect(menu.trigger('view', { request, resolveLocalPanel, triggerRole: vi.fn() }, 'local')).rejects.toThrow('local request failed');
    let resolve!: (value: unknown) => void;
    const waiting = vi.fn(() => new Promise<unknown>((done) => { resolve = done; }));
    const pending = menu.trigger('view', { request: waiting, resolveLocalPanel, triggerRole: vi.fn() }, 'local');
    menu.detach('alpha');
    menu.attach('beta', { menu: [{ type: 'menu', id: 'view', message: 'other', localMessage: 'otherLocal' }] });
    resolve({ type: 'local-panel', panelName: 'beta.main' });
    await expect(pending).rejects.toThrow('Menu action changed');
    expect(resolveLocalPanel).not.toHaveBeenCalled();
  });

  it('does not accept an unvalidated local-panel result from a desktop or undeclared action', async () => {
    const menu = new MenuModule();
    menu.attach('alpha', { menu: [{ type: 'menu', id: 'view', message: 'open' }] });
    const request = vi.fn(async () => ({ type: 'local-panel', panelName: 'beta.viewer' }));
    const resolveLocalPanel = vi.fn();
    const runtime = { request, resolveLocalPanel, triggerRole: vi.fn() };
    await expect(menu.trigger('view', runtime)).rejects.toThrow('requires a declared local menu action');
    await expect(menu.trigger('view', runtime, 'local')).rejects.toThrow('requires a declared local menu action');
    expect(resolveLocalPanel).not.toHaveBeenCalled();
  });
});
