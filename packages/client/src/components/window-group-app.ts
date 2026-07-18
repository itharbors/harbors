import './editor-app';

export class WindowGroupApp extends HTMLElement {
  connectedCallback(): void {
    if (this.childElementCount > 0) return;
    this.innerHTML = '<editor-app window-group-kind="secondary"></editor-app>';
  }
}

if (!customElements.get('window-group-app')) {
  customElements.define('window-group-app', WindowGroupApp);
}
