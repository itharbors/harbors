export const DEFAULT_VIEWPORT_WIDTH = 1280;
export const DEFAULT_VIEWPORT_HEIGHT = 720;
export const MIN_VIEWPORT_WIDTH = 320;
export const MAX_VIEWPORT_WIDTH = 3840;
export const MIN_VIEWPORT_HEIGHT = 240;
export const MAX_VIEWPORT_HEIGHT = 2160;
export const EDGE_ZONE = 48;
export const TAP_DISTANCE = 8;
export const LONG_PRESS_MS = 550;

export interface ViewportState {
  viewportWidth: number;
  viewportHeight: number;
  interactionMode: 'direct' | 'virtual';
  panX: number;
  panY: number;
  cursorX: number;
  cursorY: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function clampViewportWidth(value: number): number {
  return clamp(Math.round(Number.isFinite(value) ? value : DEFAULT_VIEWPORT_WIDTH), MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH);
}

export function clampViewportHeight(value: number): number {
  return clamp(Math.round(Number.isFinite(value) ? value : DEFAULT_VIEWPORT_HEIGHT), MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT);
}

export function normalizeViewportState(value: Partial<ViewportState> = {}): ViewportState {
  const viewportWidth = clampViewportWidth(value.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH);
  const viewportHeight = clampViewportHeight(value.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT);
  return {
    viewportWidth,
    viewportHeight,
    interactionMode: value.interactionMode === 'virtual' ? 'virtual' : 'direct',
    panX: Math.max(0, Math.round(Number.isFinite(value.panX) ? value.panX! : 0)),
    panY: Math.max(0, Math.round(Number.isFinite(value.panY) ? value.panY! : 0)),
    cursorX: clamp(Math.round(Number.isFinite(value.cursorX) ? value.cursorX! : viewportWidth / 2), 0, viewportWidth - 1),
    cursorY: clamp(Math.round(Number.isFinite(value.cursorY) ? value.cursorY! : viewportHeight / 2), 0, viewportHeight - 1),
  };
}

export function clampPan(state: ViewportState, clientWidth: number, clientHeight: number): ViewportState {
  const maxX = Math.max(0, state.viewportWidth - Math.max(0, Math.floor(clientWidth)));
  const maxY = Math.max(0, state.viewportHeight - Math.max(0, Math.floor(clientHeight)));
  return { ...state, panX: clamp(state.panX, 0, maxX), panY: clamp(state.panY, 0, maxY) };
}

export function moveCursor(
  state: ViewportState,
  deltaX: number,
  deltaY: number,
  clientWidth: number,
  clientHeight: number,
): ViewportState {
  const cursorX = clamp(Math.round(state.cursorX + deltaX), 0, state.viewportWidth - 1);
  const cursorY = clamp(Math.round(state.cursorY + deltaY), 0, state.viewportHeight - 1);
  let panX = state.panX;
  let panY = state.panY;
  const width = Math.max(0, Math.floor(clientWidth));
  const height = Math.max(0, Math.floor(clientHeight));
  if (state.viewportWidth > width) {
    if (cursorX - panX < EDGE_ZONE) panX = cursorX - EDGE_ZONE;
    else if (cursorX - panX > width - EDGE_ZONE) panX = cursorX - width + EDGE_ZONE;
  }
  if (state.viewportHeight > height) {
    if (cursorY - panY < EDGE_ZONE) panY = cursorY - EDGE_ZONE;
    else if (cursorY - panY > height - EDGE_ZONE) panY = cursorY - height + EDGE_ZONE;
  }
  return clampPan({ ...state, cursorX, cursorY, panX, panY }, width, height);
}

export function isTapDistance(deltaX: number, deltaY: number): boolean {
  return Math.hypot(deltaX, deltaY) <= TAP_DISTANCE;
}
