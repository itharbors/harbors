import { DEFAULT_THEME_TOKENS, type ThemeTokens, renderThemeVariables } from './theme';

export const THEME_TOKEN_STYLE_ID = 'ce-theme-tokens';
export const BASE_UI_THEME_STYLE_ID = 'ce-base-ui-theme';

const BASE_UI_THEME_CSS = `:root {
  color-scheme: normal;
}

button,
input,
textarea,
select,
input[type="checkbox"] {
  border-radius: var(--ce-radius-sm, 4px);
  font: inherit;
}

button {
  border: 1px solid var(--ce-button-border, var(--ce-border));
  background: var(--ce-button-bg, var(--ce-surface-raised));
  color: var(--ce-button-fg, var(--ce-text-primary));
  box-shadow: var(--ce-shadow-1, inset 0 1px 2px rgb(0 0 0 / 0.24));
  cursor: pointer;
}

button:hover {
  background: var(--ce-button-bg-hover, var(--ce-surface-hover));
}

button:active {
  background: var(--ce-button-bg-active, var(--ce-surface-active));
}

button:disabled {
  background: var(--ce-button-disabled-bg, var(--ce-surface));
  border-color: var(--ce-button-disabled-border, var(--ce-border));
  color: var(--ce-button-disabled-fg, var(--ce-text-muted));
  cursor: not-allowed;
}

button:focus-visible {
  outline: 2px solid var(--ce-button-focus-ring, var(--ce-focus-ring, var(--ce-accent)));
  outline-offset: 2px;
}

input,
textarea,
select {
  border: 1px solid var(--ce-input-border, var(--ce-border));
  background: var(--ce-input-bg, var(--ce-surface));
  color: var(--ce-input-fg, var(--ce-text-primary));
  box-shadow: var(--ce-shadow-1, inset 0 1px 2px rgb(0 0 0 / 0.24));
}

input:hover,
textarea:hover,
select:hover {
  background: var(--ce-input-bg-hover, var(--ce-surface-hover));
}

input:active,
textarea:active,
select:active {
  background: var(--ce-input-bg-active, var(--ce-surface-active));
}

input:disabled,
textarea:disabled,
select:disabled {
  background: var(--ce-input-disabled-bg, var(--ce-surface));
  border-color: var(--ce-input-disabled-border, var(--ce-border));
  color: var(--ce-input-disabled-fg, var(--ce-text-muted));
  cursor: not-allowed;
}

input:focus-visible,
textarea:focus-visible,
select:focus-visible {
  outline: 2px solid var(--ce-input-focus-ring, var(--ce-focus-ring, var(--ce-accent)));
  outline-offset: 2px;
}

input::placeholder,
textarea::placeholder {
  color: var(--ce-input-placeholder, var(--ce-text-muted));
}

select option {
  background: var(--ce-input-bg, var(--ce-surface));
  color: var(--ce-input-fg, var(--ce-text-primary));
}

input[type="checkbox"] {
  appearance: none;
  width: 16px;
  height: 16px;
  border: 1px solid var(--ce-checkbox-border, var(--ce-border));
  background: var(--ce-checkbox-bg, var(--ce-surface-raised));
  box-shadow: none;
  display: inline-grid;
  place-content: center;
  vertical-align: middle;
}

input[type="checkbox"]::after {
  content: '';
  width: 8px;
  height: 8px;
  transform: scale(0);
  transition: transform 120ms ease;
  background: var(--ce-checkbox-check, var(--ce-text-on-accent));
  clip-path: polygon(14% 44%, 0 59%, 41% 100%, 100% 19%, 84% 4%, 39% 62%);
}

input[type="checkbox"]:checked {
  background: var(--ce-checkbox-bg-checked, var(--ce-accent));
  border-color: var(--ce-checkbox-border-checked, var(--ce-accent));
}

input[type="checkbox"]:checked::after {
  transform: scale(1);
}

input[type="checkbox"]:focus-visible {
  outline: 2px solid var(--ce-checkbox-focus-ring, var(--ce-focus-ring, var(--ce-accent)));
  outline-offset: 2px;
}

input[type="checkbox"]:disabled {
  opacity: var(--ce-checkbox-disabled-opacity, 0.5);
  cursor: not-allowed;
}`;

function upsertStyle(document: Document, id: string, cssText: string): HTMLStyleElement {
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    document.head.appendChild(style);
  }
  style.textContent = cssText;
  return style;
}

export function applyThemeToDocument(document: Document, tokens: ThemeTokens = DEFAULT_THEME_TOKENS): void {
  upsertStyle(document, THEME_TOKEN_STYLE_ID, `:root { ${renderThemeVariables(tokens)} }`);
  upsertStyle(document, BASE_UI_THEME_STYLE_ID, BASE_UI_THEME_CSS);
}
