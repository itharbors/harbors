export {};

import '../src/layout/split-pane';
import '../src/layout/divider';
import '../src/layout/panel';
import '../src/layout/panel-group';
import '../src/styles/tokens.css';
import { TabDragController } from '../src/layout/tab-drag-controller';
import {
  createEditorLayout,
  type EditorGroupNode,
  type EditorLayoutNode,
  type EditorPanelNode,
} from '../src/layout/tab-layout';
import type { LayoutNode, PanelDescriptor } from '../src/core/session';

const resizeStates = new WeakMap<Element, ResizeState>();
const dragDemoSessionId = 'layout-kit-demo-session';
const dragDemoWindowId = 'layout-kit-main';
const dragDemoPanelMap = new Map<string, PanelDescriptor>([
  ['@demo/files.files', { name: '@demo/files.files', entry: '' }],
  ['@demo/outline.outline', { name: '@demo/outline.outline', entry: '' }],
  ['@demo/editor.main', { name: '@demo/editor.main', entry: '' }],
  ['@demo/preview.preview', { name: '@demo/preview.preview', entry: '' }],
]);

class LayoutKitPage extends HTMLElement {
  private dragDemoLayout: EditorLayoutNode = createDragDemoLayout();
  private dragController: TabDragController | null = null;

  connectedCallback() {
    this.dragController?.destroy();
    this.dragDemoLayout = createDragDemoLayout();
    this.innerHTML = `
      <style>
        :host {
          display: block;
          min-height: 100vh;
          --ce-workbench-bg: #000;
          --ce-tabbar-bg: #202020;
          --ce-tab-bg-hover: #252526;
          --ce-tab-bg-active: #1a1a1a;
          --ce-tab-fg: #cccccc;
          --ce-tab-fg-active: #ffffff;
          --ce-tab-separator: #3a3a3a;
          --ce-tab-active-indicator: #569cd6;
          --ce-divider-color: #2a2a2a;
          --ce-divider-hover-color: #569cd6;
          --ce-divider-active-color: #7bb7e6;
          --ce-surface: #1a1a1a;
          --ce-surface-raised: #2d2d2d;
          --ce-border: #444;
          --ce-text-primary: #fff;
          --ce-text-secondary: #ccc;
          --ce-accent: #569cd6;
          background: var(--ce-workbench-bg);
          color: var(--ce-text-primary);
          font-family: system-ui, monospace;
        }
        * { box-sizing: border-box; }
        .page { display: flex; flex-direction: column; height: 100vh; min-width: 0; overflow: hidden; padding: 8px; gap: 8px; }
        h2 { font-size: 14px; font-weight: 600; margin: 0 0 8px; color: var(--ce-text-secondary); }
        .section { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; gap: 6px; }
        .label { font-size: 10px; color: #888; margin-bottom: 4px; }
        .code-preview {
          flex: 1;
          min-width: 0;
          min-height: 0;
          overflow: auto;
          padding: 12px;
          font-size: 12px;
          line-height: 1.7;
          color: #d4d4d4;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .tree, .list, .terminal, .outline {
          flex: 1;
          min-width: 0;
          min-height: 0;
          overflow: auto;
          padding: 10px;
          font-size: 12px;
          line-height: 1.8;
          color: #d4d4d4;
          overflow-wrap: anywhere;
        }
        .muted { color: #888; }
        .pill {
          display: inline-block;
          margin: 2px 4px 2px 0;
          padding: 1px 6px;
          border: 1px solid var(--ce-border);
          border-radius: 999px;
          color: var(--ce-text-secondary);
          font-size: 11px;
        }
        .status-strip {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          height: 100%;
          min-width: 0;
          overflow: hidden;
          padding: 0 10px;
          color: var(--ce-text-secondary);
          background: #202020;
          font-size: 12px;
          white-space: nowrap;
        }
        .drag-demo-host {
          display: flex;
          flex: 1;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
          border: 1px solid var(--ce-border);
        }
      </style>
      <div class="page">
        <div class="section">
          <h2>Layout Kit - nested split panes, panels, dividers, and tabs</h2>
          <div class="label">Complex IDE shell: Explorer | nested Workbench | Inspector</div>
          <ce-split-pane direction="row" style="flex:1; min-height:0;" data-example="ide-shell">
            <ce-panel-group style="--panel-min-size: 140px; flex: 0 0 240px;" data-panel="explorer">
              <ce-panel title="Files" active>
                  <div class="tree">
                    <div>itharbors</div>
                    <div class="muted">|-- packages</div>
                    <div class="muted">|   |-- client</div>
                    <div>|   |   |-- src</div>
                    <div>|   |   |   |-- layout</div>
                    <div>|   |   |   |-- ui</div>
                    <div>|   |   |   '-- pages</div>
                    <div class="muted">'-- docs</div>
                  </div>
              </ce-panel>
              <ce-panel title="Outline">
                  <div class="list">
                    <div>LayoutKitPage</div>
                    <div class="muted">refreshLayoutMinimums()</div>
                    <div class="muted">setupResizeHandlers()</div>
                    <div class="muted">normalizeLayoutFlex()</div>
                  </div>
              </ce-panel>
            </ce-panel-group>

            <ce-divider></ce-divider>

            <ce-split-pane direction="row" style="flex:1;" data-example="workbench-row">
              <ce-split-pane
                direction="column"
                style="flex: 1 1 520px; min-height:0; min-width:0;"
                data-panel="workbench"
                data-example="workbench-column"
              >
                  <ce-panel-group variant="document" style="flex: 0 0 360px;" data-panel="editor-tabs">
                      <ce-panel title="layout-kit.ts" active>
                        <div class="code-preview">class LayoutKitPage extends HTMLElement {
  connectedCallback() {
    this.innerHTML = 'nested layout demo';
    this.setupResizeHandlers();
  }
}</div>
                      </ce-panel>
                      <ce-panel title="split-pane.ts">
                        <div class="code-preview">export class SplitPane extends HTMLElement {
  static observedAttributes = ['direction'];
}</div>
                      </ce-panel>
                      <ce-panel title="panel.ts">
                        <div class="code-preview">&lt;ce-panel-group&gt; hosts related panels as tabs.&lt;/ce-panel-group&gt;</div>
                      </ce-panel>
                  </ce-panel-group>

                  <ce-divider></ce-divider>

                  <ce-split-pane direction="row" style="flex:1; min-height:0;" data-example="bottom-tools">
                    <ce-panel-group style="--panel-min-width: 140px; --panel-min-height: 60px; flex: 1 1 320px;" data-panel="terminal">
                        <ce-panel title="Terminal" active>
                          <div class="terminal">
                            <div>$ npm run test -w packages/client</div>
                            <div class="muted">18 files passed, 86 tests passed</div>
                            <div>$ npm run build -w packages/client</div>
                            <div class="muted">vite build complete</div>
                          </div>
                        </ce-panel>
                        <ce-panel title="Output">
                          <div class="terminal">
                            <div>[vite] connected</div>
                            <div class="muted">Layout normalized after drag end</div>
                            <div class="muted">Minimum sizes cached bottom-up</div>
                          </div>
                        </ce-panel>
                    </ce-panel-group>

                    <ce-divider></ce-divider>

                    <ce-panel-group style="--panel-min-width: 120px; --panel-min-height: 60px; flex: 1 1 220px;" data-panel="problems">
                        <ce-panel title="Problems" active>
                          <div class="list">
                            <div>No diagnostics</div>
                            <div class="muted">TypeScript: clean</div>
                            <div class="muted">Vitest: green</div>
                          </div>
                        </ce-panel>
                        <ce-panel title="Debug">
                          <div class="list">
                            <div>Breakpoints: 0</div>
                            <div class="muted">Watch expressions: empty</div>
                            <div class="muted">Call stack: idle</div>
                          </div>
                        </ce-panel>
                    </ce-panel-group>
                  </ce-split-pane>
                </ce-split-pane>

              <ce-divider data-resize-target="next" data-resize-min="140"></ce-divider>

              <ce-panel-group style="--panel-min-size: 140px; flex: 0 0 220px;" data-panel="inspector">
                  <ce-panel title="Inspect" active>
                    <div class="outline">
                      <div class="muted">Selected node</div>
                      <div>&lt;ce-panel-group data-panel="editor-tabs"&gt;</div>
                      <div style="margin-top:8px;">
                        <span class="pill">flex</span>
                        <span class="pill">slot</span>
                        <span class="pill">nested</span>
                      </div>
                      <div class="muted" style="margin-top:8px;">Terminal and Problems use shrinkable flex bases, so they scale when Inspector changes width.</div>
                    </div>
                  </ce-panel>
                  <ce-panel title="Styles">
                    <div class="outline">
                      <div>display: flex</div>
                      <div>flex-basis: normalized %</div>
                      <div>min-width: cached bottom-up</div>
                    </div>
                  </ce-panel>
              </ce-panel-group>
            </ce-split-pane>
          </ce-split-pane>
        </div>

        <div class="section" style="flex: 0.35;">
          <div class="label">Compact nested example: left panel | vertical stack inside right panel</div>
          <ce-split-pane direction="row" style="flex:1; min-height:0;" data-example="compact">
            <ce-panel-group style="--panel-min-size: 100px; flex: 0 0 180px;">
                <ce-panel title="Search" active>
                  <div class="list">
                    <div>query: component</div>
                    <div class="muted">button.ts</div>
                    <div class="muted">panel.ts</div>
                    <div class="muted">layout-kit.ts</div>
                  </div>
                </ce-panel>
                <ce-panel title="Files">
                  <div class="list">
                    <div>layout-kit.ts</div>
                    <div>panel.ts</div>
                    <div>tabs.ts</div>
                  </div>
                </ce-panel>
            </ce-panel-group>
            <ce-divider></ce-divider>
            <ce-panel>
              <span slot="header">Nested Right Panel</span>
              <ce-split-pane direction="column" style="flex:1; min-height:0;">
                <ce-panel style="flex: 0 0 70px;">
                  <span slot="header">Preview Header</span>
                  <div class="list">Toolbar, breadcrumb, and preview controls</div>
                </ce-panel>
                <ce-divider></ce-divider>
                <ce-panel style="--panel-min-size: 80px;">
                  <span slot="header">Preview Body</span>
                  <div class="list">This panel contains another split pane inside its light DOM slot.</div>
                </ce-panel>
              </ce-split-pane>
            </ce-panel>
          </ce-split-pane>
        </div>

        <div class="section" style="flex: 0.28;">
          <div class="label">Mixed runtime example: fixed simple status panel + iframe plugin panel</div>
          <ce-split-pane direction="column" style="flex:1; min-height:0;" data-example="simple-iframe-mixed">
            <ce-panel
              type="simple"
              style="--panel-min-height: 28px; --panel-min-width: 0; flex: 0 0 32px;"
              data-panel="simple-status"
            >
              <div class="status-strip">
                <span>Simple panel</span>
                <span class="muted">session: ready</span>
                <span class="muted">plugins: 3 enabled</span>
              </div>
            </ce-panel>

            <ce-panel
              title="Iframe Plugin"
              src="data:text/html,%3Cbody%20style%3D%22margin%3A0%3Bbackground%3A%231a1a1a%3Bcolor%3A%23d4d4d4%3Bfont%3A12px%20system-ui%3Bdisplay%3Aflex%3Bheight%3A100vh%3Balign-items%3Acenter%3Bjustify-content%3Acenter%3B%22%3EIframe%20plugin%20panel%3C%2Fbody%3E"
              style="--panel-min-height: 80px; --panel-min-width: 120px; flex: 1 1 160px;"
              data-panel="iframe-plugin"
            >
              <span slot="header">Iframe Plugin</span>
            </ce-panel>
          </ce-split-pane>
        </div>

        <div class="section" style="flex: 0.45;" data-example="tab-dnd-demo-section">
          <div class="label">Tab drag & drop demo: drag Files / Outline / Main / Preview tabs between groups or onto panel edges</div>
          <div class="drag-demo-host" data-example="tab-dnd-demo">
            ${this.renderDragDemoLayout()}
          </div>
        </div>
      </div>
    `;
    this.refreshLayoutMinimums();
    this.setupResizeHandlers();
    this.setupDragDemo();
  }

  disconnectedCallback() {
    this.dragController?.destroy();
    this.dragController = null;
  }

  private refreshLayoutMinimums() {
    this.querySelectorAll('ce-split-pane').forEach((splitPane) => {
      computeMinimum(splitPane as HTMLElement);
    });
  }

  private setupResizeHandlers() {
    this.querySelectorAll('ce-divider').forEach((divider) => {
      divider.addEventListener('ce-divider-drag-start', () => {
        resizeStates.delete(divider);
      });

      divider.addEventListener('ce-divider-resize', ((event: CustomEvent<{ delta: number }>) => {
        const splitPane = divider.parentElement as HTMLElement | null;
        if (!splitPane) return;

        const direction = splitPane.getAttribute('direction') === 'column' ? 'column' : 'row';
        const targetSide = divider.getAttribute('data-resize-target') === 'next' ? 'next' : 'previous';
        const targetPanel = targetSide === 'next'
          ? divider.nextElementSibling as HTMLElement | null
          : divider.previousElementSibling as HTMLElement | null;
        const pairedPanel = targetSide === 'next'
          ? divider.previousElementSibling as HTMLElement | null
          : divider.nextElementSibling as HTMLElement | null;
        if (!targetPanel || !pairedPanel) return;

        const state = getResizeState(divider, splitPane, targetPanel, pairedPanel, direction, targetSide);
        state.delta += targetSide === 'next' ? -event.detail.delta : event.detail.delta;
        const delta = state.delta;

        if (delta >= 0) {
          const hasMeasuredContainer = getElementSize(splitPane, direction) > 0;
          const availablePairedShrink = !hasMeasuredContainer && state.pairedBasis <= state.pairedMin
            ? delta
            : Math.max(0, state.pairedBasis - state.pairedMin);
          const maxSize = getMaxSize(splitPane, divider, targetPanel, direction);
          const availableTargetGrowth = Math.max(0, maxSize - state.basis);
          const localShrink = Math.min(delta, availablePairedShrink, availableTargetGrowth);
          const overflow = delta - localShrink;
          const cascadedSize = targetSide === 'next' && overflow > 0
            ? layoutPreviousAncestors(state.ancestorSnapshot, overflow)
            : 0;
          if (targetSide === 'next' && overflow <= 0) {
            layoutPreviousAncestors(state.ancestorSnapshot, 0);
          }

          targetPanel.style.flex = `0 1 ${state.basis + localShrink + cascadedSize}px`;
          pairedPanel.style.flex = `0 1 ${state.pairedBasis - localShrink}px`;
          layoutNestedSplitFromEdge(
            pairedPanel,
            direction,
            state.pairedBasis - localShrink,
            targetSide === 'previous' ? 'start' : 'end',
            state.nestedSnapshot,
          );
          return;
        }

        const pairedMaxSize = getMaxSize(splitPane, divider, pairedPanel, direction);
        const pairedGrowthLimit = Math.max(0, pairedMaxSize - state.pairedBasis);
        const targetShrink = Math.min(-delta, Math.max(0, state.basis - state.minSize), pairedGrowthLimit);
        if (targetSide === 'next') {
          layoutPreviousAncestors(state.ancestorSnapshot, 0);
        }
        targetPanel.style.flex = `0 1 ${state.basis - targetShrink}px`;
        pairedPanel.style.flex = `0 1 ${state.pairedBasis + targetShrink}px`;
        layoutNestedSplitFromEdge(
          pairedPanel,
          direction,
          state.pairedBasis + targetShrink,
          targetSide === 'previous' ? 'start' : 'end',
          state.nestedSnapshot,
        );
      }) as EventListener);

      divider.addEventListener('ce-divider-drag-end', () => {
        resizeStates.delete(divider);
        this.normalizeLayoutFlex();
      });
    });
  }

  private normalizeLayoutFlex() {
    this.querySelectorAll('ce-split-pane').forEach((splitPane) => {
      normalizeSplitPaneFlex(splitPane as HTMLElement);
    });
  }

  private setupDragDemo() {
    const root = this.querySelector('[data-example="tab-dnd-demo"]') as HTMLElement | null;
    if (!root) return;

    this.dragController = new TabDragController(root, {
      getLayout: () => this.dragDemoLayout,
      commitLayout: (layout) => {
        this.dragDemoLayout = layout;
        root.innerHTML = this.renderDragDemoLayout();
        this.refreshLayoutMinimums();
      },
    });
    this.dragController.bind();
  }

  private renderDragDemoLayout(): string {
    return this.renderDragDemoNode(this.dragDemoLayout);
  }

  private renderDragDemoNode(node: EditorLayoutNode, size?: number): string {
    if (node.kind === 'panel') {
      return this.renderDragDemoStaticPanel(node, renderSizeStyle(size));
    }
    if (node.kind === 'group') {
      return this.renderDragDemoGroup(node, renderSizeStyle(size));
    }

    return `
      <ce-split-pane direction="${node.direction}" style="${renderSizeStyle(size)}min-height:0;min-width:0;">
        ${node.children.map((child, index) => {
          const childHtml = this.renderDragDemoNode(child, node.sizes?.[index]);
          return index === 0 ? childHtml : `<ce-divider></ce-divider>${childHtml}`;
        }).join('')}
      </ce-split-pane>
    `;
  }

  private renderDragDemoGroup(group: EditorGroupNode, style: string): string {
    return `
      <ce-panel-group
        style="${style}"
        data-group-id="${escapeAttr(group.groupId)}"
        data-session-id="${escapeAttr(group.sessionId)}"
        data-window-id="${escapeAttr(group.windowId)}"
      >
        ${group.tabs.map((tab) => `
          <ce-panel
            title="${escapeAttr(tab.title)}"
            data-tab-id="${escapeAttr(tab.tabId)}"
            data-panel-name="${escapeAttr(tab.panelName)}"
            ${tab.tabId === group.activeTabId ? 'active ' : ''}
          >
            ${renderDragDemoPanelContent(tab.panelName)}
          </ce-panel>
        `).join('')}
      </ce-panel-group>
    `;
  }

  private renderDragDemoStaticPanel(node: EditorPanelNode, style: string): string {
    return `
      <ce-panel type="simple" chromeless data-panel-id="${escapeAttr(node.panelId)}" style="${style}">
        ${renderDragDemoPanelContent(node.panelName)}
      </ce-panel>
    `;
  }
}

function createDragDemoLayout(): EditorLayoutNode {
  const layout: LayoutNode = {
    type: 'hsplit',
    sizes: [220, 1],
    children: [
      {
        type: 'tab',
        activeIndex: 0,
        children: [
          { type: 'leaf', panel: '@demo/files.files' },
          { type: 'leaf', panel: '@demo/outline.outline' },
        ],
      },
      {
        type: 'tab',
        activeIndex: 0,
        children: [
          { type: 'leaf', panel: '@demo/editor.main' },
          { type: 'leaf', panel: '@demo/preview.preview' },
        ],
      },
    ],
  };

  return createEditorLayout(layout, dragDemoPanelMap, dragDemoSessionId, dragDemoWindowId);
}

function renderDragDemoPanelContent(panelName: string): string {
  if (panelName === '@demo/files.files') {
    return `
      <div class="tree">
        <div>Drag this Files tab to another tab strip.</div>
        <div class="muted">Try dropping on the left/right edge to split.</div>
      </div>
    `;
  }

  if (panelName === '@demo/outline.outline') {
    return `
      <div class="list">
        <div>Outline</div>
        <div class="muted">Tab insertion preview is shown in the target tab bar.</div>
        <div class="muted">Center panel drops are intentionally forbidden.</div>
      </div>
    `;
  }

  if (panelName === '@demo/editor.main') {
    return `
      <div class="code-preview">function demo() {
  return 'drag tabs between groups';
}</div>
    `;
  }

  return `
    <div class="list">
      <div>Preview</div>
      <div class="muted">Drop on top / bottom / left / right edge to create a split.</div>
    </div>
  `;
}

function renderSizeStyle(size?: number): string {
  if (size === undefined) return 'flex:1 1 0;min-height:0;min-width:0;';
  if (size <= 1) return `flex:${size} 1 0;min-height:0;min-width:0;`;
  return `flex:0 0 ${size}px;min-height:0;min-width:0;`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

if (!customElements.get('layout-kit-page')) {
  customElements.define('layout-kit-page', LayoutKitPage);
}

function getCurrentBasis(panel: HTMLElement, direction: 'row' | 'column'): number {
  const rect = panel.getBoundingClientRect();
  const measured = direction === 'column' ? rect.height : rect.width;
  if (measured > 0) return measured;

  const inlineBasis = parseFloat(panel.style.flexBasis);
  if (Number.isFinite(inlineBasis)) return inlineBasis;

  const flexMatch = panel.style.flex.match(/(\d+(?:\.\d+)?)px/);
  if (flexMatch) return Number(flexMatch[1]);
  return 120;
}

function getMinSize(panel: HTMLElement, direction: 'row' | 'column', override: string | null): number {
  const overrideValue = parseFloat(override || '');
  if (Number.isFinite(overrideValue)) return overrideValue;

  const cachedValue = parseFloat(panel.dataset[direction === 'column' ? 'minHeight' : 'minWidth'] || '');
  if (Number.isFinite(cachedValue)) return cachedValue;

  const styles = getComputedStyle(panel);
  const layoutValue = parseFloat(styles.getPropertyValue(direction === 'column' ? '--layout-min-height' : '--layout-min-width'));
  if (Number.isFinite(layoutValue)) return layoutValue;

  const axisVar = direction === 'column' ? '--panel-min-height' : '--panel-min-width';
  const axisValue = parseFloat(styles.getPropertyValue(axisVar));
  if (Number.isFinite(axisValue)) return axisValue;

  const sharedValue = parseFloat(styles.getPropertyValue('--panel-min-size'));
  if (Number.isFinite(sharedValue)) return sharedValue;

  const computedMin = parseFloat(direction === 'column' ? styles.minHeight : styles.minWidth);
  if (Number.isFinite(computedMin)) return computedMin;

  return 60;
}

function getMaxSize(splitPane: HTMLElement, divider: Element, targetPanel: HTMLElement, direction: 'row' | 'column'): number {
  const pairedPanel = targetPanel === divider.previousElementSibling
    ? divider.nextElementSibling as HTMLElement | null
    : divider.previousElementSibling as HTMLElement | null;
  if (!pairedPanel) return Number.POSITIVE_INFINITY;

  const containerSize = getElementSize(splitPane, direction);
  if (!Number.isFinite(containerSize) || containerSize <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  const pairedMin = getMinSize(pairedPanel, direction, null);
  const dividerSize = getElementSize(divider as HTMLElement, direction) || 4;
  return Math.max(getMinSize(targetPanel, direction, null), containerSize - pairedMin - dividerSize);
}

function layoutNestedSplitFromEdge(
  element: HTMLElement,
  direction: 'row' | 'column',
  targetSize: number,
  edge: 'start' | 'end',
  snapshot = snapshotNestedSplit(element, direction),
): number {
  if (targetSize <= 0 || snapshot.items.length === 0) {
    return 0;
  }

  const targetChildrenSize = Math.max(0, targetSize - snapshot.outerGap);
  const baselineSize = snapshot.items.reduce((sum, item) => sum + item.basis, 0);
  const orderedItems = edge === 'start' ? snapshot.items : [...snapshot.items].reverse();
  let remainingDelta = targetChildrenSize - baselineSize;

  snapshot.items.forEach((item) => {
    item.element.style.flex = `0 0 ${item.basis}px`;
  });

  if (remainingDelta === 0) {
    return 0;
  }

  for (const item of orderedItems) {
    const currentBasis = parseFlexPixelBasis(item.element.style.flex) ?? item.basis;

    if (remainingDelta < 0) {
      const nextBasis = Math.max(item.min, currentBasis + remainingDelta);
      remainingDelta += currentBasis - nextBasis;
      item.element.style.flex = `0 0 ${nextBasis}px`;
      if (remainingDelta >= 0) {
        break;
      }
      continue;
    }

    const nextBasis = currentBasis + remainingDelta;
    item.element.style.flex = `0 0 ${nextBasis}px`;
    remainingDelta = 0;
    break;
  }

  return Math.abs(targetChildrenSize - baselineSize - remainingDelta);
}

type ResizeState = {
  direction: 'row' | 'column';
  targetSide: 'previous' | 'next';
  basis: number;
  pairedBasis: number;
  minSize: number;
  pairedMin: number;
  delta: number;
  nestedSnapshot: NestedSplitSnapshot;
  ancestorSnapshot: AncestorSnapshot;
};

type AncestorSnapshot = Array<{
  current: HTMLElement;
  currentBasis: number;
  sibling: HTMLElement;
  siblingBasis: number;
  siblingMin: number;
}>;

type NestedSplitSnapshot = {
  items: Array<{
    element: HTMLElement;
    basis: number;
    min: number;
  }>;
  outerGap: number;
};

function snapshotNestedSplit(element: HTMLElement, direction: 'row' | 'column'): NestedSplitSnapshot {
  if (element.tagName.toLowerCase() !== 'ce-split-pane' || getDirection(element) !== direction) {
    return { items: [], outerGap: 0 };
  }

  const children = Array.from(element.children)
    .filter((child) => child.tagName.toLowerCase() !== 'ce-divider') as HTMLElement[];

  const items = children.map((child) => ({
    element: child,
    basis: getCurrentBasis(child, direction),
    min: getMinSize(child, direction, null),
  }));
  const childrenBasis = items.reduce((sum, item) => sum + item.basis, 0);
  const outerGap = Math.max(0, getCurrentBasis(element, direction) - childrenBasis);

  items.forEach((item) => {
    item.element.style.flex = `0 0 ${item.basis}px`;
  });

  return { items, outerGap };
}

function getResizeState(
  divider: Element,
  splitPane: HTMLElement,
  targetPanel: HTMLElement,
  pairedPanel: HTMLElement,
  direction: 'row' | 'column',
  targetSide: 'previous' | 'next',
): ResizeState {
  const existing = resizeStates.get(divider);
  if (existing?.direction === direction && existing.targetSide === targetSide) {
    return existing;
  }

  const state: ResizeState = {
    direction,
    targetSide,
    basis: getCurrentBasis(targetPanel, direction),
    pairedBasis: getCurrentBasis(pairedPanel, direction),
    minSize: getMinSize(targetPanel, direction, divider.getAttribute('data-resize-min')),
    pairedMin: getMinSize(pairedPanel, direction, null),
    delta: 0,
    nestedSnapshot: snapshotNestedSplit(pairedPanel, direction),
    ancestorSnapshot: snapshotPreviousAncestors(splitPane, direction),
  };
  resizeStates.set(divider, state);
  return state;
}

function parseFlexPixelBasis(value: string): number | null {
  const match = value.match(/(\d+(?:\.\d+)?)px/);
  return match ? Number(match[1]) : null;
}

function snapshotPreviousAncestors(splitPane: HTMLElement, direction: 'row' | 'column'): AncestorSnapshot {
  const snapshot: AncestorSnapshot = [];
  let current: HTMLElement = splitPane;
  let parent = current.parentElement;

  while (parent) {
    if (parent.tagName.toLowerCase() === 'ce-split-pane' && getDirection(parent) === direction) {
      const sibling = getPreviousResizableSibling(current);
      if (sibling) {
        snapshot.push({
          current,
          currentBasis: getCurrentBasis(current, direction),
          sibling,
          siblingBasis: getCurrentBasis(sibling, direction),
          siblingMin: getMinSize(sibling, direction, null),
        });
      }
    }

    current = parent;
    parent = parent.parentElement;
  }

  return snapshot;
}

function layoutPreviousAncestors(snapshot: AncestorSnapshot, amount: number): number {
  let remaining = Math.max(0, amount);
  let consumed = 0;

  snapshot.forEach((item) => {
    item.current.style.flex = `0 1 ${item.currentBasis}px`;
    item.sibling.style.flex = `0 1 ${item.siblingBasis}px`;
  });

  for (const item of snapshot) {
    if (remaining <= 0) {
      break;
    }

    const nextSiblingBasis = Math.max(item.siblingMin, item.siblingBasis - remaining);
    const shrink = item.siblingBasis - nextSiblingBasis;
    item.sibling.style.flex = `0 1 ${nextSiblingBasis}px`;
    item.current.style.flex = `0 1 ${item.currentBasis + shrink}px`;
    consumed += shrink;
    remaining -= shrink;
  }

  return consumed;
}

function getPreviousResizableSibling(element: HTMLElement): HTMLElement | null {
  let sibling = element.previousElementSibling as HTMLElement | null;
  while (sibling?.tagName.toLowerCase() === 'ce-divider') {
    sibling = sibling.previousElementSibling as HTMLElement | null;
  }
  return sibling;
}

function getDirection(splitPane: HTMLElement): 'row' | 'column' {
  return splitPane.getAttribute('direction') === 'column' ? 'column' : 'row';
}

function getElementSize(element: HTMLElement, direction: 'row' | 'column'): number {
  const rect = element.getBoundingClientRect();
  const measured = direction === 'column' ? rect.height : rect.width;
  if (measured > 0) return measured;

  const styles = getComputedStyle(element);
  const styled = parseFloat(direction === 'column' ? styles.height : styles.width);
  if (Number.isFinite(styled)) return styled;

  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeSplitPaneFlex(splitPane: HTMLElement) {
  const direction = getDirection(splitPane);
  const children = Array.from(splitPane.children)
    .filter((child) => child.tagName.toLowerCase() !== 'ce-divider') as HTMLElement[];
  if (children.length === 0) return;

  const sizes = children.map((child) => getElementSize(child, direction));
  if (sizes.some((size) => size <= 0)) return;

  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0) return;

  children.forEach((child, index) => {
    const percentage = (sizes[index] / total) * 100;
    child.style.flex = `0 1 ${formatPercent(percentage)}%`;
  });
}

function formatPercent(value: number): string {
  return Number(value.toFixed(4)).toString();
}

type Minimum = {
  width: number;
  height: number;
};

function computeMinimum(element: HTMLElement): Minimum {
  if (element.tagName.toLowerCase() === 'ce-split-pane') {
    return recordMinimum(element, computeSplitPaneMinimum(element));
  }

  if (element.tagName.toLowerCase() === 'ce-divider') {
    return { width: 4, height: 4 };
  }

  if (element.tagName.toLowerCase() === 'ce-panel') {
    return recordMinimum(element, computePanelMinimum(element));
  }

  if (element.tagName.toLowerCase() === 'ce-panel-group') {
    return recordMinimum(element, computePanelGroupMinimum(element));
  }

  return { width: 0, height: 0 };
}

function computeSplitPaneMinimum(splitPane: HTMLElement): Minimum {
  const direction = getDirection(splitPane);
  const childMinimums = Array.from(splitPane.children).map((child) => computeMinimum(child as HTMLElement));

  if (direction === 'row') {
    return {
      width: childMinimums.reduce((sum, minimum) => sum + minimum.width, 0),
      height: Math.max(0, ...childMinimums.map((minimum) => minimum.height)),
    };
  }

  return {
    width: Math.max(0, ...childMinimums.map((minimum) => minimum.width)),
    height: childMinimums.reduce((sum, minimum) => sum + minimum.height, 0),
  };
}

function computePanelMinimum(panel: HTMLElement): Minimum {
  const own = getDeclaredPanelMinimum(panel);
  const nestedMinimums = Array.from(panel.children)
    .filter((child) => child.tagName.toLowerCase() === 'ce-split-pane')
    .map((child) => computeMinimum(child as HTMLElement));

  if (nestedMinimums.length === 0) {
    return own;
  }

  return {
    width: Math.max(own.width, ...nestedMinimums.map((minimum) => minimum.width)),
    height: Math.max(own.height, ...nestedMinimums.map((minimum) => minimum.height)),
  };
}

function computePanelGroupMinimum(group: HTMLElement): Minimum {
  const own = getDeclaredPanelMinimum(group);
  const panelMinimums = Array.from(group.children)
    .filter((child) => child.tagName.toLowerCase() === 'ce-panel')
    .map((child) => computeMinimum(child as HTMLElement));

  if (panelMinimums.length === 0) {
    return own;
  }

  return {
    width: Math.max(own.width, ...panelMinimums.map((minimum) => minimum.width)),
    height: Math.max(own.height, ...panelMinimums.map((minimum) => minimum.height)),
  };
}

function getDeclaredPanelMinimum(panel: HTMLElement): Minimum {
  const styles = getComputedStyle(panel);
  const shared = readSizeToken(panel, styles, '--panel-min-size', 100);
  return {
    width: readSizeToken(panel, styles, '--panel-min-width', shared),
    height: readSizeToken(panel, styles, '--panel-min-height', shared),
  };
}

function readSizeToken(element: HTMLElement, styles: CSSStyleDeclaration, name: string, fallback: number): number {
  const inlineValue = parseFloat(element.style.getPropertyValue(name));
  if (Number.isFinite(inlineValue)) return inlineValue;

  const computedValue = parseFloat(styles.getPropertyValue(name));
  if (Number.isFinite(computedValue)) return computedValue;

  return fallback;
}

function recordMinimum(element: HTMLElement, minimum: Minimum): Minimum {
  const width = Math.ceil(minimum.width);
  const height = Math.ceil(minimum.height);
  element.dataset.minWidth = String(width);
  element.dataset.minHeight = String(height);
  element.style.setProperty('--layout-min-width', `${width}px`);
  element.style.setProperty('--layout-min-height', `${height}px`);

  if (element.tagName.toLowerCase() === 'ce-split-pane') {
    element.style.minWidth = `${width}px`;
    element.style.minHeight = `${height}px`;
  }

  return { width, height };
}
