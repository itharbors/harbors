export {};

import '../src/ui/button';
import '../src/ui/icon-button';
import '../src/ui/input';
import '../src/ui/textarea';
import '../src/ui/select';
import '../src/ui/checkbox';
import '../src/ui/radio';
import '../src/ui/toggle';
import '../src/ui/tooltip';
import '../src/ui/dialog';
import '../src/ui/badge';
import '../src/ui/progress';
import '../src/ui/icon';
import '../src/styles/tokens.css';

defineUiKitElements();

class UiKitPage extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <style>
        :host {
          display: block;
          min-height: 100vh;
          --ce-button-bg: #2d2d2d;
          --ce-button-bg-hover: #383838;
          --ce-button-bg-active: #444;
          --ce-button-border: #4c4c4c;
          --ce-input-bg: #1a1a1a;
          --ce-input-border: #444;
          --ce-input-placeholder: #777;
          --ce-checkbox-bg: #1a1a1a;
          --ce-checkbox-border: #555;
          --ce-checkbox-bg-checked: #569cd6;
          --ce-checkbox-border-checked: #569cd6;
          --ce-surface: #1a1a1a;
          --ce-surface-raised: #2d2d2d;
          --ce-border: #444;
          --ce-text-primary: #fff;
          --ce-text-secondary: #ccc;
          --ce-text-muted: #888;
          --ce-accent: #569cd6;
          --ce-success: #4ec9b0;
          --ce-danger: #f44747;
          --ce-warning: #ce9178;
          background: #000;
          color: var(--ce-text-primary);
          font-family: system-ui, sans-serif;
        }
        * { box-sizing: border-box; }
        .page { max-width: 640px; margin: 0 auto; padding: 24px 16px; }
        h1 { font-size: 18px; margin: 0 0 8px; }
        h2 {
          font-size: 14px;
          font-weight: 600;
          margin: 20px 0 10px;
          color: var(--ce-text-muted);
          border-bottom: 1px solid #333;
          padding-bottom: 4px;
        }
        .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
      </style>
      <div class="page">
        <h1>UI Kit</h1>

        <h2>Button</h2>
        <div class="row">
          <ce-button variant="primary">Primary</ce-button>
          <ce-button variant="secondary">Secondary</ce-button>
          <ce-button variant="ghost">Ghost</ce-button>
          <ce-button variant="danger">Danger</ce-button>
          <ce-button disabled>Disabled</ce-button>
          <ce-button size="sm">Small</ce-button>
        </div>

        <h2>Icon Button</h2>
        <div class="row">
          <ce-icon-button icon="close"></ce-icon-button>
          <ce-icon-button icon="plus"></ce-icon-button>
          <ce-icon-button icon="chevron-down"></ce-icon-button>
          <ce-icon-button icon="more"></ce-icon-button>
          <ce-icon-button icon="close" disabled></ce-icon-button>
        </div>

        <h2>Input</h2>
        <div class="row">
          <ce-input placeholder="Text input" style="width:200px;"></ce-input>
          <ce-input placeholder="Password" type="password" style="width:200px;"></ce-input>
          <ce-input placeholder="Disabled" disabled style="width:200px;"></ce-input>
        </div>

        <h2>Textarea</h2>
        <ce-textarea placeholder="Multi-line text..." rows="3" style="width:100%;"></ce-textarea>

        <h2>Select</h2>
        <ce-select>
          <ce-option value="ts">TypeScript</ce-option>
          <ce-option value="js">JavaScript</ce-option>
          <ce-option value="json" selected>JSON</ce-option>
        </ce-select>

        <h2>Checkbox / Radio / Toggle</h2>
        <div class="row">
          <ce-checkbox label="Accept terms"></ce-checkbox>
          <ce-checkbox label="Subscribe" checked></ce-checkbox>
          <ce-checkbox label="Disabled" disabled></ce-checkbox>
        </div>
        <div class="row" style="margin-top:8px;">
          <ce-radio name="demo" value="a" checked>Option A</ce-radio>
          <ce-radio name="demo" value="b">Option B</ce-radio>
          <ce-radio name="demo" value="c">Option C</ce-radio>
        </div>
        <div class="row" style="margin-top:8px;">
          <ce-toggle label="Auto-save" checked></ce-toggle>
          <ce-toggle label="Notifications"></ce-toggle>
        </div>

        <h2>Tooltip</h2>
        <div class="row">
          <ce-tooltip content="Save the file" delay="100">
            <ce-button variant="secondary">Hover me</ce-button>
          </ce-tooltip>
        </div>

        <h2>Dialog</h2>
        <div class="row">
          <ce-button variant="primary" id="open-dialog-btn">Open Dialog</ce-button>
        </div>
        <ce-dialog id="demo-dialog">
          <div slot="header">Confirm</div>
          <div slot="body">Are you sure you want to delete this file?</div>
          <div slot="footer">
            <ce-button variant="secondary" id="dialog-cancel">Cancel</ce-button>
            <ce-button variant="danger" id="dialog-confirm">Delete</ce-button>
          </div>
        </ce-dialog>

        <h2>Badge</h2>
        <div class="row">
          <ce-badge variant="info">INFO</ce-badge>
          <ce-badge variant="success">OK</ce-badge>
          <ce-badge variant="warning">WARN</ce-badge>
          <ce-badge variant="danger">ERR</ce-badge>
        </div>

        <h2>Progress</h2>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <ce-progress value="60"></ce-progress>
          <ce-progress value="100"></ce-progress>
          <ce-progress indeterminate></ce-progress>
        </div>

        <h2>Icon</h2>
        <div class="row">
          <ce-icon name="close"></ce-icon>
          <ce-icon name="plus"></ce-icon>
          <ce-icon name="folder"></ce-icon>
          <ce-icon name="file"></ce-icon>
          <ce-icon name="search"></ce-icon>
          <ce-icon name="chevron-right" size="lg"></ce-icon>
        </div>
      </div>
    `;

    this.setupDialog();
  }

  private setupDialog() {
    const openBtn = this.querySelector('#open-dialog-btn');
    const dialog = this.querySelector('#demo-dialog');
    const cancelBtn = this.querySelector('#dialog-cancel');
    const confirmBtn = this.querySelector('#dialog-confirm');

    openBtn?.addEventListener('click', () => dialog?.setAttribute('open', ''));
    cancelBtn?.addEventListener('click', () => dialog?.removeAttribute('open'));
    confirmBtn?.addEventListener('click', () => dialog?.removeAttribute('open'));
  }
}

if (!customElements.get('ui-kit-page')) {
  customElements.define('ui-kit-page', UiKitPage);
}

function defineUiKitElements() {
  defineButton();
  defineIconButton();
  defineInput();
  defineTextarea();
  defineSelect();
  defineCheckbox();
  defineRadio();
  defineToggle();
  defineTooltip();
  defineDialog();
  defineBadge();
  defineProgress();
  defineIcon();
}

function defineButton() {
  if (customElements.get('ce-button')) return;

  customElements.define('ce-button', class Button extends HTMLElement {
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this.render();
    }

    static get observedAttributes() {
      return ['variant', 'size', 'disabled'];
    }

    attributeChangedCallback() {
      if (this.shadowRoot) this.render();
    }

    private render() {
      const variant = this.getAttribute('variant') || 'secondary';
      const size = this.getAttribute('size') || 'md';
      this.shadowRoot!.innerHTML = `
        <style>
          button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: ${size === 'sm' ? '24px' : '30px'};
            padding: 0 ${size === 'sm' ? '8px' : '12px'};
            border: 1px solid var(--ce-border, #444);
            border-radius: 4px;
            background: ${buttonBackground(variant)};
            color: ${variant === 'ghost' ? 'var(--ce-text-secondary, #ccc)' : '#fff'};
            cursor: pointer;
            font: inherit;
            font-size: ${size === 'sm' ? '11px' : '12px'};
          }
          button[disabled] { opacity: 0.4; cursor: not-allowed; }
        </style>
        <button ${this.hasAttribute('disabled') ? 'disabled' : ''}><slot></slot></button>
      `;
    }
  });
}

function defineIconButton() {
  if (customElements.get('ce-icon-button')) return;

  customElements.define('ce-icon-button', class IconButton extends HTMLElement {
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this.render();
    }

    static get observedAttributes() {
      return ['icon', 'disabled'];
    }

    attributeChangedCallback() {
      if (this.shadowRoot) this.render();
    }

    private render() {
      this.shadowRoot!.innerHTML = `
        <style>
          button {
            width: 28px;
            height: 28px;
            border: 0;
            border-radius: 4px;
            background: transparent;
            color: var(--ce-text-secondary, #ccc);
            cursor: pointer;
          }
          button:hover { background: var(--ce-surface-raised, #2d2d2d); color: #fff; }
          button[disabled] { opacity: 0.4; cursor: not-allowed; }
        </style>
        <button ${this.hasAttribute('disabled') ? 'disabled' : ''}>${iconFor(this.getAttribute('icon') || '')}</button>
      `;
    }
  });
}

function defineInput() {
  if (customElements.get('ce-input')) return;

  customElements.define('ce-input', class Input extends HTMLElement {
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this.render();
    }

    private render() {
      this.shadowRoot!.innerHTML = `
        <style>${fieldStyles('input')}</style>
        <input
          type="${escapeAttr(this.getAttribute('type') || 'text')}"
          placeholder="${escapeAttr(this.getAttribute('placeholder') || '')}"
          value="${escapeAttr(this.getAttribute('value') || '')}"
          ${this.hasAttribute('disabled') ? 'disabled' : ''}
        >
      `;
    }
  });
}

function defineTextarea() {
  if (customElements.get('ce-textarea')) return;

  customElements.define('ce-textarea', class Textarea extends HTMLElement {
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this.render();
    }

    private render() {
      this.shadowRoot!.innerHTML = `
        <style>${fieldStyles('textarea')}</style>
        <textarea
          rows="${escapeAttr(this.getAttribute('rows') || '4')}"
          placeholder="${escapeAttr(this.getAttribute('placeholder') || '')}"
          ${this.hasAttribute('disabled') ? 'disabled' : ''}
        >${escapeHtml(this.getAttribute('value') || '')}</textarea>
      `;
    }
  });
}

function defineSelect() {
  if (!customElements.get('ce-option')) {
    customElements.define('ce-option', class OptionElement extends HTMLElement {});
  }

  if (customElements.get('ce-select')) return;

  customElements.define('ce-select', class Select extends HTMLElement {
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this.render();
    }

    private render() {
      const options = Array.from(this.querySelectorAll('ce-option')).map((option) => {
        const value = option.getAttribute('value') || option.textContent || '';
        return `<option value="${escapeAttr(value)}" ${option.hasAttribute('selected') ? 'selected' : ''}>${escapeHtml(option.textContent || value)}</option>`;
      }).join('');

      this.shadowRoot!.innerHTML = `<style>${fieldStyles('select')}</style><select>${options}</select>`;
    }
  });
}

function defineCheckbox() {
  if (customElements.get('ce-checkbox')) return;

  customElements.define('ce-checkbox', class Checkbox extends HTMLElement {
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this.shadowRoot!.innerHTML = choiceTemplate('checkbox', this.getAttribute('label') || '', this.hasAttribute('checked'), this.hasAttribute('disabled'));
    }
  });
}

function defineRadio() {
  if (customElements.get('ce-radio')) return;

  customElements.define('ce-radio', class Radio extends HTMLElement {
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      const label = this.textContent || this.getAttribute('label') || '';
      this.shadowRoot!.innerHTML = choiceTemplate('radio', label, this.hasAttribute('checked'), this.hasAttribute('disabled'), this.getAttribute('name') || '');
    }
  });
}

function defineToggle() {
  if (customElements.get('ce-toggle')) return;

  customElements.define('ce-toggle', class Toggle extends HTMLElement {
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this.shadowRoot!.innerHTML = `
        <style>
          :host { display: inline-flex; align-items: center; gap: 8px; color: var(--ce-text-primary, #fff); font-size: 12px; }
          input { accent-color: var(--ce-accent, #569cd6); }
        </style>
        <label><input type="checkbox" ${this.hasAttribute('checked') ? 'checked' : ''}> ${escapeHtml(this.getAttribute('label') || '')}</label>
      `;
    }
  });
}

function defineTooltip() {
  if (customElements.get('ce-tooltip')) return;

  customElements.define('ce-tooltip', class Tooltip extends HTMLElement {
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this.shadowRoot!.innerHTML = `
        <style>
          :host { display: inline-block; position: relative; }
          .tip {
            display: none;
            position: absolute;
            bottom: calc(100% + 4px);
            left: 50%;
            transform: translateX(-50%);
            padding: 4px 8px;
            background: var(--ce-surface-raised, #2d2d2d);
            border: 1px solid var(--ce-border, #444);
            border-radius: 4px;
            color: #fff;
            font-size: 11px;
            white-space: nowrap;
          }
          :host(:hover) .tip { display: block; }
        </style>
        <slot></slot>
        <span class="tip">${escapeHtml(this.getAttribute('content') || '')}</span>
      `;
    }
  });
}

function defineDialog() {
  if (customElements.get('ce-dialog')) return;

  customElements.define('ce-dialog', class Dialog extends HTMLElement {
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this.render();
    }

    static get observedAttributes() {
      return ['open'];
    }

    attributeChangedCallback() {
      if (this.shadowRoot) this.render();
    }

    private render() {
      if (!this.hasAttribute('open')) {
        this.shadowRoot!.innerHTML = '<style>:host { display: none; }</style>';
        return;
      }

      this.shadowRoot!.innerHTML = `
        <style>
          .backdrop { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,0.55); z-index: 1000; }
          .dialog { min-width: 300px; max-width: 90vw; background: var(--ce-surface, #1a1a1a); border: 1px solid var(--ce-border, #444); border-radius: 8px; color: #fff; }
          .header, .body, .footer { padding: 12px 16px; }
          .header { border-bottom: 1px solid var(--ce-border, #444); font-weight: 600; }
          .footer { border-top: 1px solid var(--ce-border, #444); display: flex; justify-content: flex-end; gap: 8px; }
        </style>
        <div class="backdrop">
          <div class="dialog" role="dialog">
            <div class="header"><slot name="header"></slot></div>
            <div class="body"><slot name="body"></slot></div>
            <div class="footer"><slot name="footer"></slot></div>
          </div>
        </div>
      `;

      this.shadowRoot!.querySelector('.backdrop')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) this.removeAttribute('open');
      });
    }
  });
}

function defineBadge() {
  if (customElements.get('ce-badge')) return;

  customElements.define('ce-badge', class Badge extends HTMLElement {
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      const variant = this.getAttribute('variant') || 'info';
      this.shadowRoot!.innerHTML = `
        <style>
          span { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 11px; font-weight: 600; }
          .info { background: var(--ce-accent, #569cd6); color: #fff; }
          .success { background: var(--ce-success, #4ec9b0); color: #000; }
          .warning { background: var(--ce-warning, #ce9178); color: #000; }
          .danger { background: var(--ce-danger, #f44747); color: #fff; }
        </style>
        <span class="${escapeAttr(variant)}"><slot></slot></span>
      `;
    }
  });
}

function defineProgress() {
  if (customElements.get('ce-progress')) return;

  customElements.define('ce-progress', class Progress extends HTMLElement {
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      const rawValue = Number(this.getAttribute('value') || 0);
      const value = Math.max(0, Math.min(100, rawValue));
      this.shadowRoot!.innerHTML = `
        <style>
          :host { display: block; }
          .track { height: 6px; overflow: hidden; background: var(--ce-surface-raised, #2d2d2d); border-radius: 3px; }
          .fill { width: ${value}%; height: 100%; background: var(--ce-accent, #569cd6); border-radius: 3px; }
          .indeterminate { width: 30%; }
        </style>
        <div class="track"><div class="fill${this.hasAttribute('indeterminate') ? ' indeterminate' : ''}"></div></div>
      `;
    }
  });
}

function defineIcon() {
  if (customElements.get('ce-icon')) return;

  customElements.define('ce-icon', class Icon extends HTMLElement {
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      const size = this.getAttribute('size') === 'lg' ? '16px' : '14px';
      this.shadowRoot!.innerHTML = `<span style="font-size:${size};line-height:1;">${iconFor(this.getAttribute('name') || '')}</span>`;
    }
  });
}

function buttonBackground(variant: string): string {
  if (variant === 'primary') return 'var(--ce-accent, #569cd6)';
  if (variant === 'danger') return 'var(--ce-danger, #f44747)';
  if (variant === 'ghost') return 'transparent';
  return 'var(--ce-surface-raised, #2d2d2d)';
}

function fieldStyles(tagName: string): string {
  return `
    :host { display: inline-block; }
    ${tagName} {
      width: 100%;
      min-height: 30px;
      padding: 0 8px;
      background: var(--ce-surface, #1a1a1a);
      border: 1px solid var(--ce-border, #444);
      border-radius: 4px;
      color: var(--ce-text-primary, #fff);
      font: inherit;
      font-size: 12px;
      outline: none;
    }
    textarea { min-height: auto; padding: 8px; resize: vertical; }
    ${tagName}:focus { border-color: var(--ce-accent, #569cd6); }
    ${tagName}:disabled { opacity: 0.4; cursor: not-allowed; }
  `;
}

function choiceTemplate(type: 'checkbox' | 'radio', label: string, checked: boolean, disabled: boolean, name = ''): string {
  return `
    <style>
      :host { display: inline-flex; align-items: center; gap: 4px; color: var(--ce-text-primary, #fff); font-size: 12px; }
      input { accent-color: var(--ce-accent, #569cd6); margin: 0; }
      label { cursor: pointer; }
    </style>
    <label>
      <input type="${type}" name="${escapeAttr(name)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      ${escapeHtml(label)}
    </label>
  `;
}

function iconFor(name: string): string {
  const icons: Record<string, string> = {
    close: 'x',
    plus: '+',
    'chevron-down': 'v',
    'chevron-right': '>',
    more: '...',
    folder: '[dir]',
    file: '[file]',
    search: '?',
  };
  return icons[name] || escapeHtml(name);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
