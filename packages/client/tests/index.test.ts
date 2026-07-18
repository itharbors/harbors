import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('client main entry', () => {
  it('mounts editor-app only and does not import example pages or common widgets', () => {
    const source = fs.readFileSync(path.resolve('src/index.ts'), 'utf-8');

    expect(source).toContain("import './components/editor-app';");
    expect(source).toContain("import './components/window-group-app';");
    expect(source).toContain('app.childElementCount === 0');
    expect(source).not.toContain("./pages/layout-kit");
    expect(source).not.toContain("./pages/ui-kit");
    expect(source).not.toContain("./pages/");
    expect(source).not.toMatch(/pages\s*\[/);
    expect(source).not.toContain("./ui/button");
  });
});
