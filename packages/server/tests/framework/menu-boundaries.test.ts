import { describe, expect, it, vi } from 'vitest';
import { MenuModule } from '../../src/framework/menu/index';

describe('Menu query snapshots', () => {
  it('keeps nested trees and warnings independent across all queries and change notifications', async () => {
    const onChange = vi.fn();
    const menu = new MenuModule({ onChange });
    menu.setDefaults('application', [
      { type: 'menu', id: 'app', label: 'Application' },
      { type: 'menu', id: 'app/open', label: 'Open', message: 'open' },
    ]);
    menu.attach('notes', { menu: [
      { type: 'menu', id: 'notes', label: 'Notes' },
      { type: 'menu', id: 'notes/new', label: 'New', message: 'new' },
      { type: 'menu', id: 'missing/invalid', label: 'Invalid', message: 'invalid' },
    ] });

    const expected = menu.getState();
    for (const state of [menu.getState(), menu.getApplicationState(), menu.getKitState(), onChange.mock.calls.at(-1)![0]]) {
      state.tree[0].children[0].label = 'Corrupted';
      state.tree[0].children.splice(0);
      state.warnings.push({ message: 'corrupted' });
    }
    expect(menu.getState()).toEqual(expected);
    expect(menu.getApplicationState().tree).toMatchObject([{ children: [{ label: 'Open' }] }]);
    expect(menu.getKitState().tree).toMatchObject([{ children: [{ label: 'New' }] }]);
    const request = vi.fn(async () => 'created');
    await expect(menu.trigger('notes/new', { request, triggerRole: vi.fn() })).resolves.toBe('created');
    expect(request).toHaveBeenCalledWith('notes', 'new');
  });
});
