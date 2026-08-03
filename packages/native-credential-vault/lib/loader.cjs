'use strict';

const REQUIRED_EXPORTS = Object.freeze(['getPassword', 'setPassword', 'deletePassword']);

function unavailableError() {
  const error = new Error('System credential backend unavailable');
  error.code = 'BACKEND_UNAVAILABLE';
  return error;
}

function createBindingLoader({ platform, arch, loadBinding }) {
  return function load() {
    if (platform !== 'darwin' || arch !== 'arm64' || typeof loadBinding !== 'function') {
      throw unavailableError();
    }

    let binding;
    try {
      binding = loadBinding();
    } catch {
      throw unavailableError();
    }
    if (
      !binding
      || (typeof binding !== 'object' && typeof binding !== 'function')
      || REQUIRED_EXPORTS.some((name) => typeof binding[name] !== 'function')
    ) {
      throw unavailableError();
    }
    return binding;
  };
}

module.exports = { createBindingLoader };
