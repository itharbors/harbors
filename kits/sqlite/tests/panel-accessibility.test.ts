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
});
