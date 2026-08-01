const { contextBridge, ipcRenderer } = require('electron');

const channels = Object.freeze({
  list: 'harbors:kit-manager:list',
  refresh: 'harbors:kit-manager:refresh',
  install: 'harbors:kit-manager:install',
  activate: 'harbors:kit-manager:activate',
  rollback: 'harbors:kit-manager:rollback',
  deactivate: 'harbors:kit-manager:deactivate',
  uninstall: 'harbors:kit-manager:uninstall',
});

const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const controlPattern = /[\u0000-\u001F\u007F-\u009F]/;

function validText(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && !controlPattern.test(value);
}

function parseFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !['code', 'message', 'causes'].includes(key))) return null;
  if (typeof value.code !== 'string' || !codePattern.test(value.code) || !validText(value.message)) {
    return null;
  }
  if (value.causes !== undefined) {
    if (
      !Array.isArray(value.causes)
      || value.causes.length === 0
      || value.causes.length > 4
      || value.causes.some((cause) => !validText(cause))
    ) return null;
  }
  return {
    code: value.code,
    message: value.message,
    ...(value.causes ? { causes: Object.freeze([...value.causes]) } : {}),
  };
}

async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (response?.ok === true) return response.value;
  const failure = parseFailure(response?.error) || {
    code: 'OPERATION_FAILED',
    message: 'Kit Manager operation failed',
  };
  const error = new Error(failure.message);
  error.code = failure.code;
  if (failure.causes) error.causes = failure.causes;
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
  deactivate(value) {
    return invoke(channels.deactivate, value);
  },
  uninstall(value) {
    return invoke(channels.uninstall, value);
  },
}));
