import './editor-app';

export class WindowGroupApp extends HTMLElement {
  connectedCallback(): void {
    // Let the client entry install its device-aware fetch before the embedded
    // EditorApp starts requesting Session data.
    queueMicrotask(() => {
      if (!this.isConnected || this.childElementCount > 0) return;
      this.innerHTML = '<editor-app window-group-kind="secondary"></editor-app>';
    });
  }
}

if (!customElements.get('window-group-app')) {
  customElements.define('window-group-app', WindowGroupApp);
}
