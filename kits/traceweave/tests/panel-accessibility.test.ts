import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('TraceWeave panel document', () => {
  it('declares language, title, root and module entry', () => {
    const html = fs.readFileSync(path.resolve('plugins/traceweave-view/panel.trace/src/index.html'), 'utf8');
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toContain('<title>TraceWeave</title>');
    expect(html).toContain('id="traceweave-root"');
    expect(html).toContain('type="module" src="./index.js"');
  });
});
