function focusWindow(window) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

export function createKitManagerWindowController({
  BrowserWindow,
  preloadPath,
  htmlPath,
  onClosed = () => undefined,
}) {
  if (typeof BrowserWindow !== 'function') throw new TypeError('BrowserWindow is required');
  if (typeof preloadPath !== 'string' || preloadPath.length === 0) {
    throw new TypeError('Kit Manager preload path is required');
  }
  if (typeof htmlPath !== 'string' || htmlPath.length === 0) {
    throw new TypeError('Kit Manager HTML path is required');
  }
  if (typeof onClosed !== 'function') throw new TypeError('onClosed is required');
  let window = null;
  let pending = null;

  async function open() {
    if (window && !window.isDestroyed()) return focusWindow(window);
    if (pending) return pending;
    pending = (async () => {
      const created = new BrowserWindow({
        width: 1180,
        height: 820,
        minWidth: 760,
        minHeight: 620,
        show: false,
        autoHideMenuBar: true,
        title: 'ITHARBORS — Kit Dock',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload: preloadPath,
        },
      });
      window = created;
      created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      created.webContents.on('will-navigate', (event) => event.preventDefault());
      created.on('closed', () => {
        if (window === created) window = null;
        onClosed();
      });
      try {
        await created.loadFile(htmlPath);
        if (!created.isDestroyed()) focusWindow(created);
        return created;
      } catch (error) {
        if (!created.isDestroyed()) created.destroy();
        throw error;
      }
    })().finally(() => {
      pending = null;
    });
    return pending;
  }

  return {
    open,
    getWindow: () => (window && !window.isDestroyed() ? window : null),
    destroy() {
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}
