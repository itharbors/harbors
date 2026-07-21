import { describe, expect, it } from 'vitest';
import { createPanelAssetUrl, encodePanelAssetPath } from '../../src/panel/runtime-assets';

describe('createPanelAssetUrl', () => {
  it('creates plugin-owned asset URLs for the current panel session', () => {
    expect(createPanelAssetUrl('@itharbors/scene-viewport', 'session 1', '/models/cube model.glb')).toBe(
      '/api/assets/plugin/%40itharbors%2Fscene-viewport/models/cube%20model.glb?sessionId=session%201',
    );
  });
});

describe('encodePanelAssetPath', () => {
  it('encodes each relative path segment without encoding path separators', () => {
    expect(encodePanelAssetPath('/icons/ui/empty scene+#1.svg')).toBe('icons/ui/empty%20scene%2B%231.svg');
  });
});
