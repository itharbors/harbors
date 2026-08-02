declare const editor: any;

const CENTER_PANEL = '@itharbors/notification-center.center';
const BACKGROUND_PLUGIN = '@itharbors/notification-background';

let runtime: any;

editor.plugin.define({
  lifecycle: {
    load(ctx: any) {
      runtime = ctx;
    },
  },
  methods: {
    getSnapshot() {
      return runtime.application.request(BACKGROUND_PLUGIN, 'getSnapshot');
    },
    markRead(id: unknown) {
      return runtime.application.request(BACKGROUND_PLUGIN, 'markRead', requireId(id));
    },
    markAllRead() {
      return runtime.application.request(BACKGROUND_PLUGIN, 'markAllRead');
    },
    removeNotification(id: unknown) {
      return runtime.application.request(BACKGROUND_PLUGIN, 'removeNotification', requireId(id));
    },
    openCenterPanel() {
      return runtime.window.openPanel(CENTER_PANEL);
    },
  },
});

function requireId(id: unknown): string {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('Notification id is required');
  }
  return id;
}
