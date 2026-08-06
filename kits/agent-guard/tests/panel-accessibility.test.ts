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
    expect(css).not.toMatch(/\.confidence-probable[^}]*warning-amber/su);
    expect(css).toMatch(/overflow-wrap:\s*anywhere/u);
  });

  it('sizes the host, contains horizontal overflow, and exposes accessible Tab styling', () => {
    const css = fs.readFileSync(path.join(panelRoot, 'index.css'), 'utf8');
    expect(css).toMatch(/html,\s*body,\s*#guard-root\s*\{[^}]*height:\s*100%/su);
    expect(css).toMatch(/body\s*\{[^}]*overflow:\s*hidden/su);
    expect(css).toMatch(/\.dashboard-tab\[role="tab"\]\[aria-selected="true"\]/u);
    expect(css).toMatch(/\.dashboard-tab\[role="tab"\]:focus-visible/u);
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)/u);
  });

  it('locks page scrolling while each active workspace panel owns its overflow', () => {
    const css = fs.readFileSync(path.join(panelRoot, 'index.css'), 'utf8');
    expect(css).toMatch(/html,\s*body,\s*#guard-root\s*\{[^}]*height:\s*100%/su);
    expect(css).toMatch(/body\s*\{[^}]*overflow:\s*hidden/su);
    expect(css).toMatch(/\.guard-workspace\s*\{[^}]*height:\s*100dvh[^}]*grid-template-rows:\s*auto auto minmax\(0,\s*1fr\)/su);
    expect(css).toMatch(/\.dashboard-content\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/su);
    expect(css).toMatch(/#incidents-panel[^}]*overflow-y:\s*auto/su);
    expect(css).toMatch(/#settings-panel[^}]*overflow-y:\s*auto/su);
    expect(css).toMatch(/@media\s*\(max-height:\s*679px\)/u);
  });

  it('gives a 320px-wide overview an internal vertical scroll fallback', () => {
    const css = fs.readFileSync(path.join(panelRoot, 'index.css'), 'utf8');
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)\s*\{[^}]*\.dashboard-content\s*\{[^}]*overflow-y:\s*auto/su);
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?#overview-panel\s*\{[^}]*height:\s*auto[^}]*grid-template-rows:\s*none/su);
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.history-deck\s*\{[^}]*overflow:\s*visible/su);
  });

  it('reserves the active panel row after an inline operation error', () => {
    const css = fs.readFileSync(path.join(panelRoot, 'index.css'), 'utf8');
    expect(css).toMatch(/\.dashboard-content\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/su);
    expect(css).toMatch(/#overview-panel\s*\{[^}]*min-height:\s*0[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/su);
    expect(css).toMatch(/\.history-deck\s*\{[^}]*grid-template-rows:\s*auto auto auto minmax\(110px,\s*1fr\)/su);
  });

  it('places every normal-state active panel in the remaining-height grid row', () => {
    const css = fs.readFileSync(path.join(panelRoot, 'index.css'), 'utf8');
    for (const panel of ['overview', 'incidents', 'settings']) {
      expect(css).toMatch(new RegExp(`#${panel}-panel[^}]*grid-row:\\s*2`, 'su'));
    }
  });

  it('keeps the backfill progress rail contained and animation-free under reduced motion', () => {
    const css = fs.readFileSync(path.join(panelRoot, 'index.css'), 'utf8');
    expect(css).toMatch(/\.backfill-progress[^}]*overflow-wrap:\s*anywhere/su);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?progress[^}]*animation:\s*none/su);
  });

  it('gives the HTML history axis explicit compact monospace type and frost color', () => {
    const css = fs.readFileSync(path.join(panelRoot, 'index.css'), 'utf8');
    for (const selector of ['\\.history-axis-tick', '\\.history-axis-title']) {
      expect(css).toMatch(new RegExp(`${selector}\\s*\\{[^}]*color:\\s*var\\(--frost-300\\)`, 'su'));
      expect(css).toMatch(new RegExp(`${selector}\\s*\\{[^}]*font:[^}]*(?:"SF Mono"|ui-monospace|monospace)`, 'su'));
    }
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
