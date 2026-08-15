import { describe, expect, it } from 'vitest';
import { getMenuModeFromURL, mountMenuRuntime } from '../../src/menu/runtime';

describe('mountMenuRuntime', () => {
  it('has no host-side effects in the Web-only client', () => {
    const runtime = mountMenuRuntime({
      sessionId: 'session-1',
      menuMode: 'multi',
      menuTree: [{ type: 'menu', id: 'file', label: 'File', children: [] }],
      applicationMenuTree: [],
      kitMenuTree: [],
      kitMenuRoot: null,
    });

    expect(runtime).toEqual({ dispose: expect.any(Function) });
    expect(runtime.dispose()).toBeUndefined();
  });

  it('parses the optional Web menu mode from the current URL', () => {
    window.history.replaceState({}, '', '/?menuMode=multi');
    expect(getMenuModeFromURL()).toBe('multi');
    window.history.replaceState({}, '', '/');
    expect(getMenuModeFromURL()).toBe('single');
  });
});
