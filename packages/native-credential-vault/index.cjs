'use strict';

const { createBindingLoader } = require('./lib/loader.cjs');

module.exports = createBindingLoader({
  platform: process.platform,
  arch: process.arch,
  loadBinding: () => require('./build/Release/harbors_native_credential_vault.node'),
})();
