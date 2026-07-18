type Direction = 'row' | 'column';
type TargetSide = 'previous' | 'next';

const resizeStates = new WeakMap<Element, ResizeState>();
const boundDividers = new WeakSet<Element>();

export function bindResizableSplitPanes(root: ParentNode) {
  root.querySelectorAll('ce-split-pane').forEach((splitPane) => {
    computeMinimum(splitPane as HTMLElement);
  });

  root.querySelectorAll('ce-divider').forEach((divider) => {
    if (boundDividers.has(divider)) return;
    boundDividers.add(divider);

    divider.addEventListener('ce-divider-drag-start', () => {
      resizeStates.delete(divider);
    });

    divider.addEventListener('ce-divider-resize', ((event: CustomEvent<{ delta: number }>) => {
      const splitPane = divider.parentElement as HTMLElement | null;
      if (!splitPane || splitPane.tagName.toLowerCase() !== 'ce-split-pane') return;

      const direction = getDirection(splitPane);
      const targetSide = divider.getAttribute('data-resize-target') === 'next' ? 'next' : 'previous';
      const targetPanel = targetSide === 'next'
        ? getNextResizableSibling(divider)
        : getPreviousResizableSibling(divider);
      const pairedPanel = targetSide === 'next'
        ? getPreviousResizableSibling(divider)
        : getNextResizableSibling(divider);
      if (!targetPanel || !pairedPanel) return;

      resizePanels({
        divider,
        splitPane,
        targetPanel,
        pairedPanel,
        direction,
        targetSide,
        delta: event.detail.delta,
      });
    }) as EventListener);

    divider.addEventListener('ce-divider-drag-end', () => {
      resizeStates.delete(divider);
      normalizeLayoutFlex(root);
    });
  });
}

function resizePanels(options: {
  divider: Element;
  splitPane: HTMLElement;
  targetPanel: HTMLElement;
  pairedPanel: HTMLElement;
  direction: Direction;
  targetSide: TargetSide;
  delta: number;
}) {
  const {
    divider,
    splitPane,
    targetPanel,
    pairedPanel,
    direction,
    targetSide,
  } = options;
  const state = getResizeState(divider, splitPane, targetPanel, pairedPanel, direction, targetSide);
  state.delta += targetSide === 'next' ? -options.delta : options.delta;
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
}

function getCurrentBasis(panel: HTMLElement, direction: Direction): number {
  const rect = panel.getBoundingClientRect();
  const measured = direction === 'column' ? rect.height : rect.width;
  if (measured > 0) return measured;

  const inlineBasis = parseFloat(panel.style.flexBasis);
  if (Number.isFinite(inlineBasis)) return inlineBasis;

  const flexMatch = panel.style.flex.match(/(\d+(?:\.\d+)?)px/);
  if (flexMatch) return Number(flexMatch[1]);
  return 120;
}

function getMinSize(panel: HTMLElement, direction: Direction, override: string | null): number {
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

function getMaxSize(splitPane: HTMLElement, divider: Element, targetPanel: HTMLElement, direction: Direction): number {
  const pairedPanel = targetPanel === getPreviousResizableSibling(divider)
    ? getNextResizableSibling(divider)
    : getPreviousResizableSibling(divider);
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
  direction: Direction,
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
      if (remainingDelta >= 0) break;
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
  direction: Direction;
  targetSide: TargetSide;
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

function snapshotNestedSplit(element: HTMLElement, direction: Direction): NestedSplitSnapshot {
  if (element.tagName.toLowerCase() !== 'ce-split-pane' || getDirection(element) !== direction) {
    return { items: [], outerGap: 0 };
  }

  const children = getResizableChildren(element);

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
  direction: Direction,
  targetSide: TargetSide,
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

function snapshotPreviousAncestors(splitPane: HTMLElement, direction: Direction): AncestorSnapshot {
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
    if (remaining <= 0) break;

    const nextSiblingBasis = Math.max(item.siblingMin, item.siblingBasis - remaining);
    const shrink = item.siblingBasis - nextSiblingBasis;
    item.sibling.style.flex = `0 1 ${nextSiblingBasis}px`;
    item.current.style.flex = `0 1 ${item.currentBasis + shrink}px`;
    consumed += shrink;
    remaining -= shrink;
  }

  return consumed;
}

function getPreviousResizableSibling(element: Element): HTMLElement | null {
  let sibling = element.previousElementSibling as HTMLElement | null;
  while (sibling?.tagName.toLowerCase() === 'ce-divider') {
    sibling = sibling.previousElementSibling as HTMLElement | null;
  }
  return sibling;
}

function getNextResizableSibling(element: Element): HTMLElement | null {
  let sibling = element.nextElementSibling as HTMLElement | null;
  while (sibling?.tagName.toLowerCase() === 'ce-divider') {
    sibling = sibling.nextElementSibling as HTMLElement | null;
  }
  return sibling;
}

function getResizableChildren(splitPane: HTMLElement): HTMLElement[] {
  return Array.from(splitPane.children)
    .filter((child) => child.tagName.toLowerCase() !== 'ce-divider') as HTMLElement[];
}

function getDirection(splitPane: HTMLElement): Direction {
  return splitPane.getAttribute('direction') === 'column' ? 'column' : 'row';
}

function getElementSize(element: HTMLElement, direction: Direction): number {
  const rect = element.getBoundingClientRect();
  const measured = direction === 'column' ? rect.height : rect.width;
  if (measured > 0) return measured;

  const styles = getComputedStyle(element);
  const styled = parseFloat(direction === 'column' ? styles.height : styles.width);
  if (Number.isFinite(styled)) return styled;

  return 0;
}

function normalizeLayoutFlex(root: ParentNode) {
  root.querySelectorAll('ce-split-pane').forEach((splitPane) => {
    normalizeSplitPaneFlex(splitPane as HTMLElement);
  });
}

function normalizeSplitPaneFlex(splitPane: HTMLElement) {
  const direction = getDirection(splitPane);
  const children = getResizableChildren(splitPane);
  if (children.length === 0) return;

  const sizes = children.map((child) => getElementSize(child, direction));
  if (sizes.some((size) => size <= 0)) return;

  const fixedTotal = children.reduce((sum, child, index) => {
    return sum + (isFixedLayoutItem(child) ? sizes[index] : 0);
  }, 0);
  const flexibleChildren = children.filter((child) => !isFixedLayoutItem(child));
  const flexibleTotal = children.reduce((sum, child, index) => {
    return sum + (isFixedLayoutItem(child) ? 0 : sizes[index]);
  }, 0);

  if (flexibleChildren.length === 0 || flexibleTotal <= 0) {
    children.forEach((child, index) => {
      if (isFixedLayoutItem(child)) {
        child.style.flex = `0 0 ${sizes[index]}px`;
      }
    });
    return;
  }

  children.forEach((child, index) => {
    if (isFixedLayoutItem(child)) {
      child.style.flex = `0 0 ${sizes[index]}px`;
      return;
    }

    const percentage = (sizes[index] / flexibleTotal) * 100;
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
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'ce-split-pane') {
    return recordMinimum(element, computeSplitPaneMinimum(element));
  }

  if (tagName === 'ce-divider') {
    return { width: 4, height: 4 };
  }

  if (tagName === 'ce-panel' || tagName === 'ce-panel-group' || tagName === 'ce-tabs') {
    return recordMinimum(element, computeContainerMinimum(element));
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

function computeContainerMinimum(container: HTMLElement): Minimum {
  const own = getDeclaredMinimum(container);
  const nestedMinimums = Array.from(container.children)
    .filter((child) => ['ce-split-pane', 'ce-panel', 'ce-tab'].includes(child.tagName.toLowerCase()))
    .map((child) => computeMinimum(child as HTMLElement));

  if (nestedMinimums.length === 0) {
    return own;
  }

  return {
    width: Math.max(own.width, ...nestedMinimums.map((minimum) => minimum.width)),
    height: Math.max(own.height, ...nestedMinimums.map((minimum) => minimum.height)),
  };
}

function getDeclaredMinimum(element: HTMLElement): Minimum {
  if (isSimplePanel(element)) {
    return { width: 0, height: 0 };
  }

  const styles = getComputedStyle(element);
  const shared = readSizeToken(element, styles, '--panel-min-size', 60);
  return {
    width: readSizeToken(element, styles, '--panel-min-width', shared),
    height: readSizeToken(element, styles, '--panel-min-height', shared),
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

function isSimplePanel(element: HTMLElement): boolean {
  return element.tagName.toLowerCase() === 'ce-panel' && element.getAttribute('type') === 'simple';
}

function isFixedLayoutItem(element: HTMLElement): boolean {
  return element.dataset.layoutFixed === 'true';
}
