const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notificationToast', {
  openCenter() {
    return ipcRenderer.invoke('harbors:notification-open-center');
  },
  closeToast() {
    return ipcRenderer.invoke('harbors:notification-close-toast');
  },
});
