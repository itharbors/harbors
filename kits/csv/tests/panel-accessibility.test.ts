import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));
const panelRoots = [
  'plugins/csv-explorer/panel.connection',
  'plugins/csv-explorer/panel.explorer',
  'plugins/csv-data/panel.data',
  'plugins/csv-data/panel.schema',
];

function readBuilt(panelRoot: string, fileName: string): string {
  return fs.readFileSync(path.join(kitRoot, panelRoot, 'dist', fileName), 'utf8');
}

function decodeEscapedUnicode(value: string): string {
  return value.replace(/\\u([0-9a-f]{4})/giu, (_, codePoint: string) => (
    String.fromCodePoint(Number.parseInt(codePoint, 16))
  ));
}

describe('CSV built panel accessibility', () => {
  it.each(panelRoots)('%s ships a labelled document, visible focus, and reduced motion', (panelRoot) => {
    const html = readBuilt(panelRoot, 'index.html');
    const css = readBuilt(panelRoot, 'index.css');
    expect(html).toMatch(/<html\s+lang="zh-CN">/u);
    expect(html).toMatch(/<title>[^<]+<\/title>/u);
    expect(css).toContain(':focus-visible');
    expect(css).toMatch(/prefers-reduced-motion\s*:\s*reduce/u);
  });

  it('keeps visible labels, progress semantics, live status, and alerts in built panels', () => {
    const connection = decodeEscapedUnicode(readBuilt('plugins/csv-explorer/panel.connection', 'index.js'));
    const explorer = decodeEscapedUnicode(readBuilt('plugins/csv-explorer/panel.explorer', 'index.js'));
    const data = decodeEscapedUnicode(readBuilt('plugins/csv-data/panel.data', 'index.js'));
    const schema = decodeEscapedUnicode(readBuilt('plugins/csv-data/panel.schema', 'index.js'));

    for (const label of ['\u6587\u4ef6', '\u7f16\u7801', '\u5206\u9694\u7b26', '\u9996\u884c\u662f\u5b57\u6bb5\u540d']) {
      expect(connection).toContain(label);
    }
    for (const label of ['\u5feb\u901f\u641c\u7d22', '\u6bcf\u9875', '\u5b57\u6bb5', '\u6761\u4ef6', '\u503c', '\u8f93\u51fa\u8def\u5f84']) {
      expect(data).toContain(label);
    }
    expect(connection).toContain('role="progressbar"');
    expect(data).toContain('role="progressbar"');
    expect(connection).toContain('aria-live=\"polite\"');
    expect(data).toContain('aria-live=\"polite\"');
    for (const builtJavaScript of [connection, explorer, data, schema]) {
      expect(builtJavaScript).toContain('role="alert"');
    }
  });

  it('uses framework tabs and declares the real panel names and minimum widths', () => {
    const layout = JSON.parse(fs.readFileSync(path.join(kitRoot, 'layout.json'), 'utf8'));
    const tabGroup = layout.windows[0].layout.children[1].children[1];
    expect(tabGroup).toMatchObject({
      type: 'tab',
      activeIndex: 0,
      children: [
        { type: 'leaf', panel: '@itharbors/csv-data.data' },
        { type: 'leaf', panel: '@itharbors/csv-data.schema' },
      ],
    });

    const explorer = JSON.parse(fs.readFileSync(path.join(
      kitRoot,
      'plugins/csv-explorer/package.json',
    ), 'utf8'));
    const data = JSON.parse(fs.readFileSync(path.join(
      kitRoot,
      'plugins/csv-data/package.json',
    ), 'utf8'));
    expect(explorer['ce-editor'].contribute.panel).toMatchObject({
      connection: { title: 'CSV \u6587\u4ef6\u8fde\u63a5', minWidth: 320 },
      explorer: { title: 'CSV \u5b57\u6bb5', minWidth: 220 },
    });
    expect(data['ce-editor'].contribute.panel).toMatchObject({
      data: { title: 'CSV \u6570\u636e', minWidth: 480 },
      schema: { title: 'CSV \u7ed3\u6784', minWidth: 420 },
    });
  });

  it('ships keyboard controls for rows, cells, filters, fields, dialogs, and cancellation', () => {
    const connection = readBuilt('plugins/csv-explorer/panel.connection', 'index.js');
    const explorer = readBuilt('plugins/csv-explorer/panel.explorer', 'index.js');
    const data = readBuilt('plugins/csv-data/panel.data', 'index.js');
    const schema = readBuilt('plugins/csv-data/panel.schema', 'index.js');

    for (const key of ['Escape', 'Tab']) expect(connection).toContain(key);
    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter']) {
      expect(explorer).toContain(key);
      expect(schema).toContain(key);
      expect(data).toContain(key);
    }
    for (const key of ['ArrowLeft', 'ArrowRight', 'Escape', 'Tab']) expect(data).toContain(key);
    for (const action of [
      'open-filter',
      'apply-filter',
      'previous-page',
      'next-page',
      'cancel-export',
    ]) expect(data).toContain(action);
    expect(data).toContain('data-cell-row');
    expect(data).toContain('data-row-index');
    expect(data).toContain('role=\"dialog\"');
  });
});
