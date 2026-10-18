import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PanelModule } from '../../src/framework/panel/index';

describe('PanelModule', () => {
  let panelModule: PanelModule;

  beforeEach(() => {
    panelModule = new PanelModule();
  });

  it('register adds a panel to the registry with directory html entry only', () => {
    panelModule.register('my-plugin.editor', '/path/to/panel.js', { width: 300, minWidth: 200 });
    const info = panelModule.getInfo('my-plugin.editor');
    expect(info.entry).toBe('/api/assets/panel/my-plugin.editor/index.html');
    expect(info.width).toBe(300);
    expect(info.minWidth).toBe(200);
  });

  it('getInfo throws for unregistered panel', () => {
    expect(() => panelModule.getInfo('missing')).toThrow(/not registered/);
  });

  it('list returns all registered panels', () => {
    panelModule.register('a.panel', '/a');
    panelModule.register('b.panel', '/b');
    expect(panelModule.list().map((panel) => panel.name)).toEqual(['a.panel', 'b.panel']);
  });

  it('unregister removes a panel', () => {
    panelModule.register('a.panel', '/a');
    panelModule.unregister('a.panel');
    expect(panelModule.list()).toEqual([]);
  });

  it('preserves existing ownership and copies registration constraints on both boundaries', () => {
    const constraints = { title: 'Original', metadata: { tags: ['original'] } };
    panelModule.register('shared.alias', '/victim', constraints, 'victim');
    constraints.metadata.tags.push('input-mutation');
    const registration = panelModule.getRegistration('shared.alias')!;
    registration.owner = 'attacker';
    registration.module = '/attacker';
    (registration.constraints as typeof constraints).metadata.tags.push('query-mutation');

    expect(() => panelModule.register('shared.alias', '/attacker', {}, 'attacker')).toThrow(/owned by "victim"/);
    expect(panelModule.getRegistration('shared.alias')).toMatchObject({
      owner: 'victim', module: '/victim', constraints: { metadata: { tags: ['original'] } },
    });
    panelModule.clearOwner('attacker');
    expect(panelModule.list()).toHaveLength(1);
    panelModule.clearOwner('victim');
    expect(panelModule.list()).toEqual([]);
  });

  it('emits availability events with monotonically increasing revisions', () => {
    const events: unknown[] = [];
    panelModule.subscribe((event) => events.push(event));

    panelModule.register('owner.first', '/first', { title: 'First' }, 'owner');
    panelModule.register('owner.second', '/second', {}, 'owner');
    panelModule.clearOwner('owner');

    expect(events).toEqual([
      {
        panel: {
          name: 'owner.first',
          entry: '/api/assets/panel/owner.first/index.html',
          title: 'First',
        },
        state: 'available',
        revision: 1,
      },
      {
        panel: {
          name: 'owner.second',
          entry: '/api/assets/panel/owner.second/index.html',
        },
        state: 'available',
        revision: 2,
      },
      {
        panel: {
          name: 'owner.first',
          entry: '/api/assets/panel/owner.first/index.html',
          title: 'First',
        },
        state: 'unavailable',
        revision: 3,
      },
      {
        panel: {
          name: 'owner.second',
          entry: '/api/assets/panel/owner.second/index.html',
        },
        state: 'unavailable',
        revision: 4,
      },
    ]);
  });

  it('does not emit when unregistering a missing panel', () => {
    const listener = vi.fn();
    panelModule.subscribe(listener);

    expect(() => panelModule.unregister('missing')).toThrow(/not registered/);
    expect(listener).not.toHaveBeenCalled();
  });
});
