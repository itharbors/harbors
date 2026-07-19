// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { showModal } from '../panel.workbench/src/dialogs';

const cssPath = path.resolve(process.cwd(), 'plugins/sqlite-workbench/panel.workbench/src/index.css');

describe('SQLite workbench accessibility foundations', () => {
  it('defines readable type, visible focus, responsive, and reduced-motion rules', () => {
    const css = fs.readFileSync(cssPath, 'utf8');
    expect(css).toMatch(/--font-body:\s*12px/);
    expect(css).toMatch(/--font-secondary:\s*11px/);
    expect(css).toContain(':focus-visible');
    expect(css).toContain('@media (max-width: 1180px)');
    expect(css).toContain('@media (max-width: 880px)');
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toContain('prefers-reduced-motion: reduce');
  });

  it('keeps object headings consistent and the data toolbar on two non-wrapping rows', () => {
    const css = fs.readFileSync(cssPath, 'utf8');
    expect(css).toContain('.object-group-title');
    expect(css).toContain('.object-group > summary::-webkit-details-marker');
    expect(css).toMatch(/\.data-view\s*\{[^}]*grid-template-rows:\s*80px/s);
    expect(css).toMatch(/\.data-toolbar\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*repeat\(2,/s);
    expect(css).toMatch(/\.data-toolbar-row\s*\{[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(/\.data-toolbar-row\s*>\s*\*\s*\{[^}]*flex-shrink:\s*0/s);
    expect(css).toMatch(/\.data-toolbar-row\s+button\s*\{[^}]*white-space:\s*nowrap/s);
  });

  it('hides the closed narrow drawer from visibility and pointer interaction', () => {
    const css = fs.readFileSync(cssPath, 'utf8');
    const narrowRules = css.slice(css.indexOf('@media (max-width: 720px)'));
    expect(narrowRules).toMatch(/\.object-rail\s*\{[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none/s);
    expect(narrowRules).toMatch(/\.object-rail\[data-open="true"\]\s*\{[^}]*visibility:\s*visible[^}]*pointer-events:\s*auto/s);
  });

  it('loops keyboard focus inside a modal dialog', () => {
    HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
    const dialog = document.createElement('dialog');
    const first = document.createElement('button');
    const last = document.createElement('button');
    dialog.append(first, last);
    document.body.append(dialog);
    showModal(dialog, first);
    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(last);
  });

  it('coordinates Escape cancellation and restores focus to the opener', async () => {
    HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
    const opener = document.createElement('button');
    const dialog = document.createElement('dialog');
    const first = document.createElement('button');
    dialog.append(first);
    document.body.append(opener, dialog);
    opener.focus();
    let cancelled = false;
    showModal(dialog, first, () => {
      cancelled = true;
      dialog.remove();
    });
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    await Promise.resolve();
    expect(cancelled).toBe(true);
    expect(document.activeElement).toBe(opener);
  });
});
