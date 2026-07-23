import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));

const panelStyles = [
  'plugins/sqlite-explorer/panel.connection/src/index.css',
  'plugins/sqlite-explorer/panel.explorer/src/index.css',
  'plugins/sqlite-data/panel.data/src/index.css',
  'plugins/sqlite-schema/panel.schema/src/index.css',
  'plugins/sqlite-relationships/panel.relationships/src/index.css',
  'plugins/sqlite-sql/panel.sql/src/index.css',
];

describe('SQLite split panel accessibility foundations', () => {
  it.each(panelStyles)('%s keeps visible focus and reduced-motion support', (relativePath) => {
    const css = fs.readFileSync(path.join(kitRoot, relativePath), 'utf8');
    expect(css).toContain(':focus-visible');
    expect(css).toMatch(/prefers-reduced-motion\s*:\s*reduce/);
  });

  it('uses framework tabs instead of reimplementing tab semantics in an iframe', () => {
    const layout = JSON.parse(fs.readFileSync(path.join(kitRoot, 'layout.json'), 'utf8'));
    const tabGroup = layout.windows[0].layout.children[1].children[1];
    expect(tabGroup.type).toBe('tab');
    expect(tabGroup.children).toHaveLength(4);
  });

  it('keeps the historical navigation tokens and structural selectors', () => {
    const connectionCss = fs.readFileSync(path.join(
      kitRoot,
      'plugins/sqlite-explorer/panel.connection/src/index.css',
    ), 'utf8');
    const explorerCss = fs.readFileSync(path.join(
      kitRoot,
      'plugins/sqlite-explorer/panel.explorer/src/index.css',
    ), 'utf8');

    for (const css of [connectionCss, explorerCss]) {
      expect(css).toMatch(/--ink:\s*#0b1116;/);
      expect(css).toMatch(/--grid-strong:\s*#374650;/);
      expect(css).toMatch(/--teal:\s*#57c8b5;/);
      expect(css).toContain('--mono: "IBM Plex Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace;');
    }
    expect(connectionCss).toContain('.brand-block');
    expect(connectionCss).toContain('.database-mark');
    expect(explorerCss).toContain('.rail-heading');
    expect(explorerCss).toContain('.object-item.active');
  });

  it('keeps the connection bar, modal, and object rail dimensions and layer order', () => {
    const connectionCss = fs.readFileSync(path.join(
      kitRoot,
      'plugins/sqlite-explorer/panel.connection/src/index.css',
    ), 'utf8');
    const explorerCss = fs.readFileSync(path.join(
      kitRoot,
      'plugins/sqlite-explorer/panel.explorer/src/index.css',
    ), 'utf8');

    expect(connectionCss).toMatch(/\.connection-bar\s*\{[\s\S]*?z-index:\s*4;[\s\S]*?grid-template-columns:\s*168px auto minmax\(340px, 1fr\);[\s\S]*?min-width:\s*760px;[\s\S]*?height:\s*100%;/);
    expect(connectionCss).toMatch(/\.modal-backdrop\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*20;/);
    expect(explorerCss).toMatch(/\.object-rail\s*\{[\s\S]*?height:\s*100%;[\s\S]*?border-right:\s*1px solid var\(--grid-strong\);/);
    expect(explorerCss).toMatch(/\.rail-heading\s*\{[\s\S]*?flex:\s*0 0 42px;[\s\S]*?height:\s*42px;/);
    expect(explorerCss).toMatch(/\.object-item\s*\{[\s\S]*?min-height:\s*34px;/);
  });
});
