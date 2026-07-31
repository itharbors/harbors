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

  it('allows the Harbors host to run its injected panel bridge', () => {
    expect(readCspDirectives().get('script-src')).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('allows the Harbors host to apply negotiated theme tokens', () => {
    expect(readCspDirectives().get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('allows the panel bridge to request snapshots only from the local host', () => {
    expect(readCspDirectives().get('connect-src')).toEqual(["'self'"]);
  });
});

function readCspDirectives(): Map<string, string[]> {
  const html = fs.readFileSync(path.join(panelRoot, 'index.html'), 'utf8');
  const content = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/iu)?.[1];
  return new Map((content ?? '').split(';').map((directive) => {
    const [name, ...values] = directive.trim().split(/\s+/u);
    return [name, values];
  }));
}
