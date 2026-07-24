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

contextBridge.exposeInMainWorld('harborsUpdates', {
  getState: () => ipcRenderer.invoke('harbors:update:get-state'),
  check: () => ipcRenderer.invoke('harbors:update:check'),
  download: () => ipcRenderer.invoke('harbors:update:download'),
  install: () => ipcRenderer.invoke('harbors:update:install'),
  onState(handler) {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on('harbors:update:state', listener);
    return () => ipcRenderer.removeListener('harbors:update:state', listener);
  },
});
