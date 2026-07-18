import { describe, it, expect, beforeEach } from 'vitest';
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
});
