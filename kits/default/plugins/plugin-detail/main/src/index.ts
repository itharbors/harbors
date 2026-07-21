declare const editor: any;

let runtime: any;

editor.plugin.define({
  lifecycle: {
    load(ctx: any) {
      runtime = ctx;
    },
  },
  methods: {
    openDetailPanel() {
      return runtime.window.openPanel('@itharbors/plugin-detail.detail');
    },
  },
});
