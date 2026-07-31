// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): void;
  methods: {
    onSnapshotChanged(payload: unknown): void;
    onScanProgress(payload: unknown): void;
    onOperationProgress(payload: unknown): void;
  };
};

const sourceOnly = item('source-id', 'source-skill', 'source-only', ['install'], 'source-digest', null);
const globalOnly = item('global-id', 'global-skill', 'global-only', ['disable', 'uninstall'], null, 'global-digest');

describe('Skill Manager panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('renders global mode as a semantic three-column workspace and loads selection detail', async () => {
    const snapshot = makeSnapshot(1, [globalOnly]);
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot;
      if (method === 'getSkillDetail') return detail(globalOnly, 'Global instructions');
      throw new Error(`Unexpected method: ${method}`);
    });
    const definition = await loadPanel();

    await definition.mount({ message: { request } });
    await vi.waitFor(() => expect(document.querySelector('[data-detail-name]')?.textContent).toBe('global-skill'));

    expect(document.querySelector('h1')?.textContent).toBe('Skill Manager');
    expect(document.querySelector('[data-mode]')?.textContent).toContain('Global');
    expect(document.querySelector('[aria-label="Status filters"]')).not.toBeNull();
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Skill detail"]')).not.toBeNull();
    expect(request).toHaveBeenCalledWith('@itharbors/skill-manager', 'getSkillDetail', {
      skillId: globalOnly.id,
      revision: 1,
    });
  });

  it('navigates the opaque directory browser and selects its current folder', async () => {
    const initial = makeSnapshot(1, []);
    const selected = makeSnapshot(2, [sourceOnly], { mode: 'source', sourceRootLabel: '~/source' });
    const request = vi.fn(async (_plugin: string, method: string, input?: any) => {
      if (method === 'getSnapshot') return initial;
      if (method === 'browseDirectory' && input?.directoryId === undefined) {
        return {
          current: { id: 'home-id', label: '~' },
          children: [{ id: 'source-directory-id', name: 'source' }],
        };
      }
      if (method === 'browseDirectory' && input?.directoryId === 'source-directory-id') {
        return {
          current: { id: 'source-directory-id', label: '~/source' },
          parentId: 'home-id',
          children: [],
        };
      }
      if (method === 'selectSource') {
        expect(input).toEqual({ directoryId: 'source-directory-id' });
        return selected;
      }
      if (method === 'getSkillDetail') return detail(sourceOnly, 'Source instructions');
      throw new Error(`Unexpected method: ${method}`);
    });
    const definition = await loadPanel();
    await definition.mount({ message: { request } });

    document.querySelector<HTMLButtonElement>('[data-action="choose-source"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-directory-id="source-directory-id"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-current-directory]')?.textContent).toBe('~/source'));
    document.querySelector<HTMLButtonElement>('[data-action="use-directory"]')!.click();

    await vi.waitFor(() => expect(document.querySelector('[data-mode]')?.textContent).toContain('Source'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('filters by status and query without losing keyboard list semantics', async () => {
    const snapshot = makeSnapshot(1, [sourceOnly, globalOnly]);
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot;
      if (method === 'getSkillDetail') return detail(sourceOnly, 'Source');
      throw new Error(`Unexpected method: ${method}`);
    });
    const definition = await loadPanel();
    await definition.mount({ message: { request } });

    document.querySelector<HTMLButtonElement>('[data-filter="source-only"]')!.click();
    expect(document.querySelectorAll('[data-skill-id]')).toHaveLength(1);
    expect(document.querySelector('[data-skill-id]')?.textContent).toContain('source-skill');

    document.querySelector<HTMLButtonElement>('[data-filter="all"]')!.click();
    const search = document.querySelector<HTMLInputElement>('[data-search]')!;
    search.value = 'global';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelectorAll('[data-skill-id]')).toHaveLength(1);
    expect(document.querySelector('[data-skill-id]')?.textContent).toContain('global-skill');
  });

  it('discards stale detail responses and renders malicious Skill text as text only', async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    const oldDetail = new Promise((resolve) => { resolveOld = resolve; });
    const newer = item('new-id', 'new-skill', 'global-only', ['disable', 'uninstall'], null, 'new-digest');
    const request = vi.fn(async (_plugin: string, method: string, input?: any) => {
      if (method === 'getSnapshot') return makeSnapshot(1, [globalOnly]);
      if (method === 'getSkillDetail' && input.skillId === globalOnly.id) return oldDetail;
      if (method === 'getSkillDetail' && input.skillId === newer.id) {
        return detail(newer, '</pre><img src=x onerror=alert(1)>');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const definition = await loadPanel();
    await definition.mount({ message: { request } });

    definition.methods.onSnapshotChanged(makeSnapshot(2, [newer]));
    await vi.waitFor(() => expect(document.querySelector('[data-detail-name]')?.textContent).toBe('new-skill'));
    resolveOld!(detail(globalOnly, 'Old detail'));
    await Promise.resolve();

    expect(document.querySelector('[data-detail-name]')?.textContent).toBe('new-skill');
    expect(document.querySelector('pre')?.textContent).toBe('</pre><img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
  });

  it('confirms actions, disables controls while pending, and applies the returned snapshot', async () => {
    let resolveAction: ((value: unknown) => void) | undefined;
    const actionResult = new Promise((resolve) => { resolveAction = resolve; });
    const request = vi.fn(async (_plugin: string, method: string, input?: any) => {
      if (method === 'getSnapshot') return makeSnapshot(1, [sourceOnly]);
      if (method === 'getSkillDetail') return detail(sourceOnly, 'Source');
      if (method === 'performAction') {
        expect(input).toEqual({
          action: 'install',
          skillId: sourceOnly.id,
          revision: 1,
          expectedDigest: 'source-digest',
        });
        return actionResult;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const definition = await loadPanel();
    await definition.mount({ message: { request } });
    await vi.waitFor(() => expect(document.querySelector('[data-action="install"]')).not.toBeNull());

    document.querySelector<HTMLButtonElement>('[data-action="install"]')!.click();
    const confirm = document.querySelector<HTMLButtonElement>('[data-action="confirm"]')!;
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('source-skill');
    confirm.click();
    expect(document.querySelector<HTMLButtonElement>('[data-action="confirm"]')?.disabled).toBe(true);

    resolveAction!({ receipt: {}, snapshot: makeSnapshot(2, []) });
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(document.querySelector('[data-state="empty"]')).not.toBeNull();
  });

  it('supports Arrow key selection and traps dialog focus with Escape restoration', async () => {
    const request = vi.fn(async (_plugin: string, method: string, input?: any) => {
      if (method === 'getSnapshot') return makeSnapshot(1, [globalOnly, sourceOnly]);
      if (method === 'getSkillDetail') {
        const selected = input.skillId === globalOnly.id ? globalOnly : sourceOnly;
        return detail(selected, selected.name);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const definition = await loadPanel();
    await definition.mount({ message: { request } });
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-skill-id]'));
    rows[0].focus();
    rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const selectedSource = document.querySelector<HTMLElement>(`[data-skill-id="${sourceOnly.id}"]`)!;
    expect(document.activeElement).toBe(selectedSource);
    expect(selectedSource.getAttribute('aria-selected')).toBe('true');
    selectedSource.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('[data-action="uninstall"]')).not.toBeNull());

    const uninstall = document.querySelector<HTMLButtonElement>('[data-action="uninstall"]')!;
    uninstall.focus();
    uninstall.click();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const cancel = dialog.querySelector<HTMLButtonElement>('[data-action="cancel"]')!;
    const confirm = dialog.querySelector<HTMLButtonElement>('[data-action="confirm"]')!;
    confirm.focus();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(cancel);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(uninstall);
  });

  it('accepts only newer broadcasts and reports progress through aria-live', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return makeSnapshot(2, [globalOnly]);
      if (method === 'getSkillDetail') return detail(globalOnly, 'Global');
      throw new Error(`Unexpected method: ${method}`);
    });
    const definition = await loadPanel();
    await definition.mount({ message: { request } });

    definition.methods.onSnapshotChanged(makeSnapshot(1, [sourceOnly]));
    expect(document.querySelector('[data-skill-id]')?.getAttribute('data-skill-id')).toBe(globalOnly.id);
    definition.methods.onScanProgress({ state: 'started' });
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain('Scanning');
    definition.methods.onOperationProgress({ state: 'completed', action: 'disable' });
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain('completed');
  });

  it('shows an actionable initial error state and retries the scan', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('Global Skill scan failed'))
      .mockResolvedValueOnce(makeSnapshot(1, []));
    const definition = await loadPanel();

    await definition.mount({ message: { request } });
    expect(document.querySelector('[data-state="error"]')?.textContent).toContain('Global Skill scan failed');

    document.querySelector<HTMLButtonElement>('[data-action="retry"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-state="empty"]')).not.toBeNull());
    expect(request).toHaveBeenLastCalledWith('@itharbors/skill-manager', 'rescan', undefined);
  });

  it('declares responsive collapse and reduced-motion behavior', async () => {
    const cssPath = path.join(
      process.cwd(),
      'plugins/skill-manager/panel.manager/src/index.css',
    );
    const css = await readFile(cssPath, 'utf8');
    expect(css).toContain('grid-template-columns: 220px minmax(300px, 1fr) minmax(320px, 0.9fr)');
    expect(css).toContain('@media (max-width: 860px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('min-height: 100dvh');
  });
});

async function loadPanel(): Promise<PanelDefinition> {
  return (await import('../panel.manager/src/index')).default as PanelDefinition;
}

function item(
  id: string,
  name: string,
  status: string,
  actions: string[],
  sourceDigest: string | null,
  globalDigest: string | null,
) {
  return {
    id,
    name,
    description: `${name} description`,
    basename: name,
    status,
    actions,
    sourceDigest,
    globalDigest,
    recoveryDigest: null,
    protected: status === 'protected',
    diagnostics: [],
  };
}

function makeSnapshot(revision: number, items: any[], overrides: Record<string, unknown> = {}) {
  const counts: Record<string, number> = {
    'source-only': 0,
    current: 0,
    'update-available': 0,
    'global-only': 0,
    disabled: 0,
    trashed: 0,
    protected: 0,
    conflict: 0,
    invalid: 0,
  };
  for (const value of items) counts[value.status] += 1;
  return {
    revision,
    generation: revision,
    mode: 'global',
    globalRootLabel: '$CODEX_HOME/skills',
    sourceRootLabel: null,
    scanning: false,
    truncated: false,
    counts,
    items,
    diagnostics: [],
    ...overrides,
  };
}

function detail(value: any, text: string) {
  const location = {
    origin: value.sourceDigest ? 'source' : 'global',
    basename: value.basename,
    manifest: { name: value.name, description: value.description },
    digest: value.sourceDigest ?? value.globalDigest,
    text,
  };
  return {
    id: value.id,
    revision: 1,
    name: value.name,
    description: value.description,
    status: value.status,
    diagnostics: [],
    source: value.sourceDigest ? location : null,
    global: value.globalDigest ? { ...location, origin: 'global' } : null,
    recovery: null,
  };
}
