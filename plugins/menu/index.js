import { defaultMenuContributions, defaultMenuMessages } from './default-menu.js';

let runtime;
let disposeMessages = () => {};

export function load(ed) {
  runtime = ed;
  runtime.menu.setDefaults(defaultMenuContributions);
  disposeMessages = runtime.i18n.registerMessages(defaultMenuMessages);
}

export function attach(pluginName, contribute) {
  runtime.menu.attach(pluginName, contribute);
}

export function detach(pluginName) {
  runtime.menu.detach(pluginName);
}

export function unload() {
  runtime?.menu.clearDefaults();
  disposeMessages();
  disposeMessages = () => {};
}

if (typeof editor !== 'undefined' && editor?.plugin?.define) {
  editor.plugin.define({
    lifecycle: {
      load,
      unload,
      attach,
      detach,
    },
    methods: {
      newSession() {
        return { ok: true, action: 'newSession' };
      },
      openDocumentation() {
        return { ok: true, action: 'openDocumentation' };
      },
      openAbout() {
        return { ok: true, action: 'openAbout' };
      },
    },
  });
}
