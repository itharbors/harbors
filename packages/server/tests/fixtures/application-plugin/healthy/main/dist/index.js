let counter = 0;

globalThis.editor.plugin.define({
  methods: {
    ping() {
      counter += 1;
      return { pid: process.pid, counter };
    },
  },
});
