import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyThemeToDocument, BASE_UI_THEME_STYLE_ID, THEME_TOKEN_STYLE_ID } from '../../src/styles/iframe-theme';
import { DEFAULT_THEME_TOKENS, renderThemeVariables } from '../../src/styles/theme';

describe('DEFAULT_THEME_TOKENS', () => {
  it('contains the agreed first-round token families using full css variable names', () => {
    expect(DEFAULT_THEME_TOKENS).toMatchObject({
      '--ce-color-neutral-0': '#0f1115',
      '--ce-color-neutral-1': '#16181d',
      '--ce-color-neutral-2': '#1c2027',
      '--ce-color-neutral-3': '#20252d',
      '--ce-color-neutral-4': '#2a2f39',
      '--ce-color-neutral-5': '#3a4150',
      '--ce-color-neutral-6': '#f3f5f7',
      '--ce-color-accent-500': '#4c9ffe',
      '--ce-color-success-500': '#32c48d',
      '--ce-color-warning-500': '#ce9178',
      '--ce-color-danger-500': '#ff6b6b',
      '--ce-space-1': '4px',
      '--ce-space-2': '8px',
      '--ce-space-3': '12px',
      '--ce-space-4': '16px',
      '--ce-space-5': '24px',
      '--ce-space-6': '32px',
      '--ce-radius-sm': '4px',
      '--ce-radius-md': '8px',
      '--ce-radius-lg': '12px',
      '--ce-font-size-xs': '11px',
      '--ce-font-size-sm': '12px',
      '--ce-font-size-md': '14px',
      '--ce-font-weight-normal': '400',
      '--ce-font-weight-medium': '500',
      '--ce-shadow-1': 'inset 0 1px 2px rgb(0 0 0 / 0.24)',
      '--ce-shadow-2': '0 8px 24px rgb(0 0 0 / 0.28)',
      '--ce-surface': 'var(--ce-color-neutral-1)',
      '--ce-surface-raised': 'var(--ce-color-neutral-2)',
      '--ce-surface-overlay': '#181c22',
      '--ce-surface-hover': 'var(--ce-color-neutral-3)',
      '--ce-surface-active': '#232934',
      '--ce-text-primary': 'var(--ce-color-neutral-6)',
      '--ce-text-secondary': '#c2c8d0',
      '--ce-text-muted': '#8b93a1',
      '--ce-text-on-accent': '#081120',
      '--ce-border': 'var(--ce-color-neutral-4)',
      '--ce-border-strong': 'var(--ce-color-neutral-5)',
      '--ce-accent': 'var(--ce-color-accent-500)',
      '--ce-focus-ring': 'var(--ce-color-accent-500)',
      '--ce-selection-bg': '#1f3656',
      '--ce-success': 'var(--ce-color-success-500)',
      '--ce-warning': 'var(--ce-color-warning-500)',
      '--ce-danger': 'var(--ce-color-danger-500)',
      '--ce-workbench-bg': 'var(--ce-surface)',
      '--ce-tabbar-bg': 'var(--ce-surface-raised)',
      '--ce-tabbar-empty-bg': 'var(--ce-tabbar-bg)',
      '--ce-tab-bg': 'transparent',
      '--ce-tab-bg-hover': 'var(--ce-surface-hover)',
      '--ce-tab-bg-active': 'var(--ce-surface-raised)',
      '--ce-tab-fg': 'var(--ce-text-secondary)',
      '--ce-tab-fg-active': 'var(--ce-text-primary)',
      '--ce-tab-separator': 'var(--ce-border)',
      '--ce-tab-active-indicator': 'var(--ce-accent)',
      '--ce-divider-color': 'var(--ce-border)',
      '--ce-divider-hover-color': 'var(--ce-divider-color, var(--ce-border))',
      '--ce-divider-active-color': 'var(--ce-accent)',
      '--ce-drop-indicator-color': 'var(--ce-divider-active-color, var(--ce-accent))',
      '--ce-drop-zone-border-color': 'var(--ce-drop-indicator-color, var(--ce-divider-active-color, var(--ce-accent)))',
      '--ce-drop-zone-fill': 'rgb(76 159 254 / 0.16)',
      '--ce-button-bg': 'var(--ce-surface-raised)',
      '--ce-button-bg-hover': 'var(--ce-surface-hover)',
      '--ce-button-bg-active': 'var(--ce-surface-active)',
      '--ce-button-border': 'var(--ce-border-strong)',
      '--ce-button-fg': 'var(--ce-text-primary)',
      '--ce-button-disabled-bg': '#15181d',
      '--ce-button-disabled-border': '#2b313c',
      '--ce-button-disabled-fg': '#666d79',
      '--ce-input-bg': 'var(--ce-surface-raised)',
      '--ce-input-bg-hover': 'var(--ce-surface-hover)',
      '--ce-input-bg-active': 'var(--ce-surface-active)',
      '--ce-input-border': 'var(--ce-border-strong)',
      '--ce-input-fg': 'var(--ce-text-primary)',
      '--ce-input-placeholder': '#7f8796',
      '--ce-input-disabled-bg': '#15181d',
      '--ce-input-disabled-border': '#2b313c',
      '--ce-input-disabled-fg': '#666d79',
      '--ce-button-focus-ring': 'var(--ce-focus-ring)',
      '--ce-input-focus-ring': 'var(--ce-focus-ring)',
      '--ce-checkbox-bg': 'var(--ce-surface-raised)',
      '--ce-checkbox-border': 'var(--ce-border-strong)',
      '--ce-checkbox-bg-checked': 'var(--ce-accent)',
      '--ce-checkbox-border-checked': 'var(--ce-accent)',
      '--ce-checkbox-check': 'var(--ce-text-on-accent)',
      '--ce-checkbox-focus-ring': 'var(--ce-focus-ring)',
      '--ce-checkbox-disabled-opacity': '0.5',
    });
  });
});

describe('renderThemeVariables', () => {
  it('serializes theme tokens as a raw inline declaration string', () => {
    const css = renderThemeVariables({
      '--ce-accent': '#ff00aa',
      '--ce-workbench-bg': 'var(--ce-surface)',
      '--ce-input-bg': '#111111',
    });

    expect(css).toBe('--ce-accent:#ff00aa;--ce-workbench-bg:var(--ce-surface);--ce-input-bg:#111111;');
  });

  it('keeps DEFAULT_THEME_TOKENS in sync with tokens.css', () => {
    const cssSource = readFileSync(join(dirname(import.meta.filename), '../../src/styles/tokens.css'), 'utf8');

    expect(cssSource).toContain(':root {');

    const cssTokens = Object.fromEntries(
      Array.from(cssSource.matchAll(/(--ce-[\w-]+):\s*([^;]+);/g), ([, token, value]) => [token, value.trim()]),
    );

    expect(cssTokens).toEqual(DEFAULT_THEME_TOKENS);
  });
});

describe('applyThemeToDocument', () => {
  it('upserts token and base-ui style tags and reuses them', () => {
    const document = window.document.implementation.createHTMLDocument('iframe');

    applyThemeToDocument(document, {
      '--ce-accent': '#55aaff',
      '--ce-workbench-bg': '#111111',
      '--ce-input-bg': '#202020',
    });

    const tokenStyle = document.getElementById(THEME_TOKEN_STYLE_ID);
    const baseUiStyle = document.getElementById(BASE_UI_THEME_STYLE_ID);

    expect(tokenStyle).not.toBeNull();
    expect(baseUiStyle).not.toBeNull();
    expect(tokenStyle?.textContent).toBe(':root { --ce-accent:#55aaff;--ce-workbench-bg:#111111;--ce-input-bg:#202020; }');
    expect(baseUiStyle?.textContent).toContain('color-scheme: normal;');
    expect(baseUiStyle?.textContent).toContain('button');
    expect(baseUiStyle?.textContent).toContain('input');
    expect(baseUiStyle?.textContent).toContain('textarea');
    expect(baseUiStyle?.textContent).toContain('select');
    expect(baseUiStyle?.textContent).toContain('input[type="checkbox"]');
    expect(baseUiStyle?.textContent).toContain('button {');
    expect(baseUiStyle?.textContent).toContain('border: 1px solid var(--ce-button-border, var(--ce-border));');
    expect(baseUiStyle?.textContent).toContain('background: var(--ce-button-bg, var(--ce-surface-raised));');
    expect(baseUiStyle?.textContent).toContain('color: var(--ce-button-fg, var(--ce-text-primary));');
    expect(baseUiStyle?.textContent).toContain('outline: 2px solid var(--ce-button-focus-ring, var(--ce-focus-ring, var(--ce-accent)));');
    expect(baseUiStyle?.textContent).toContain('border: 1px solid var(--ce-input-border, var(--ce-border));');
    expect(baseUiStyle?.textContent).toContain('background: var(--ce-input-bg, var(--ce-surface));');
    expect(baseUiStyle?.textContent).toContain('color: var(--ce-input-fg, var(--ce-text-primary));');
    expect(baseUiStyle?.textContent).toContain('outline: 2px solid var(--ce-input-focus-ring, var(--ce-focus-ring, var(--ce-accent)));');
    expect(baseUiStyle?.textContent).toContain('border: 1px solid var(--ce-checkbox-border, var(--ce-border));');
    expect(baseUiStyle?.textContent).toContain('background: var(--ce-checkbox-bg, var(--ce-surface-raised));');
    expect(baseUiStyle?.textContent).toContain('background: var(--ce-checkbox-check, var(--ce-text-on-accent));');
    expect(baseUiStyle?.textContent).toContain('outline: 2px solid var(--ce-checkbox-focus-ring, var(--ce-focus-ring, var(--ce-accent)));');
    expect(baseUiStyle?.textContent).toContain('opacity: var(--ce-checkbox-disabled-opacity, 0.5);');

    const referencedTokens = Array.from(
      baseUiStyle?.textContent?.matchAll(/var\((--ce-[\w-]+)/g) ?? [],
      ([, token]) => token,
    );

    expect(referencedTokens).toEqual(
      expect.arrayContaining([
        '--ce-button-border',
        '--ce-button-bg',
        '--ce-button-bg-hover',
        '--ce-button-bg-active',
        '--ce-button-fg',
        '--ce-button-focus-ring',
        '--ce-button-disabled-bg',
        '--ce-button-disabled-border',
        '--ce-button-disabled-fg',
        '--ce-input-border',
        '--ce-input-bg',
        '--ce-input-bg-hover',
        '--ce-input-bg-active',
        '--ce-input-fg',
        '--ce-input-placeholder',
        '--ce-input-focus-ring',
        '--ce-input-disabled-bg',
        '--ce-input-disabled-border',
        '--ce-input-disabled-fg',
        '--ce-checkbox-border',
        '--ce-checkbox-bg',
        '--ce-checkbox-check',
        '--ce-checkbox-bg-checked',
        '--ce-checkbox-border-checked',
        '--ce-checkbox-focus-ring',
        '--ce-checkbox-disabled-opacity',
      ]),
    );

    expect(baseUiStyle?.textContent).not.toContain('button,\ninput,\ntextarea,\nselect {');
    expect(baseUiStyle?.textContent).not.toContain('var(--ce-checkbox-checkmark');
    expect(baseUiStyle?.textContent).not.toContain('body {');

    applyThemeToDocument(document, {
      '--ce-accent': '#77bbff',
      '--ce-workbench-bg': '#222222',
      '--ce-input-bg': '#303030',
    });

    const tokenStyles = document.querySelectorAll(`#${THEME_TOKEN_STYLE_ID}`);
    const baseUiStyles = document.querySelectorAll(`#${BASE_UI_THEME_STYLE_ID}`);

    expect(tokenStyles).toHaveLength(1);
    expect(baseUiStyles).toHaveLength(1);
    expect(document.getElementById(THEME_TOKEN_STYLE_ID)).toBe(tokenStyle);
    expect(document.getElementById(BASE_UI_THEME_STYLE_ID)).toBe(baseUiStyle);
    expect(tokenStyle?.textContent).toBe(':root { --ce-accent:#77bbff;--ce-workbench-bg:#222222;--ce-input-bg:#303030; }');
  });
});
