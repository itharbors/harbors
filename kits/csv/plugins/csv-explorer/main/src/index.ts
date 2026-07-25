declare const editor: { plugin: { define(definition: unknown): void } };

editor.plugin.define({
  lifecycle: {
    load() {},
    unload() {},
  },
});
