declare const editor: any;

let runtime;
const startTime = Date.now();

editor.plugin.define({
  lifecycle: {
    load(ctx) {
      runtime = ctx;
    },
  },
  methods: {
    openStatusPanel() {
      return runtime.window.openPanel('@ce/status-bar.status');
    },
    getStatus() {
      return {
        uptime: Date.now() - startTime,
        kits: runtime.kit.list().map((kit) => kit.name),
        activeKit: runtime.kit.getCurrent()?.name ?? null,
        panels: runtime.panel.list(),
        pluginsLoaded: runtime.plugin.listLoaded().length,
        pluginsRegistered: runtime.plugin.listRegistered().length,
      };
    },
  },
});
