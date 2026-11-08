import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('window entry safe area', () => {
  for (const entry of ['main.html', 'secondary.html']) {
    it(`${entry} uses the device inset without a forced landscape minimum`, () => {
      const html = readFileSync(new URL(`../${entry}`, import.meta.url), 'utf8');
      expect(html).toContain('--kit-viewport-safe-top: env(safe-area-inset-top, 0px);');
      expect(html).toContain('padding-top: var(--kit-viewport-safe-top);');
      expect(html).not.toContain('max(20px, env(safe-area-inset-top');
      expect(html).toContain('window.visualViewport');
    });
  }
});
