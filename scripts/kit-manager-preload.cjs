const { contextBridge, ipcRenderer } = require('electron');

const channels = Object.freeze({
  list: 'harbors:kit-manager:list',
  refresh: 'harbors:kit-manager:refresh',
  install: 'harbors:kit-manager:install',
  activate: 'harbors:kit-manager:activate',
  rollback: 'harbors:kit-manager:rollback',
});

async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (response?.ok === true) return response.value;
  const error = new Error(response?.error?.message || 'Kit Manager operation failed');
  error.code = response?.error?.code || 'OPERATION_FAILED';
  throw error;
}

contextBridge.exposeInMainWorld('harborsKitManager', Object.freeze({
  list() {
    return invoke(channels.list);
  },
  refresh() {
    return invoke(channels.refresh);
  },
  install(value) {
    return invoke(channels.install, value);
  },
  activate(value) {
    return invoke(channels.activate, value);
  },
  rollback(value) {
    return invoke(channels.rollback, value);
  },
}));
