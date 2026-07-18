import { describe, it, expect, afterEach } from 'vitest';
import '../../src/layout/split-pane';
import '../../src/layout/panel-group';

describe('ce-panel-group', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('activates the first panel by default', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = `
      <ce-panel title="Files">Files content</ce-panel>
      <ce-panel title="Outline">Outline content</ce-panel>
    `;

    document.body.appendChild(group);

    const panels = group.querySelectorAll('ce-panel');
    expect(panels[0].hasAttribute('active')).toBe(true);
    expect(panels[1].hasAttribute('active')).toBe(false);
    expect(panels[0].hasAttribute('chromeless')).toBe(true);
  });

  it('switches active panels when a group tab is clicked', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = `
      <ce-panel title="Files" active>Files content</ce-panel>
      <ce-panel title="Outline">Outline content</ce-panel>
    `;

    document.body.appendChild(group);
    const tab = group.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    tab.click();

    const panels = group.querySelectorAll('ce-panel');
    expect(panels[0].hasAttribute('active')).toBe(false);
    expect(panels[1].hasAttribute('active')).toBe(true);
  });

  it('emits a panel change event', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = `
      <ce-panel title="Files" active>Files content</ce-panel>
      <ce-panel title="Outline">Outline content</ce-panel>
    `;
    const events: Array<{ title: string; index: number }> = [];
    group.addEventListener('ce-panel-change', ((event: CustomEvent<{ title: string; index: number }>) => {
      events.push(event.detail);
    }) as EventListener);

    document.body.appendChild(group);
    const tab = group.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    tab.click();

    expect(events).toEqual([{ title: 'Outline', index: 1 }]);
  });

  it('prevents active panels and slots from stretching the group', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = `
      <ce-panel title="Files" active>Files content</ce-panel>
      <ce-panel title="Outline">Outline content</ce-panel>
    `;

    document.body.appendChild(group);

    const styles = group.shadowRoot!.querySelector('style')!.textContent || '';
    const contentBlock = styles.match(/\.content \{[\s\S]*?\}/)?.[0] || '';
    expect(styles).toContain(':host {');
    expect(styles).toContain('background: transparent');
    expect(styles).toContain('border: var(--ce-panel-group-border-width, 1px) solid var(--ce-panel-group-border-color, var(--ce-border, #444))');
    expect(styles).toContain('border-bottom: var(--ce-tabbar-border-width, 1px) solid var(--ce-tabbar-border-color, var(--ce-border, #444))');
    expect(contentBlock).toContain('.content {');
    expect(contentBlock).not.toContain('background:');
    expect(styles).toContain('.content slot');
    expect(styles).toContain('::slotted(ce-panel[active])');
    expect(styles).toContain('background: transparent');
    expect(styles).toContain('min-width: 0');
    expect(styles).toContain('overflow: hidden');
  });

  it('removes outer border when nested inside layout containers', () => {
    const splitPane = document.createElement('ce-split-pane');
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" active>Files content</ce-panel>';
    splitPane.appendChild(group);

    document.body.appendChild(splitPane);

    const styles = group.shadowRoot!.querySelector('style')!.textContent || '';
    expect(group.hasAttribute('layout-nested')).toBe(true);
    expect(styles).toContain(':host([layout-nested])');
    expect(styles).toContain('border: 0');
    expect(styles).toContain('border-radius: 0');
    expect(styles).toContain('var(--ce-tab-radius');
  });

  it('mirrors child tab ids onto rendered tab buttons', () => {
    const group = document.createElement('ce-panel-group');
    group.dataset.groupId = 'group-left';
    group.dataset.sessionId = 'session-a';
    group.innerHTML = `
      <ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>
      <ce-panel title="Search" data-tab-id="tab-search">Search content</ce-panel>
    `;

    document.body.appendChild(group);

    const tabs = group.shadowRoot!.querySelectorAll('.tab-item');
    expect((tabs[0] as HTMLElement).dataset.tabId).toBe('tab-files');
    expect((tabs[1] as HTMLElement).dataset.tabId).toBe('tab-search');
  });

  it('renders draggable tab buttons for native cross-window drag start', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = `
      <ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>
      <ce-panel title="Search" data-tab-id="tab-search">Search content</ce-panel>
    `;

    document.body.appendChild(group);

    const tabs = group.shadowRoot!.querySelectorAll('.tab-item');
    expect((tabs[0] as HTMLButtonElement).draggable).toBe(true);
    expect((tabs[1] as HTMLButtonElement).draggable).toBe(true);
  });

  it('marks tab bar and content with drop region hooks', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>';

    document.body.appendChild(group);

    expect(group.shadowRoot!.querySelector('.tab-bar')?.getAttribute('data-drop-region')).toBe('tab-strip');
    expect(group.shadowRoot!.querySelector('.content')?.getAttribute('data-drop-region')).toBe('panel-content');
  });

  it('renders insertion indicator when drop target attributes are present', () => {
    const group = document.createElement('ce-panel-group');
    group.setAttribute('data-drop-target-tab-id', 'tab-search');
    group.setAttribute('data-drop-placement', 'before');
    group.innerHTML = `
      <ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>
      <ce-panel title="Search" data-tab-id="tab-search">Search content</ce-panel>
    `;

    document.body.appendChild(group);

    const indicator = group.shadowRoot!.querySelector('.drop-indicator') as HTMLElement | null;
    expect(indicator).not.toBeNull();
    expect(indicator?.dataset.targetTabId).toBe('tab-search');
    expect(indicator?.dataset.placement).toBe('before');
  });

  it('renders edge preview when drop edge attribute is present', () => {
    const group = document.createElement('ce-panel-group');
    group.setAttribute('data-drop-edge', 'left');
    group.innerHTML = '<ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>';

    document.body.appendChild(group);

    const preview = group.shadowRoot!.querySelector('.drop-edge-preview') as HTMLElement | null;
    expect(preview).not.toBeNull();
    expect(preview?.dataset.edge).toBe('left');
  });

  it('uses shared tab and drop token fallbacks in styles', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>';

    document.body.appendChild(group);

    const styles = group.shadowRoot!.querySelector('style')!.textContent || '';
    expect(styles).toContain('var(--ce-tabbar-bg, var(--ce-surface-raised, #2d2d2d))');
    expect(styles).toContain('var(--ce-tab-bg-hover, var(--ce-surface, #1a1a1a))');
    expect(styles).toContain('var(--ce-drop-indicator-color, var(--ce-accent, #569cd6))');
    expect(styles).toContain('var(--ce-drop-zone-fill, color-mix(in srgb, var(--ce-accent, #569cd6) 18%, transparent))');
  });

  it('uses shared tab tokens for document variant colors and borders', () => {
    const group = document.createElement('ce-panel-group');
    group.setAttribute('variant', 'document');
    group.innerHTML = '<ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>';

    document.body.appendChild(group);

    const styles = group.shadowRoot!.querySelector('style')!.textContent || '';
    expect(styles).toContain(':host([variant="document"]) .tab-bar');
    expect(styles).toContain('background: var(--ce-tabbar-bg, var(--ce-surface-raised, #2d2d2d));');
    expect(styles).toContain(':host([variant="document"]) .tab-item {');
    expect(styles).toContain('background: var(--ce-tab-bg, transparent);');
    expect(styles).toContain(':host([variant="document"]) .tab-item.active {');
    expect(styles).toContain('color: var(--ce-tab-fg-active, var(--ce-text-primary, #fff));');
    expect(styles).toContain('background: var(--ce-tab-bg-active, var(--ce-surface, #1a1a1a));');
    expect(styles).toContain('border-color: var(--ce-tab-separator, var(--ce-border, #444));');
    expect(styles).toContain('border-bottom-color: var(--ce-tab-bg-active, var(--ce-surface, #1a1a1a));');
  });
});
