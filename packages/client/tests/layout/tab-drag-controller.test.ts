import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/floating-panel-layer';
import '../../src/layout/panel-group';
import { TabDragController } from '../../src/layout/tab-drag-controller';
import type { DropDescriptor, EditorLayoutNode } from '../../src/layout/tab-layout';

class MockDataTransfer {
  effectAllowed = 'all';
  dropEffect = 'none';
  private store = new Map<string, string>();

  setData(type: string, value: string) {
    this.store.set(type, value);
  }

  getData(type: string) {
    return this.store.get(type) ?? '';
  }
}

function createDragEvent(
  type: string,
  input: { dataTransfer: MockDataTransfer; clientX?: number; clientY?: number },
): DragEvent {
  const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: input.dataTransfer });
  Object.defineProperty(event, 'clientX', { value: input.clientX ?? 0 });
  Object.defineProperty(event, 'clientY', { value: input.clientY ?? 0 });
  return event as DragEvent;
}

const PointerEventCtor = window.PointerEvent ?? MouseEvent;

afterEach(() => {
  document.body.innerHTML = '';
});

function mockRect(element: Element, rect: Partial<DOMRect>) {
  (element as HTMLElement).getBoundingClientRect = () => ({
    x: rect.left ?? 0,
    y: rect.top ?? 0,
    top: rect.top ?? 0,
    left: rect.left ?? 0,
    right: rect.right ?? 0,
    bottom: rect.bottom ?? 0,
    width: (rect.right ?? 0) - (rect.left ?? 0),
    height: (rect.bottom ?? 0) - (rect.top ?? 0),
    toJSON: () => ({}),
  } as DOMRect);
}

function createControllerLayout(): EditorLayoutNode {
  return {
    kind: 'split',
    direction: 'row',
    children: [
      {
        kind: 'group',
        groupId: 'group-left',
        sessionId: 'session-a',
        windowId: 'window-main',
        activeTabId: 'tab-files',
        tabs: [{
          tabId: 'tab-files',
          sessionId: 'session-a',
          windowId: 'window-main',
          groupId: 'group-left',
          title: 'Files',
          panelName: '@itharbors/files.list',
          panelType: 'iframe',
          src: '/files.html',
          content: { type: 'leaf', panel: '@itharbors/files.list' },
        }],
      },
      {
        kind: 'group',
        groupId: 'group-right',
        sessionId: 'session-a',
        windowId: 'window-main',
        activeTabId: 'tab-main',
        tabs: [{
          tabId: 'tab-main',
          sessionId: 'session-a',
          windowId: 'window-main',
          groupId: 'group-right',
          title: 'Main',
          panelName: '@itharbors/editor.main',
          panelType: 'iframe',
          src: '/editor.html',
          content: { type: 'leaf', panel: '@itharbors/editor.main' },
        }],
      },
    ],
  };
}

describe('TabDragController', () => {
  it('applies preview on pointer move and commits on pointer up', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <ce-panel-group data-group-id="group-left" data-session-id="session-a" data-window-id="window-main">
        <ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>
      </ce-panel-group>
      <ce-panel-group data-group-id="group-right" data-session-id="session-a" data-window-id="window-main">
        <ce-panel title="Main" data-tab-id="tab-main" active>Main content</ce-panel>
      </ce-panel-group>
    `;
    document.body.appendChild(root);

    let layout: EditorLayoutNode | null = createControllerLayout();
    const commitLayout = vi.fn((next: EditorLayoutNode) => {
      layout = next;
    });
    const controller = new TabDragController(root, { getLayout: () => layout, commitLayout });
    controller.bind();

    const sourceTab = root.querySelector('ce-panel-group')!.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const targetGroup = root.querySelectorAll('ce-panel-group')[1] as HTMLElement;
    const targetTab = targetGroup.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const tabBar = targetGroup.shadowRoot!.querySelector('.tab-bar') as HTMLElement;
    const content = targetGroup.shadowRoot!.querySelector('.content') as HTMLElement;

    mockRect(tabBar, { left: 100, right: 260, top: 0, bottom: 32 });
    mockRect(targetTab, { left: 100, right: 180, top: 0, bottom: 32 });
    mockRect(content, { left: 100, right: 260, top: 32, bottom: 232 });

    sourceTab.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 10, clientY: 10, bubbles: true, composed: true }));
    expect(document.querySelector('[data-ce-tab-drag-shield]')).toBeNull();

    document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 110, clientY: 16, bubbles: true }));
    expect(document.querySelector('[data-ce-tab-drag-shield]')).toBeInstanceOf(HTMLElement);

    expect(targetGroup.getAttribute('data-drop-target-tab-id')).toBe('tab-main');
    expect(targetGroup.getAttribute('data-drop-placement')).toBe('before');

    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 110, clientY: 16, bubbles: true }));
    expect(commitLayout).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-ce-tab-drag-shield]')).toBeNull();
  });

  it('removes the iframe drag shield when destroyed mid-drag', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <ce-panel-group data-group-id="group-left" data-session-id="session-a" data-window-id="window-main">
        <ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>
      </ce-panel-group>
    `;
    document.body.appendChild(root);

    const controller = new TabDragController(root, { getLayout: () => createControllerLayout(), commitLayout: vi.fn() });
    controller.bind();

    const sourceTab = root.querySelector('ce-panel-group')!.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    sourceTab.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 10, clientY: 10, bubbles: true, composed: true }));
    document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 20, clientY: 10, bubbles: true }));
    expect(document.querySelector('[data-ce-tab-drag-shield]')).toBeInstanceOf(HTMLElement);

    controller.destroy();
    expect(document.querySelector('[data-ce-tab-drag-shield]')).toBeNull();
  });

  it('does not start dragging for a plain tab click', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <ce-panel-group data-group-id="group-left" data-session-id="session-a" data-window-id="window-main">
        <ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>
      </ce-panel-group>
    `;
    document.body.appendChild(root);

    const commitLayout = vi.fn();
    const controller = new TabDragController(root, { getLayout: () => createControllerLayout(), commitLayout });
    controller.bind();

    const sourceTab = root.querySelector('ce-panel-group')!.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    sourceTab.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 10, clientY: 10, bubbles: true, composed: true }));
    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 10, clientY: 10, bubbles: true }));

    expect(document.querySelector('[data-ce-tab-drag-shield]')).toBeNull();
    expect(commitLayout).not.toHaveBeenCalled();
  });

  it('marks foreign-session targets as forbidden and does not commit', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <ce-panel-group data-group-id="group-left" data-session-id="session-a" data-window-id="window-main">
        <ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>
      </ce-panel-group>
      <ce-panel-group data-group-id="group-right" data-session-id="session-b" data-window-id="window-main">
        <ce-panel title="Main" data-tab-id="tab-main" active>Main content</ce-panel>
      </ce-panel-group>
    `;
    document.body.appendChild(root);

    const commitLayout = vi.fn();
    const controller = new TabDragController(root, { getLayout: () => createControllerLayout(), commitLayout });
    controller.bind();

    const sourceTab = root.querySelector('ce-panel-group')!.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const targetGroup = root.querySelectorAll('ce-panel-group')[1] as HTMLElement;
    const tabBar = targetGroup.shadowRoot!.querySelector('.tab-bar') as HTMLElement;
    const targetTab = targetGroup.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const content = targetGroup.shadowRoot!.querySelector('.content') as HTMLElement;

    mockRect(tabBar, { left: 100, right: 260, top: 0, bottom: 32 });
    mockRect(targetTab, { left: 100, right: 180, top: 0, bottom: 32 });
    mockRect(content, { left: 100, right: 260, top: 32, bottom: 232 });

    sourceTab.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 10, clientY: 10, bubbles: true, composed: true }));
    document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 110, clientY: 16, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 110, clientY: 16, bubbles: true }));

    expect(root.hasAttribute('data-tab-drag-forbidden')).toBe(true);
    expect(commitLayout).not.toHaveBeenCalled();
  });

  it('docks a floating panel into the target group when dropped on a layout tab strip', async () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <ce-panel-group data-session-id="session-a" data-window-id="window-main" data-group-id="group-left">
        <ce-panel active data-tab-id="tab-files" title="Files"></ce-panel>
      </ce-panel-group>
      <floating-panel-layer></floating-panel-layer>
    `;
    const layer = root.querySelector('floating-panel-layer')!;
    layer.setAttribute('data-state', JSON.stringify([{
      id: 'panel-1',
      panelName: '@itharbors/detail.detail',
      title: 'Detail',
      src: '/detail.html?sessionId=session-a',
      state: 'open',
    }]));
    document.body.appendChild(root);

    const commits: EditorLayoutNode[] = [];
    const floatingDrops: Array<{ panelInstanceId: string; descriptor: DropDescriptor }> = [];
    const controller = new TabDragController(root, {
      getLayout: () => createControllerLayout(),
      commitLayout: (layout) => commits.push(layout),
      dockFloatingPanel: (panelInstanceId, descriptor) => {
        floatingDrops.push({ panelInstanceId, descriptor });
      },
    });
    controller.bind();
    await Promise.resolve();

    const targetGroup = root.querySelector('ce-panel-group') as HTMLElement;
    const targetTab = targetGroup.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const tabBar = targetGroup.shadowRoot!.querySelector('.tab-bar') as HTMLElement;
    const content = targetGroup.shadowRoot!.querySelector('.content') as HTMLElement;
    mockRect(tabBar, { left: 32, right: 180, top: 0, bottom: 32 });
    mockRect(targetTab, { left: 32, right: 120, top: 0, bottom: 32 });
    mockRect(content, { left: 32, right: 180, top: 32, bottom: 220 });

    const floatingGroup = layer.shadowRoot!.querySelector('ce-panel-group') as HTMLElement;
    const floatingTab = floatingGroup.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    floatingTab.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 16, clientY: 16, bubbles: true, composed: true }));
    document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 40, clientY: 16, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 40, clientY: 16, bubbles: true }));

    expect(commits).toEqual([]);
    expect(floatingDrops).toEqual([{
      panelInstanceId: 'panel-1',
      descriptor: expect.objectContaining({
        kind: 'insert-tab',
        targetGroupId: 'group-left',
        targetTabId: 'tab-files',
      }) as DropDescriptor,
    }]);
  });

  it('writes a native tab drag payload during dragstart', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <ce-panel-group data-group-id="group-left" data-session-id="session-a" data-window-id="window-left">
        <ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>
      </ce-panel-group>
    `;
    document.body.appendChild(root);

    const controller = new TabDragController(root, {
      getLayout: () => ({
        kind: 'group',
        groupId: 'group-left',
        sessionId: 'session-a',
        windowId: 'window-left',
        activeTabId: 'tab-files',
        tabs: [{
          tabId: 'tab-files',
          sessionId: 'session-a',
          windowId: 'window-left',
          groupId: 'group-left',
          title: 'Files',
          panelName: '@itharbors/files.list',
          panelType: 'iframe',
          src: '/files.html',
          content: { type: 'leaf', panel: '@itharbors/files.list' },
        }],
      }),
      commitLayout: vi.fn(),
      broadcastCloseSource: vi.fn(),
    });
    controller.bind();

    const tab = root.querySelector('ce-panel-group')!.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const transfer = new MockDataTransfer();
    tab.dispatchEvent(createDragEvent('dragstart', { dataTransfer: transfer }));

    expect(JSON.parse(transfer.getData('application/x-ce-tab-drag'))).toMatchObject({
      type: 'ce/tab-drag',
      sessionId: 'session-a',
      sourceWindowId: 'window-left',
      sourceGroupId: 'group-left',
      sourceTabId: 'tab-files',
      tab: expect.objectContaining({
        panelName: '@itharbors/files.list',
        title: 'Files',
      }),
    });
  });

  it('commits a native cross-window drop and broadcasts source close after target insert', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <ce-panel-group data-group-id="group-right" data-session-id="session-a" data-window-id="window-right">
        <ce-panel title="Main" data-tab-id="tab-main" active>Main content</ce-panel>
      </ce-panel-group>
    `;
    document.body.appendChild(root);

    let layout: EditorLayoutNode | null = {
      kind: 'group',
      groupId: 'group-right',
      sessionId: 'session-a',
      windowId: 'window-right',
      activeTabId: 'tab-main',
      tabs: [{
        tabId: 'tab-main',
        sessionId: 'session-a',
        windowId: 'window-right',
        groupId: 'group-right',
        title: 'Main',
        panelName: '@itharbors/editor.main',
        panelType: 'iframe',
        src: '/editor.html',
        content: { type: 'leaf', panel: '@itharbors/editor.main' },
      }],
    };
    const commitLayout = vi.fn((next: EditorLayoutNode) => {
      layout = next;
    });
    const broadcastCloseSource = vi.fn();
    const controller = new TabDragController(root, {
      getLayout: () => layout,
      commitLayout,
      broadcastCloseSource,
    });
    controller.bind();

    const targetGroup = root.querySelector('ce-panel-group') as HTMLElement;
    const targetTab = targetGroup.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const tabBar = targetGroup.shadowRoot!.querySelector('.tab-bar') as HTMLElement;
    const content = targetGroup.shadowRoot!.querySelector('.content') as HTMLElement;
    mockRect(tabBar, { left: 100, right: 260, top: 0, bottom: 32 });
    mockRect(targetTab, { left: 100, right: 180, top: 0, bottom: 32 });
    mockRect(content, { left: 100, right: 260, top: 32, bottom: 232 });

    const transfer = new MockDataTransfer();
    transfer.setData('application/x-ce-tab-drag', JSON.stringify({
      type: 'ce/tab-drag',
      sessionId: 'session-a',
      sourceWindowId: 'window-left',
      sourceGroupId: 'group-left',
      sourceTabId: 'tab-files',
      tab: {
        title: 'Files',
        panelName: '@itharbors/files.list',
        panelType: 'iframe',
        src: '/files.html',
        content: { type: 'leaf', panel: '@itharbors/files.list' },
      },
    }));

    root.dispatchEvent(createDragEvent('dragover', {
      dataTransfer: transfer,
      clientX: 110,
      clientY: 16,
    }));
    expect(targetGroup.getAttribute('data-drop-target-tab-id')).toBe('tab-main');

    const dropTabBar = targetGroup.shadowRoot!.querySelector('.tab-bar') as HTMLElement;
    const dropTargetTab = targetGroup.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const dropContent = targetGroup.shadowRoot!.querySelector('.content') as HTMLElement;
    mockRect(dropTabBar, { left: 100, right: 260, top: 0, bottom: 32 });
    mockRect(dropTargetTab, { left: 100, right: 180, top: 0, bottom: 32 });
    mockRect(dropContent, { left: 100, right: 260, top: 32, bottom: 232 });

    root.dispatchEvent(createDragEvent('drop', {
      dataTransfer: transfer,
      clientX: 110,
      clientY: 16,
    }));

    expect(commitLayout).toHaveBeenCalledTimes(1);
    expect(broadcastCloseSource).toHaveBeenCalledWith({
      sessionId: 'session-a',
      sourceWindowId: 'window-left',
      sourceGroupId: 'group-left',
      sourceTabId: 'tab-files',
    });
  });

  it('ignores native drops from another session', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <ce-panel-group data-group-id="group-right" data-session-id="session-a" data-window-id="window-right">
        <ce-panel title="Main" data-tab-id="tab-main" active>Main content</ce-panel>
      </ce-panel-group>
    `;
    document.body.appendChild(root);

    const commitLayout = vi.fn();
    const controller = new TabDragController(root, {
      getLayout: () => ({
        kind: 'group',
        groupId: 'group-right',
        sessionId: 'session-a',
        windowId: 'window-right',
        activeTabId: 'tab-main',
        tabs: [{
          tabId: 'tab-main',
          sessionId: 'session-a',
          windowId: 'window-right',
          groupId: 'group-right',
          title: 'Main',
          panelName: '@itharbors/editor.main',
          panelType: 'iframe',
          src: '/editor.html',
          content: { type: 'leaf', panel: '@itharbors/editor.main' },
        }],
      }),
      commitLayout,
      broadcastCloseSource: vi.fn(),
    });
    controller.bind();

    const targetGroup = root.querySelector('ce-panel-group') as HTMLElement;
    const targetTab = targetGroup.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const tabBar = targetGroup.shadowRoot!.querySelector('.tab-bar') as HTMLElement;
    const content = targetGroup.shadowRoot!.querySelector('.content') as HTMLElement;
    mockRect(tabBar, { left: 100, right: 260, top: 0, bottom: 32 });
    mockRect(targetTab, { left: 100, right: 180, top: 0, bottom: 32 });
    mockRect(content, { left: 100, right: 260, top: 32, bottom: 232 });

    const transfer = new MockDataTransfer();
    transfer.setData('application/x-ce-tab-drag', JSON.stringify({
      type: 'ce/tab-drag',
      sessionId: 'session-b',
      sourceWindowId: 'window-left',
      sourceGroupId: 'group-left',
      sourceTabId: 'tab-files',
      tab: {
        title: 'Files',
        panelName: '@itharbors/files.list',
        panelType: 'iframe',
        src: '/files.html',
        content: { type: 'leaf', panel: '@itharbors/files.list' },
      },
    }));

    root.dispatchEvent(createDragEvent('dragover', {
      dataTransfer: transfer,
      clientX: 110,
      clientY: 16,
    }));
    root.dispatchEvent(createDragEvent('drop', {
      dataTransfer: transfer,
      clientX: 110,
      clientY: 16,
    }));

    expect(commitLayout).not.toHaveBeenCalled();
    expect(root.hasAttribute('data-tab-drag-forbidden')).toBe(false);
  });

  it('clears forbidden state on drop and ignores a later dragend after native state reset', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <ce-panel-group data-group-id="group-left" data-session-id="session-a" data-window-id="window-left">
        <ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>
      </ce-panel-group>
      <ce-panel-group data-group-id="group-right" data-session-id="session-a" data-window-id="window-right">
        <ce-panel title="Main" data-tab-id="tab-main" active>Main content</ce-panel>
      </ce-panel-group>
    `;
    document.body.appendChild(root);

    const controller = new TabDragController(root, {
      getLayout: () => ({
        kind: 'group',
        groupId: 'group-left',
        sessionId: 'session-a',
        windowId: 'window-left',
        activeTabId: 'tab-files',
        tabs: [{
          tabId: 'tab-files',
          sessionId: 'session-a',
          windowId: 'window-left',
          groupId: 'group-left',
          title: 'Files',
          panelName: '@itharbors/files.list',
          panelType: 'iframe',
          src: '/files.html',
          content: { type: 'leaf', panel: '@itharbors/files.list' },
        }],
      }),
      commitLayout: vi.fn(),
      broadcastCloseSource: vi.fn(),
    });
    controller.bind();

    const sourceTab = root.querySelector('ce-panel-group')!.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const transfer = new MockDataTransfer();
    sourceTab.dispatchEvent(createDragEvent('dragstart', { dataTransfer: transfer }));

    root.setAttribute('data-tab-drag-forbidden', '');
    root.dispatchEvent(createDragEvent('drop', {
      dataTransfer: transfer,
      clientX: 0,
      clientY: 0,
    }));
    expect(root.hasAttribute('data-tab-drag-forbidden')).toBe(false);

    root.setAttribute('data-tab-drag-forbidden', '');
    root.dispatchEvent(new Event('dragend', { bubbles: true, composed: true }));
    expect(root.hasAttribute('data-tab-drag-forbidden')).toBe(true);
  });

  it('does not commit a native drop when the drop point no longer resolves a target', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <ce-panel-group data-group-id="group-right" data-session-id="session-a" data-window-id="window-right">
        <ce-panel title="Main" data-tab-id="tab-main" active>Main content</ce-panel>
      </ce-panel-group>
    `;
    document.body.appendChild(root);

    const commitLayout = vi.fn();
    const broadcastCloseSource = vi.fn();
    const controller = new TabDragController(root, {
      getLayout: () => ({
        kind: 'group',
        groupId: 'group-right',
        sessionId: 'session-a',
        windowId: 'window-right',
        activeTabId: 'tab-main',
        tabs: [{
          tabId: 'tab-main',
          sessionId: 'session-a',
          windowId: 'window-right',
          groupId: 'group-right',
          title: 'Main',
          panelName: '@itharbors/editor.main',
          panelType: 'iframe',
          src: '/editor.html',
          content: { type: 'leaf', panel: '@itharbors/editor.main' },
        }],
      }),
      commitLayout,
      broadcastCloseSource,
    });
    controller.bind();

    const targetGroup = root.querySelector('ce-panel-group') as HTMLElement;
    const targetTab = targetGroup.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const tabBar = targetGroup.shadowRoot!.querySelector('.tab-bar') as HTMLElement;
    const content = targetGroup.shadowRoot!.querySelector('.content') as HTMLElement;
    mockRect(tabBar, { left: 100, right: 260, top: 0, bottom: 32 });
    mockRect(targetTab, { left: 100, right: 180, top: 0, bottom: 32 });
    mockRect(content, { left: 100, right: 260, top: 32, bottom: 232 });

    const transfer = new MockDataTransfer();
    transfer.setData('application/x-ce-tab-drag', JSON.stringify({
      type: 'ce/tab-drag',
      sessionId: 'session-a',
      sourceWindowId: 'window-left',
      sourceGroupId: 'group-left',
      sourceTabId: 'tab-files',
      tab: {
        title: 'Files',
        panelName: '@itharbors/files.list',
        panelType: 'iframe',
        src: '/files.html',
        content: { type: 'leaf', panel: '@itharbors/files.list' },
      },
    }));

    root.dispatchEvent(createDragEvent('dragover', {
      dataTransfer: transfer,
      clientX: 110,
      clientY: 16,
    }));
    root.dispatchEvent(createDragEvent('drop', {
      dataTransfer: transfer,
      clientX: 10,
      clientY: 10,
    }));

    expect(commitLayout).not.toHaveBeenCalled();
    expect(broadcastCloseSource).not.toHaveBeenCalled();
  });

  it('ignores plain text payloads without the tab drag prefix', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <ce-panel-group data-group-id="group-right" data-session-id="session-a" data-window-id="window-right">
        <ce-panel title="Main" data-tab-id="tab-main" active>Main content</ce-panel>
      </ce-panel-group>
    `;
    document.body.appendChild(root);

    const commitLayout = vi.fn();
    const controller = new TabDragController(root, {
      getLayout: () => ({
        kind: 'group',
        groupId: 'group-right',
        sessionId: 'session-a',
        windowId: 'window-right',
        activeTabId: 'tab-main',
        tabs: [{
          tabId: 'tab-main',
          sessionId: 'session-a',
          windowId: 'window-right',
          groupId: 'group-right',
          title: 'Main',
          panelName: '@itharbors/editor.main',
          panelType: 'iframe',
          src: '/editor.html',
          content: { type: 'leaf', panel: '@itharbors/editor.main' },
        }],
      }),
      commitLayout,
      broadcastCloseSource: vi.fn(),
    });
    controller.bind();

    const targetGroup = root.querySelector('ce-panel-group') as HTMLElement;
    const targetTab = targetGroup.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const tabBar = targetGroup.shadowRoot!.querySelector('.tab-bar') as HTMLElement;
    const content = targetGroup.shadowRoot!.querySelector('.content') as HTMLElement;
    mockRect(tabBar, { left: 100, right: 260, top: 0, bottom: 32 });
    mockRect(targetTab, { left: 100, right: 180, top: 0, bottom: 32 });
    mockRect(content, { left: 100, right: 260, top: 32, bottom: 232 });

    const transfer = new MockDataTransfer();
    transfer.setData('text/plain', JSON.stringify({
      type: 'ce/tab-drag',
      sessionId: 'session-a',
      sourceWindowId: 'window-left',
      sourceGroupId: 'group-left',
      sourceTabId: 'tab-files',
      tab: {
        title: 'Files',
        panelName: '@itharbors/files.list',
        panelType: 'iframe',
        src: '/files.html',
        content: { type: 'leaf', panel: '@itharbors/files.list' },
      },
    }));

    root.dispatchEvent(createDragEvent('dragover', {
      dataTransfer: transfer,
      clientX: 110,
      clientY: 16,
    }));
    root.dispatchEvent(createDragEvent('drop', {
      dataTransfer: transfer,
      clientX: 110,
      clientY: 16,
    }));

    expect(commitLayout).not.toHaveBeenCalled();
    expect(root.hasAttribute('data-tab-drag-forbidden')).toBe(false);
  });
});
