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
});
