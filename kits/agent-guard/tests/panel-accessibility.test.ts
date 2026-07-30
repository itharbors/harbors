import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const panelRoot = path.resolve(__dirname, '../plugins/agent-guard-center/panel.guard/src');

describe('Agent Guard panel accessibility', () => {
  it('has a locked local document, semantic status, keyboard focus, and reduced motion', () => {
    const html = fs.readFileSync(path.join(panelRoot, 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(panelRoot, 'index.css'), 'utf8');
    expect(html).toMatch(/Content-Security-Policy/iu);
    expect(html).toMatch(/default-src 'none'/u);
    expect(html).toMatch(/<main[^>]+id="guard-root"/iu);
    expect(`${html}\n${css}`).not.toMatch(/https?:\/\//iu);
    expect(css).toMatch(/:focus-visible/u);
    expect(css).toMatch(/prefers-reduced-motion/u);
  });
});
