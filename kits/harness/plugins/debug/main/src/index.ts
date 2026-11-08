declare const editor: any;

editor.plugin.define({
  lifecycle: {
    load(ctx) {
      runtime = ctx;
    },
  },
  methods: {
    openDebugPanel() {
      return runtime.window.openPanel('debug.debug');
    },
    getLocalDebugPanel() {
      return { type: 'local-panel', panelName: 'debug.debug' };
    },
  },
});

let runtime;
