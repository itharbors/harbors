// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { showModal } from '../panel.workbench/src/dialogs';
import definition from '../panel.workbench/src/index';

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

  it('exposes relationship tabs, controls, nodes, edges, and summaries accessibly', async () => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    const root = document.querySelector<HTMLDivElement>('#panel-root')!;
    const request = vi.fn(async (_plugin: string, name: string) => {
      if (name === 'getConnectionState') {
        return {
          connected: true,
          path: '/tmp/example.sqlite',
          fileName: 'example.sqlite',
          mode: 'readonly',
          sqliteVersion: '3.46.0',
        };
      }
      if (name === 'getSchema') {
        return {
          objects: [{
            name: 'users',
            kind: 'table',
            type: 'table',
            writable: true,
            sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY)',
          }],
        };
      }
      if (name === 'getRows') {
        return {
          name: 'users',
          page: 1,
          pageSize: 50,
          total: 0,
          writable: true,
          columns: ['id'],
          rows: [],
        };
      }
      if (name === 'getObjectSchema') {
        return {
          name: 'users',
          kind: 'table',
          type: 'table',
          writable: true,
          hasRowid: true,
          sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY)',
          primaryKey: ['id'],
          columns: [{
            name: 'id',
            type: 'INTEGER',
            notNull: false,
            primaryKeyOrder: 1,
            defaultValue: null,
            hidden: false,
            generated: false,
          }],
          indexes: [],
        };
      }
      if (name === 'getRelationshipGraph') {
        return {
          tables: [
            { name: 'users', kind: 'table', columns: [{ name: 'id', type: 'INTEGER', primaryKeyOrder: 1, foreignKey: false }] },
            { name: 'memberships', kind: 'table', columns: [{ name: 'user_id', type: 'INTEGER', primaryKeyOrder: 0, foreignKey: true }] },
          ],
          relationships: [{
            id: 'memberships:0',
            fromTable: 'memberships',
            toTable: 'users',
            columns: [{ from: 'user_id', to: 'id' }],
            onUpdate: 'NO ACTION',
            onDelete: 'CASCADE',
          }],
        };
      }
      throw new Error(`Unexpected request: ${name}`);
    });

    try {
      await definition.mount?.({ message: { request } } as never);
      root.querySelector<HTMLButtonElement>('[data-tab="relationships"]')!.click();
      await vi.waitFor(() => expect(root.querySelectorAll('[data-relationship-table]')).toHaveLength(2));

      const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      expect(tabs).toHaveLength(4);
      expect(tabs.find((tab) => tab.dataset.tab === 'relationships')?.tabIndex).toBe(0);
      expect(tabs.filter((tab) => tab.dataset.tab !== 'relationships').every((tab) => tab.tabIndex === -1)).toBe(true);
      for (const node of root.querySelectorAll<HTMLElement>('[data-relationship-table]')) {
        expect(node.getAttribute('role')).toBe('button');
        expect(node.tabIndex).toBe(0);
      }
      expect(root.querySelector('[aria-label="缩小关系图"]')).not.toBeNull();
      expect(root.querySelector('[aria-label="放大关系图"]')).not.toBeNull();
      expect(root.querySelector('[aria-label="适应窗口"]')).not.toBeNull();
      expect(root.querySelector('.relationship-edges')?.getAttribute('aria-hidden')).toBe('true');
      const summary = root.querySelector<HTMLElement>('[data-relationship-summary]')!;
      expect(summary.getAttribute('aria-hidden')).toBeNull();
      expect(summary.textContent).toContain('memberships.user_id → users.id');

      for (const expectedTab of ['sql', 'data', 'schema', 'relationships']) {
        const current = root.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
        current.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        await vi.waitFor(() => {
          const selected = root.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
          expect(selected.dataset.tab).toBe(expectedTab);
          expect(document.activeElement).toBe(selected);
        });
      }

      root.querySelector<HTMLButtonElement>('[data-tab="sql"]')!.click();
      await vi.waitFor(() => {
        const selected = root.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
        expect(selected.dataset.tab).toBe('sql');
        expect(document.activeElement).toBe(selected);
      });
    } finally {
      await definition.unmount?.();
      document.body.innerHTML = '';
    }
  });

  it('keeps live tab focus while relationship, data, and schema requests are pending', async () => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    const root = document.querySelector<HTMLDivElement>('#panel-root')!;
    let resolveGraph!: (result: unknown) => void;
    let resolveRows!: (result: unknown) => void;
    let resolveSchema!: (result: unknown) => void;
    let rowRequests = 0;
    const emptyRows = {
      name: 'users',
      page: 1,
      pageSize: 50,
      total: 0,
      writable: true,
      columns: ['id'],
      rows: [],
    };
    const userSchema = {
      name: 'users',
      kind: 'table',
      type: 'table',
      writable: true,
      hasRowid: true,
      sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY)',
      primaryKey: ['id'],
      columns: [{
        name: 'id',
        type: 'INTEGER',
        notNull: false,
        primaryKeyOrder: 1,
        defaultValue: null,
        hidden: false,
        generated: false,
      }],
      indexes: [],
    };
    const request = vi.fn(async (_plugin: string, name: string) => {
      if (name === 'getConnectionState') {
        return {
          connected: true,
          path: '/tmp/example.sqlite',
          fileName: 'example.sqlite',
          mode: 'readonly',
          sqliteVersion: '3.46.0',
        };
      }
      if (name === 'getSchema') {
        return {
          objects: [{
            name: 'users',
            kind: 'table',
            type: 'table',
            writable: true,
            sql: userSchema.sql,
          }],
        };
      }
      if (name === 'getRows') {
        rowRequests += 1;
        if (rowRequests === 1) return emptyRows;
        return new Promise((resolve) => { resolveRows = resolve; });
      }
      if (name === 'getObjectSchema') {
        return new Promise((resolve) => { resolveSchema = resolve; });
      }
      if (name === 'getRelationshipGraph') {
        return new Promise((resolve) => { resolveGraph = resolve; });
      }
      throw new Error(`Unexpected request: ${name}`);
    });

    try {
      await definition.mount?.({ message: { request } } as never);
      root.querySelector<HTMLButtonElement>('[data-tab="sql"]')!.click();
      await vi.waitFor(() => expect(document.activeElement)
        .toBe(root.querySelector('[data-tab="sql"]')));

      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
        '@itharbors/sqlite-workbench',
        'getRelationshipGraph',
      ));
      expect(document.activeElement).toBe(root.querySelector('[data-tab="relationships"]'));
      resolveGraph({ tables: [{ name: 'users', kind: 'table', columns: [] }], relationships: [] });
      await vi.waitFor(() => {
        expect(root.querySelectorAll('[data-relationship-table]')).toHaveLength(1);
        expect(document.activeElement).toBe(root.querySelector('[data-tab="relationships"]'));
      });

      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await vi.waitFor(() => expect(document.activeElement).toBe(root.querySelector('[data-tab="sql"]')));
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await vi.waitFor(() => expect(rowRequests).toBe(2));
      expect(document.activeElement).toBe(root.querySelector('[data-tab="data"]'));
      resolveRows({
        ...emptyRows,
        total: 1,
        columns: ['value'],
        rows: [{ values: ['fresh-row'], identity: null }],
      });
      await vi.waitFor(() => {
        expect(root.querySelector('[data-view="data"]')?.textContent).toContain('fresh-row');
        expect(document.activeElement).toBe(root.querySelector('[data-tab="data"]'));
      });

      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
        '@itharbors/sqlite-workbench',
        'getObjectSchema',
        { name: 'users' },
      ));
      expect(document.activeElement).toBe(root.querySelector('[data-tab="schema"]'));
      resolveSchema(userSchema);
      await vi.waitFor(() => {
        expect(root.querySelector('[data-view="schema"]')?.textContent).toContain('id');
        expect(document.activeElement).toBe(root.querySelector('[data-tab="schema"]'));
      });

      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await vi.waitFor(() => expect(document.activeElement)
        .toBe(root.querySelector('[data-tab="relationships"]')));
    } finally {
      await definition.unmount?.();
      document.body.innerHTML = '';
    }
  });

  it('preserves newer tab and non-tab focus when older tab requests finish', async () => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    const root = document.querySelector<HTMLDivElement>('#panel-root')!;
    let resolveGraph!: (result: unknown) => void;
    let resolveRows!: (result: unknown) => void;
    let resolveSchema!: (result: unknown) => void;
    let rowRequests = 0;
    const rows = {
      name: 'users',
      page: 1,
      pageSize: 50,
      total: 0,
      writable: true,
      columns: ['id'],
      rows: [],
    };
    const objectSchema = {
      name: 'users',
      kind: 'table',
      type: 'table',
      writable: true,
      hasRowid: true,
      sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY)',
      primaryKey: ['id'],
      columns: [{
        name: 'id',
        type: 'INTEGER',
        notNull: false,
        primaryKeyOrder: 1,
        defaultValue: null,
        hidden: false,
        generated: false,
      }],
      indexes: [],
    };
    const request = vi.fn(async (_plugin: string, name: string) => {
      if (name === 'getConnectionState') {
        return {
          connected: true,
          path: '/tmp/example.sqlite',
          fileName: 'example.sqlite',
          mode: 'readonly',
          sqliteVersion: '3.46.0',
        };
      }
      if (name === 'getSchema') {
        return {
          objects: [{
            name: 'users',
            kind: 'table',
            type: 'table',
            writable: true,
            sql: objectSchema.sql,
          }],
        };
      }
      if (name === 'getRows') {
        rowRequests += 1;
        if (rowRequests === 1) return rows;
        return new Promise((resolve) => { resolveRows = resolve; });
      }
      if (name === 'getObjectSchema') {
        return new Promise((resolve) => { resolveSchema = resolve; });
      }
      if (name === 'getRelationshipGraph') {
        return new Promise((resolve) => { resolveGraph = resolve; });
      }
      throw new Error(`Unexpected request: ${name}`);
    });

    const settleRequest = async (): Promise<void> => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    };

    try {
      await definition.mount?.({ message: { request } } as never);
      root.querySelector<HTMLButtonElement>('[data-tab="sql"]')!.click();
      await vi.waitFor(() => expect(document.activeElement).toBe(root.querySelector('[data-tab="sql"]')));

      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
        '@itharbors/sqlite-workbench',
        'getRelationshipGraph',
      ));
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await vi.waitFor(() => expect(document.activeElement).toBe(root.querySelector('[data-tab="sql"]')));
      resolveGraph({ tables: [{ name: 'stale', kind: 'table', columns: [] }], relationships: [] });
      await settleRequest();
      expect(root.querySelector('[data-view="sql"]')).not.toBeNull();
      expect(document.activeElement).toBe(root.querySelector('[data-tab="sql"]'));

      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await vi.waitFor(() => expect(rowRequests).toBe(2));
      root.querySelector<HTMLButtonElement>('[data-tab="sql"]')!.click();
      await vi.waitFor(() => expect(document.activeElement).toBe(root.querySelector('[data-tab="sql"]')));
      resolveRows(rows);
      await settleRequest();
      expect(root.querySelector('[data-view="sql"]')).not.toBeNull();
      expect(document.activeElement).toBe(root.querySelector('[data-tab="sql"]'));

      root.querySelector<HTMLButtonElement>('[data-tab="schema"]')!.click();
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
        '@itharbors/sqlite-workbench',
        'getObjectSchema',
        { name: 'users' },
      ));
      root.querySelector<HTMLButtonElement>('[data-tab="sql"]')!.click();
      await vi.waitFor(() => expect(document.activeElement).toBe(root.querySelector('[data-tab="sql"]')));
      const external = document.createElement('button');
      external.textContent = 'outside panel';
      document.body.append(external);
      external.focus();
      resolveSchema(objectSchema);
      await settleRequest();
      expect(root.querySelector('[data-view="sql"]')).not.toBeNull();
      expect(document.activeElement).toBe(external);
    } finally {
      await definition.unmount?.();
      document.body.innerHTML = '';
    }
  });

  it('keeps one enabled roving tab selected for an empty connected schema', async () => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    const root = document.querySelector<HTMLDivElement>('#panel-root')!;
    const request = vi.fn(async (_plugin: string, name: string) => {
      if (name === 'getConnectionState') {
        return {
          connected: true,
          path: '/tmp/empty.sqlite',
          fileName: 'empty.sqlite',
          mode: 'readonly',
          sqliteVersion: '3.46.0',
        };
      }
      if (name === 'getSchema') return { objects: [] };
      if (name === 'getRelationshipGraph') return { tables: [], relationships: [] };
      throw new Error(`Unexpected request: ${name}`);
    });

    try {
      await definition.mount?.({ message: { request } } as never);
      const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      const enabledRovingTabs = tabs.filter((tab) => !tab.disabled && tab.tabIndex === 0);
      const selectedTabs = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true');
      expect(enabledRovingTabs).toHaveLength(1);
      expect(selectedTabs).toHaveLength(1);
      expect(selectedTabs[0].disabled).toBe(false);
      expect(selectedTabs[0].dataset.tab).toBe('relationships');

      selectedTabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await vi.waitFor(() => expect(root.querySelector('[data-view="sql"]')).not.toBeNull());
      const nextSelected = root.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
      expect(nextSelected.dataset.tab).toBe('sql');
      expect(nextSelected.disabled).toBe(false);
      expect(nextSelected.tabIndex).toBe(0);
      expect(document.activeElement).toBe(nextSelected);

      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await vi.waitFor(() => {
        const chainedSelected = root.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
        expect(chainedSelected.dataset.tab).toBe('relationships');
        expect(document.activeElement).toBe(chainedSelected);
      });
    } finally {
      await definition.unmount?.();
      document.body.innerHTML = '';
    }
  });
});
