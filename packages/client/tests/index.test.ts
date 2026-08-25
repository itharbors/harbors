import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('client main entry', () => {
  it('bootstraps the host mode before choosing the picker or editor', () => {
    const source = fs.readFileSync(path.resolve('src/index.ts'), 'utf-8');

    expect(source).toContain("import './components/editor-app';");
    expect(source).toContain("import './components/window-group-app';");
    expect(source).toContain("fetch('/api/kits'");
    expect(source).toContain("fetch('/api/workbench/context'");
    expect(source).toContain('selectStoredSession');
    expect(source).toContain('clearStoredSessionId');
    expect(source).toContain('onSessionCleared: clearSelectedSession');
    expect(source).toContain('isKitCatalogResponse');
    expect(source).toContain('selectHostEntry');
    expect(source).not.toContain('catalog.mode');
    expect(source).toContain('renderKitPicker');
    expect(source).toContain("'<editor-app></editor-app>'");
    expect(source).toContain('renderKitPickerError');
    expect(source).not.toContain("./pages/layout-kit");
    expect(source).not.toContain("./pages/ui-kit");
    expect(source).not.toContain("./pages/");
    expect(source).not.toMatch(/pages\s*\[/);
    expect(source).not.toContain("./ui/button");
  });

  it('declares the dark browser chrome color used by the host bootstrap', () => {
    const html = fs.readFileSync(path.resolve('index.html'), 'utf-8');

    expect(html).toContain('<meta name="theme-color" content="#111722">');
  });

  it('offsets the app below the top safe area on coarse landscape displays', () => {
    const html = fs.readFileSync(path.resolve('index.html'), 'utf-8');

    expect(html).toContain('--app-viewport-safe-top: 0px;');
    expect(html).toContain('@media (orientation: landscape) and (any-pointer: coarse)');
    expect(html).toContain('max(20px, env(safe-area-inset-top, 0px))');
    expect(html).toContain('box-sizing: border-box;');
    expect(html).toContain('padding-top: var(--app-viewport-safe-top);');
  });
});
