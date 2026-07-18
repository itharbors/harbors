import { describe, expect, it } from 'vitest';

import { MenuModule } from '../../src/framework/menu/index';
import { buildMenuTree, type MenuContributionSource } from '../../src/framework/menu/normalize';

describe('buildMenuTree', () => {
  it('uses runtime defaults when no external contributions are attached', () => {
    const menu = new MenuModule({
      t: (key: string) => ({ 'menu.edit.copy': 'Copy' })[key] ?? key,
      platform: 'win32',
    });

    menu.setDefaults('@ce/menu', [
      { type: 'menu', id: 'file', label: 'File' },
      { type: 'menu', id: 'file/new-session', label: 'New Session', message: 'newSession' },
    ]);

    expect(menu.getState().tree).toEqual([
      {
        type: 'menu',
        id: 'file',
        label: 'File',
        children: [
          {
            type: 'menu',
            id: 'file/new-session',
            label: 'New Session',
            children: [],
          },
        ],
      },
    ]);
  });

  it('translates menu labels through the provided i18n lookup without leaking action metadata', () => {
    const result = buildMenuTree(
      [
        {
          pluginName: 'demo',
          loadOrder: 1,
          items: [
            { type: 'menu', id: 'file', labelKey: 'menu.file' },
            { type: 'menu', id: 'file/open', labelKey: 'menu.file.open', message: 'file.open' },
          ],
        },
      ],
      [],
      (key) => ({ 'menu.file': 'File', 'menu.file.open': 'Open' })[key] ?? key,
    );

    expect(result.tree).toEqual([
      {
        type: 'menu',
        id: 'file',
        label: 'File',
        labelKey: 'menu.file',
        children: [
          {
            type: 'menu',
            id: 'file/open',
            label: 'Open',
            labelKey: 'menu.file.open',
            children: [],
          },
        ],
      },
    ]);
  });

  it('builds nested menu nodes from path ids and uses order only for sorting', () => {
    const externalSources: MenuContributionSource[] = [
      {
        pluginName: 'demo',
        loadOrder: 2,
        items: [
          { type: 'menu', id: 'file', label: 'File', order: 20 },
          { type: 'menu', id: 'file/open', label: 'Open', message: 'file.open', order: 10 },
          { type: 'menu', id: 'file/recent', label: 'Recent', order: 30 },
          { type: 'menu', id: 'file/recent/demo-a', label: 'Demo A', message: 'file.openRecent', order: 5 },
        ],
      },
    ];

    const result = buildMenuTree(externalSources);

    expect(result.warnings).toEqual([]);
    expect(result.tree).toEqual([
      {
        type: 'menu',
        id: 'file',
        label: 'File',
        children: [
          {
            type: 'menu',
            id: 'file/open',
            label: 'Open',
            children: [],
          },
          {
            type: 'menu',
            id: 'file/recent',
            label: 'Recent',
            children: [
              {
                type: 'menu',
                id: 'file/recent/demo-a',
                label: 'Demo A',
                children: [],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('uses supplied default sources when no external contribution is attached', () => {
    const defaultSources: MenuContributionSource[] = [
      {
        pluginName: 'default',
        loadOrder: 1,
        items: [{ type: 'menu', id: 'help', label: 'Help', message: 'help.open' }],
      },
    ];

    const result = buildMenuTree([], defaultSources);

    expect(result.warnings).toEqual([]);
    expect(result.tree).toEqual([
      {
        type: 'menu',
        id: 'help',
        label: 'Help',
        children: [],
      },
    ]);
  });

  it('filters out darwin-only nodes on win32 and keeps shared windows items', () => {
    const externalSources: MenuContributionSource[] = [
      {
        pluginName: 'demo',
        loadOrder: 1,
        items: [
          { type: 'menu', id: 'file', label: 'File' },
          { type: 'menu', id: 'file/macos', label: 'macOS Only', message: 'file.macos', platforms: ['darwin'] },
          { type: 'menu', id: 'file/shared', label: 'Shared', message: 'file.shared', platforms: ['win32', 'linux'] },
        ],
      },
    ];

    const result = buildMenuTree(externalSources, [], undefined, 'win32');

    expect(result.warnings).toEqual([]);
    expect(result.tree).toEqual([
      {
        type: 'menu',
        id: 'file',
        label: 'File',
        children: [
          {
            type: 'menu',
            id: 'file/shared',
            label: 'Shared',
            children: [],
          },
        ],
      },
    ]);
  });

  it('falls back to default menu when external nodes are absent on the current platform', () => {
    const externalSources: MenuContributionSource[] = [
      {
        pluginName: 'external',
        loadOrder: 1,
        items: [{ type: 'menu', id: 'tools', label: 'Tools', message: 'tools.open', platforms: ['darwin'] }],
      },
    ];
    const defaultSources: MenuContributionSource[] = [
      {
        pluginName: 'default',
        loadOrder: 1,
        items: [{ type: 'menu', id: 'help', label: 'Help', message: 'help.open', platforms: ['win32'] }],
      },
    ];

    const result = buildMenuTree(externalSources, defaultSources, undefined, 'win32');

    expect(result.warnings).toEqual([]);
    expect(result.tree).toEqual([
      {
        type: 'menu',
        id: 'help',
        label: 'Help',
        children: [],
      },
    ]);
  });

  it('keeps defaults and reports warnings when current-platform external nodes are all invalid', () => {
    const externalSources: MenuContributionSource[] = [
      {
        pluginName: 'broken',
        loadOrder: 1,
        items: [{ type: 'menu', id: '/bad', label: 'Bad', platforms: ['win32'] }],
      },
    ];
    const defaultSources: MenuContributionSource[] = [
      {
        pluginName: 'default',
        loadOrder: 1,
        items: [{ type: 'menu', id: 'help', label: 'Help', message: 'help.open', platforms: ['win32'] }],
      },
    ];

    const result = buildMenuTree(externalSources, defaultSources, undefined, 'win32');

    expect(result.tree).toEqual([
      {
        type: 'menu',
        id: 'help',
        label: 'Help',
        children: [],
      },
    ]);
    expect(result.warnings).toEqual([{ code: 'invalid-id', id: '/bad', pluginName: 'broken' }]);
  });

  it('normalizes unknown platforms to linux', () => {
    const externalSources: MenuContributionSource[] = [
      {
        pluginName: 'demo',
        loadOrder: 1,
        items: [
          { type: 'menu', id: 'file', label: 'File' },
          { type: 'menu', id: 'file/linux-only', label: 'Linux Only', message: 'file.linux', platforms: ['linux'] },
          { type: 'menu', id: 'file/win-only', label: 'Windows Only', message: 'file.win', platforms: ['win32'] },
        ],
      },
    ];

    const result = buildMenuTree(externalSources, [], undefined, 'freebsd');

    expect(result.tree).toEqual([
      {
        type: 'menu',
        id: 'file',
        label: 'File',
        children: [
          {
            type: 'menu',
            id: 'file/linux-only',
            label: 'Linux Only',
            children: [],
          },
        ],
      },
    ]);
  });

  it('keeps first structural declaration and warns on conflicting duplicates', () => {
    const externalSources: MenuContributionSource[] = [
      {
        pluginName: 'first',
        loadOrder: 1,
        items: [{ type: 'menu', id: 'tools', label: 'Tools', order: 1 }],
      },
      {
        pluginName: 'second',
        loadOrder: 2,
        items: [
          { type: 'menu', id: 'tools', label: 'Tools Override', order: 99 },
          { type: 'menu', id: 'tools/run', label: 'Run', message: 'tools.run' },
        ],
      },
      {
        pluginName: 'third',
        loadOrder: 3,
        items: [{ type: 'menu', id: 'tools/run', label: 'Run Override', message: 'tools.run.override' }],
      },
    ];

    const result = buildMenuTree(externalSources);

    expect(result.tree).toEqual([
      {
        type: 'menu',
        id: 'tools',
        label: 'Tools',
        children: [
          {
            type: 'menu',
            id: 'tools/run',
            label: 'Run',
            children: [],
          },
        ],
      },
    ]);
    expect(result.warnings).toEqual([
      {
        code: 'duplicate-structural-menu',
        id: 'tools',
        pluginName: 'second',
      },
      {
        code: 'duplicate-action-menu',
        id: 'tools/run',
        pluginName: 'third',
      },
    ]);
  });

  it('drops invalid nodes and keeps warnings when parent path is missing', () => {
    const externalSources: MenuContributionSource[] = [
      {
        pluginName: 'demo',
        loadOrder: 1,
        items: [
          { type: 'menu', id: '', label: 'Empty' },
          { type: 'separator', id: 'tools/' },
          { type: 'menu', id: 'edit//copy', label: 'Copy', message: 'edit.copy' },
          { type: 'separator', id: 'missing/child' },
          { type: 'menu', id: 'edit', label: 'Edit' },
          { type: 'menu', id: 'edit/copy', label: 'Copy', message: 'edit.copy' },
        ],
      },
    ];

    const result = buildMenuTree(externalSources);

    expect(result.tree).toEqual([
      {
        type: 'menu',
        id: 'edit',
        label: 'Edit',
        children: [
          {
            type: 'menu',
            id: 'edit/copy',
            label: 'Copy',
            children: [],
          },
        ],
      },
    ]);
    expect(result.warnings).toEqual([
      { code: 'invalid-id', id: '', pluginName: 'demo' },
      { code: 'invalid-id', id: 'tools/', pluginName: 'demo' },
      { code: 'invalid-id', id: 'edit//copy', pluginName: 'demo' },
      { code: 'missing-parent', id: 'missing/child', pluginName: 'demo' },
    ]);
  });

  it('turns a clickable parent into a container and warns', () => {
    const externalSources: MenuContributionSource[] = [
      {
        pluginName: 'demo',
        loadOrder: 1,
        items: [
          { type: 'menu', id: 'view', label: 'View', message: 'view.open' },
          { type: 'menu', id: 'view/layout', label: 'Layout', message: 'view.layout' },
        ],
      },
    ];

    const result = buildMenuTree(externalSources);

    expect(result.tree).toEqual([
      {
        type: 'menu',
        id: 'view',
        label: 'View',
        children: [
          {
            type: 'menu',
            id: 'view/layout',
            label: 'Layout',
            children: [],
          },
        ],
      },
    ]);
    expect(result.warnings).toEqual([
      {
        code: 'menu-node-became-container',
        id: 'view',
        pluginName: 'demo',
      },
    ]);
  });

  it('orders mixed menu and separator siblings uniformly by order, loadOrder, entryIndex, and id', () => {
    const externalSources: MenuContributionSource[] = [
      {
        pluginName: 'alpha',
        loadOrder: 5,
        items: [
          { type: 'menu', id: 'view', label: 'View' },
          { type: 'menu', id: 'view/beta', label: 'Beta', message: 'view.beta', order: 10 },
          { type: 'separator', id: 'view/sep-middle', order: 10 },
          { type: 'menu', id: 'view/gamma', label: 'Gamma', message: 'view.gamma', order: 10 },
          { type: 'separator', id: 'view/sep-late', order: 20 },
        ],
      },
      {
        pluginName: 'beta',
        loadOrder: 2,
        items: [{ type: 'separator', id: 'view/sep-early', order: 10 }],
      },
      {
        pluginName: 'gamma',
        loadOrder: 5,
        items: [{ type: 'menu', id: 'view/alpha', label: 'Alpha', message: 'view.alpha', order: 10 }],
      },
    ];

    const result = buildMenuTree(externalSources);

    expect(result.warnings).toEqual([]);
    expect(result.tree).toEqual([
      {
        type: 'menu',
        id: 'view',
        label: 'View',
        children: [
          { type: 'separator', id: 'view/sep-early' },
          { type: 'menu', id: 'view/alpha', label: 'Alpha', children: [] },
          { type: 'menu', id: 'view/beta', label: 'Beta', children: [] },
          { type: 'separator', id: 'view/sep-middle' },
          { type: 'menu', id: 'view/gamma', label: 'Gamma', children: [] },
          { type: 'separator', id: 'view/sep-late' },
        ],
      },
    ]);
  });

  it('keeps defaults when external contributions exist but are all invalid', () => {
    const externalSources: MenuContributionSource[] = [
      {
        pluginName: 'broken',
        loadOrder: 1,
        items: [
          { type: 'separator', id: 'top' },
          { type: 'menu', id: '/bad', label: 'Bad' },
        ],
      },
    ];
    const defaultSources: MenuContributionSource[] = [
      {
        pluginName: 'default',
        loadOrder: 1,
        items: [{ type: 'menu', id: 'help', label: 'Help', message: 'help.open' }],
      },
    ];

    const result = buildMenuTree(externalSources, defaultSources);

    expect(result.tree).toEqual([
      {
        type: 'menu',
        id: 'help',
        label: 'Help',
        children: [],
      },
    ]);
    expect(result.warnings).toEqual([
      { code: 'root-separator', id: 'top', pluginName: 'broken' },
      { code: 'invalid-id', id: '/bad', pluginName: 'broken' },
    ]);
  });

  it('restores runtime defaults after detaching the last external contribution', () => {
    const menu = new MenuModule({ platform: 'win32' });

    menu.setDefaults('@ce/menu', [{ type: 'menu', id: 'file', label: 'File' }]);
    menu.attach('plugin-menu', {
      menu: [
        { type: 'menu', id: 'tools', label: 'Tools' },
        { type: 'menu', id: 'tools/run', label: 'Run', message: 'run' },
      ],
    });
    menu.detach('plugin-menu');

    expect(menu.getState().tree).toEqual([
      {
        type: 'menu',
        id: 'file',
        label: 'File',
        children: [],
      },
    ]);
  });
});
