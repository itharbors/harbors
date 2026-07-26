import signedConfig from './electron-builder.config.mjs';

export default {
  ...signedConfig,
  mac: {
    ...signedConfig.mac,
    identity: null,
    notarize: false,
  },
};
