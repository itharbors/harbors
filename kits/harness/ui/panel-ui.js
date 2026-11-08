class HarnessButton extends HTMLElement {
  static observedAttributes = ['disabled', 'aria-label'];

  constructor() {
    super();
    this.addEventListener('click', (event) => {
      if (this.hasAttribute('disabled')) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { display: inline-flex; min-width: 0; }
      button { display: inline-flex; width: 100%; min-height: 34px; align-items: center; justify-content: center; padding: 7px 12px; border: 1px solid var(--ce-accent, #2563eb); border-radius: var(--ce-radius-md, 8px); background: var(--ce-accent, #2563eb); color: var(--ce-text-on-accent, #fff); font: inherit; font-weight: 600; cursor: pointer; }
      button:hover:not(:disabled) { background: var(--ce-accent-hover, #1d4ed8); }
      button:focus-visible { outline: 2px solid var(--ce-focus-ring, #3b82f6); outline-offset: 2px; }
      button:disabled { opacity: .5; cursor: not-allowed; }
    </style><button type="button"><slot></slot></button>`;
  }

  connectedCallback() { this.syncAttributes(); }
  attributeChangedCallback() { this.syncAttributes(); }

  syncAttributes() {
    const button = this.shadowRoot.querySelector('button');
    button.disabled = this.hasAttribute('disabled');
    const label = this.getAttribute('aria-label');
    if (label) button.setAttribute('aria-label', label);
    else button.removeAttribute('aria-label');
  }
}

if (!customElements.get('harness-button')) customElements.define('harness-button', HarnessButton);

const harnessStyles = `
.h-button, .h-input, .h-textarea, .h-select { box-sizing: border-box; font: inherit; }
.h-button { display: inline-flex; align-items: center; justify-content: center; min-height: 34px; padding: 7px 12px; border: 1px solid var(--ce-border, #2a3440); border-radius: var(--ce-radius-md, 8px); background: var(--ce-surface-raised, #1b222c); color: var(--ce-text-primary, #edf1f7); font-weight: 600; cursor: pointer; }
.h-button:hover:not(:disabled) { background: var(--ce-surface-hover, #26303d); }
.h-button--primary { border-color: var(--ce-accent, #2563eb); background: var(--ce-accent, #2563eb); color: var(--ce-text-on-accent, #fff); }
.h-button--primary:hover:not(:disabled) { background: var(--ce-accent-hover, #1d4ed8); }
.h-button--secondary { background: var(--ce-surface-raised, #1b222c); }
.h-button--ghost { border-color: transparent; background: transparent; }
.h-button--danger { border-color: #b84a56; background: #8d303d; color: #fff; }
.h-button--danger:hover:not(:disabled) { background: #a63b49; }
.h-input, .h-textarea, .h-select { width: 100%; min-width: 0; min-height: 34px; padding: 7px 10px; border: 1px solid var(--ce-border-strong, #475568); border-radius: var(--ce-radius-md, 8px); background: var(--ce-surface, #141920); color: var(--ce-text-primary, #edf1f7); }
.h-textarea { min-height: 80px; resize: vertical; }
.h-input::placeholder, .h-textarea::placeholder { color: var(--ce-text-muted, #94a3b8); }
.h-check, .h-radio { accent-color: var(--ce-accent, #2563eb); }
.h-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.h-switch > input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.h-switch__track { position: relative; flex: none; width: 34px; height: 20px; border-radius: 999px; background: var(--ce-border-strong, #475568); transition: background .15s; }
.h-switch__track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; }
@media (prefers-reduced-motion: reduce) { .h-switch__track, .h-switch__track::after { transition: none; } }
.h-switch > input:checked + .h-switch__track { background: var(--ce-accent, #2563eb); }
.h-switch > input:checked + .h-switch__track::after { transform: translateX(14px); }
.h-switch > input:focus-visible + .h-switch__track { outline: 2px solid var(--ce-focus-ring, #3b82f6); outline-offset: 2px; }
.h-switch > input:disabled + .h-switch__track { opacity: .5; }
.h-switch:has(> input:disabled) { cursor: not-allowed; opacity: .65; }
.h-button:focus-visible, .h-input:focus-visible, .h-textarea:focus-visible, .h-select:focus-visible, .h-check:focus-visible, .h-radio:focus-visible { outline: 2px solid var(--ce-focus-ring, #3b82f6); outline-offset: 2px; }
.h-button:disabled, .h-input:disabled, .h-textarea:disabled, .h-select:disabled, .h-check:disabled, .h-radio:disabled { opacity: .5; cursor: not-allowed; }
.h-list-item { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; min-height: 36px; padding: 6px 12px 6px 8px; border: 1px solid transparent; border-radius: 7px; background: transparent; box-shadow: none; color: var(--ce-text-primary, #edf1f7); font: 650 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: left; cursor: pointer; }
.h-list-item:hover:not(:disabled):not([aria-disabled="true"]) { border-color: transparent; background: var(--ce-surface-hover, #26303d); }
.h-list-item:is([aria-pressed="true"], [aria-current="true"]) { background: var(--ce-selection-bg, #203957); }
.h-list-item:is([aria-pressed="true"], [aria-current="true"]):hover:not(:disabled):not([aria-disabled="true"]) { background: var(--ce-selection-bg, #203957); }
.h-list-item:focus-visible { outline: 2px solid var(--ce-focus-ring, #3b82f6); outline-offset: -2px; }
.h-list-item:is(:disabled, [aria-disabled="true"]) { opacity: .5; cursor: not-allowed; }
.h-badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; background: var(--ce-surface-hover, #26303d); color: var(--ce-text-primary, #edf1f7); font-size: .85em; }
.h-alert { padding: 10px 12px; border: 1px solid var(--ce-border-strong, #475568); border-radius: var(--ce-radius-md, 8px); background: var(--ce-surface-raised, #1b222c); color: var(--ce-text-primary, #edf1f7); }
.h-badge--success, .h-alert--success { background: #153a31; color: #a7ead0; }
.h-badge--warning, .h-alert--warning { background: #45371b; color: #f5d68b; }
.h-badge--danger, .h-alert--danger { background: #48262c; color: #ffc0c6; }
.h-card { padding: 16px; border: 1px solid var(--ce-border, #2a3440); border-radius: var(--ce-radius-md, 8px); background: var(--ce-surface-raised, #1b222c); color: var(--ce-text-primary, #edf1f7); }
.h-table { width: 100%; border-collapse: collapse; color: var(--ce-text-primary, #edf1f7); text-align: left; }
.h-table th, .h-table td { padding: 8px 10px; border-bottom: 1px solid var(--ce-border, #2a3440); }
.h-table th { color: var(--ce-text-muted, #94a3b8); font-weight: 600; }
`;

function install(root) {
  const target = root.nodeType === Node.DOCUMENT_NODE ? root.head : root;
  if (target.querySelector('style[data-harness-ui]')) return;
  const style = (root.ownerDocument || root).createElement('style');
  style.setAttribute('data-harness-ui', '');
  style.textContent = harnessStyles;
  target.append(style);
}

window.HarnessUI = { install };
install(document);
