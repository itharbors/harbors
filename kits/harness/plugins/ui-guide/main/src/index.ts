declare const editor: any;
let runtime: any;
editor.plugin.define({
  lifecycle: { load(context: any) { runtime = context; } },
  methods: {
    openGuide() { return runtime.window.openPanel('ui-guide.main'); },
    getLocalGuidePanel() { return { type: 'local-panel', panelName: 'ui-guide.main' }; },
  },
});
