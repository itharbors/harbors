import { describe, expect, it } from 'vitest';
import '../../src/ui/dialog';
import type { Dialog } from '../../src/ui/dialog';

describe('ce-dialog', () => {
  it('renders backdrop and dialog when open', () => {
    const el = document.createElement('ce-dialog');
    el.setAttribute('open', '');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('.backdrop')).not.toBeNull();
    expect(el.shadowRoot!.querySelector('.dialog')).not.toBeNull();

    document.body.removeChild(el);
  });

  it('does not render dialog content when closed', () => {
    const el = document.createElement('ce-dialog');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('.backdrop')).toBeNull();

    document.body.removeChild(el);
  });

  it('dispatches ce-dialog-close on backdrop click when closable', async () => {
    const el = document.createElement('ce-dialog');
    el.setAttribute('open', '');
    document.body.appendChild(el);

    const closeEvent = new Promise<void>((resolve) => {
      el.addEventListener('ce-dialog-close', () => resolve());
    });

    (el.shadowRoot!.querySelector('.backdrop') as HTMLElement).click();

    await closeEvent;
    expect(el.hasAttribute('open')).toBe(false);

    document.body.removeChild(el);
  });

  it('keeps open on backdrop click when closable is false', () => {
    const el = document.createElement('ce-dialog');
    el.setAttribute('open', '');
    el.setAttribute('closable', 'false');
    document.body.appendChild(el);

    (el.shadowRoot!.querySelector('.backdrop') as HTMLElement).click();

    expect(el.hasAttribute('open')).toBe(true);

    document.body.removeChild(el);
  });

  it('renders header, body, and footer slots', () => {
    const el = document.createElement('ce-dialog');
    el.setAttribute('open', '');
    el.innerHTML = `
      <div slot="header">Title</div>
      <div slot="body">Content</div>
      <div slot="footer"><button>OK</button></div>
    `;
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('slot[name="header"]')).not.toBeNull();
    expect(el.shadowRoot!.querySelector('slot[name="body"]')).not.toBeNull();
    expect(el.shadowRoot!.querySelector('slot[name="footer"]')).not.toBeNull();

    document.body.removeChild(el);
  });

  it('reflects open property', () => {
    const el = document.createElement('ce-dialog') as Dialog;
    document.body.appendChild(el);

    el.open = true;
    expect(el.hasAttribute('open')).toBe(true);

    el.open = false;
    expect(el.hasAttribute('open')).toBe(false);

    document.body.removeChild(el);
  });
});
