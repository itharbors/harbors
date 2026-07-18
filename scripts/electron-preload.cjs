const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronMenu', {
  syncMenu(payload) {
    ipcRenderer.send('ce:menu-sync', payload);
  },
  onMenuAction(handler) {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('ce:menu-action', listener);
    return () => {
      ipcRenderer.removeListener('ce:menu-action', listener);
    };
  },
  openExternalUrl(url) {
    return ipcRenderer.invoke('ce:open-external-url', url);
  },
});
