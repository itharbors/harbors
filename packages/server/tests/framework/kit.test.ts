import { describe, it, expect, beforeEach } from 'vitest';
import { KitModule, normalizeKitLayoutConfig } from '../../src/framework/kit/index';
import type { KitDescriptor } from '../../src/framework/kit/types';

describe('KitModule', () => {
  let kitModule: KitModule;
  const kit: KitDescriptor = {
    name: 'default-kit',
    label: 'Default',
    plugins: ['p'],
    layouts: {
      default: { windows: [] },
    },
    windowEntries: {
      main: 'main.html',
      secondary: 'secondary.html',
    },
  };

  beforeEach(() => {
    kitModule = new KitModule();
  });

  it('register stores and returns a kit', () => {
    expect(kitModule.register(kit).name).toBe('default-kit');
    expect(kitModule.get('default-kit')).toEqual(kit);
  });

  it('list returns all registered kits', () => {
    kitModule.register(kit);
    kitModule.register({ ...kit, name: 'second-kit' });
    expect(kitModule.list()).toHaveLength(2);
  });

  it('switchKit sets the active kit', () => {
    kitModule.register(kit);
    kitModule.switchKit('default-kit');
    expect(kitModule.getCurrent()?.name).toBe('default-kit');
  });

  it('switchKit throws for unknown kit', () => {
    expect(() => kitModule.switchKit('missing')).toThrow(/not found/);
  });

  it('unregister clears active kit', () => {
    kitModule.register(kit);
    kitModule.switchKit('default-kit');
    kitModule.unregister('default-kit');
    expect(kitModule.getCurrent()).toBeUndefined();
  });

  it('normalizes legacy layout windows into runtime window descriptors', () => {
    const layout = normalizeKitLayoutConfig({
      windows: [
        {
          id: 'main',
          type: 'sidebar',
          title: 'Legacy title',
          layout: { type: 'leaf', panel: 'demo.panel' },
        },
      ],
      activePanel: 'demo.panel',
    }, {
      main: 'main.html',
      secondary: 'secondary.html',
    });

    expect(layout).toEqual({
      windows: [
        {
          id: 'main',
          kind: 'main',
          type: 'panel-area',
          entry: 'main.html',
          state: 'open',
          layout: { type: 'leaf', panel: 'demo.panel' },
          panelInstanceIds: [],
        },
      ],
      activePanel: 'demo.panel',
    });
  });

  it('getLayout returns the named layout from the active kit', () => {
    const kitWithLayouts: KitDescriptor = {
      name: 'multi-layout-kit',
      plugins: [],
      layouts: {
        default: { windows: [] },
        debug: { windows: [{ id: 'dbg', kind: 'main', type: 'panel-area', entry: 'main.html', state: 'open', layout: { type: 'leaf', panel: 'debug' }, panelInstanceIds: [] }] },
      },
      windowEntries: { main: 'main.html', secondary: 'secondary.html' },
    };
    kitModule.register(kitWithLayouts);
    kitModule.switchKit('multi-layout-kit');

    expect(kitModule.getLayout('default')).toEqual({ windows: [] });
    expect(kitModule.getLayout('debug')).toEqual(kitWithLayouts.layouts.debug);
    expect(kitModule.getLayout('nonexistent')).toBeUndefined();
  });

  it('listLayouts returns all layout names from the active kit', () => {
    const kitWithLayouts: KitDescriptor = {
      name: 'multi-layout-kit',
      plugins: [],
      layouts: {
        default: { windows: [] },
        debug: { windows: [] },
        zen: { windows: [] },
      },
      windowEntries: { main: 'main.html', secondary: 'secondary.html' },
    };
    kitModule.register(kitWithLayouts);
    kitModule.switchKit('multi-layout-kit');

    expect(kitModule.listLayouts()).toEqual(['default', 'debug', 'zen']);
  });

  it('getLayout returns undefined when no kit is active', () => {
    expect(kitModule.getLayout('default')).toBeUndefined();
  });

  it('listLayouts returns empty array when no kit is active', () => {
    expect(kitModule.listLayouts()).toEqual([]);
  });
});
