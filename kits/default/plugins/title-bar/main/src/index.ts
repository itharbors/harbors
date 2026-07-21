declare const editor: any;

let runtime;

editor.plugin.define({
  lifecycle: {
    load(ctx) {
      runtime = ctx;
    },
  },
  methods: {
    openTitlePanel() {
      return runtime.window.openPanel('@itharbors/title-bar.title');
    },
    getTitle() {
      const activeKit = runtime.kit.getCurrent();
      return {
        product: 'ITHARBORS',
        kit: activeKit?.name ?? null,
        kitVersion: activeKit?.version ?? null,
      };
    },
  },
});
