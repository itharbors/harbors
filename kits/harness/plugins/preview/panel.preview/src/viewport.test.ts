import assert from 'node:assert/strict';
import test from 'node:test';

import { LONG_PRESS_MS, clampPan, clampViewportHeight, clampViewportWidth, isTapDistance, moveCursor, normalizeViewportState } from './viewport.ts';

test('clamps viewport dimensions and supplies stable defaults', () => {
  assert.equal(clampViewportWidth(10), 320);
  assert.equal(clampViewportWidth(9999), 3840);
  assert.equal(clampViewportHeight(10), 240);
  assert.equal(clampViewportHeight(9999), 2160);
  assert.deepEqual(normalizeViewportState(), {
    viewportWidth: 1280, viewportHeight: 720, interactionMode: 'direct',
    panX: 0, panY: 0, cursorX: 640, cursorY: 360,
  });
});

test('clamps pan and automatically pans at the 48px edge zone', () => {
  let state = normalizeViewportState({ viewportWidth: 1600, viewportHeight: 1000, cursorX: 750, cursorY: 450 });
  state = moveCursor(state, 30, 20, 800, 500);
  assert.equal(state.cursorX, 780);
  assert.equal(state.panX, 28);
  assert.equal(state.panY, 18);
  state = clampPan({ ...state, panX: 9999, panY: -20 }, 800, 500);
  assert.equal(state.panX, 800);
  assert.equal(state.panY, 0);
});

test('classifies tap distance and fixes long press at 550ms', () => {
  assert.equal(isTapDistance(8, 0), true);
  assert.equal(isTapDistance(8, 1), false);
  assert.equal(LONG_PRESS_MS, 550);
});
