import { createKitManagerView } from './lib/kit-manager-view.mjs';

const view = createKitManagerView({
  document,
  api: window.harborsKitManager,
  confirmInstall: (message) => window.confirm(message),
});

void view.start();
