declare const editor: any;

const SERVICE = '@itharbors/scheduler-service';
let runtime: any;

editor.plugin.define({
  lifecycle: {
    load(context: any) { runtime = context; },
    unload() { runtime = null; },
  },
  methods: {
    scheduler(method: string, ...args: unknown[]) {
      if (!runtime) throw new Error('Scheduler panel service is unavailable');
      return runtime.application.request(SERVICE, method, ...args);
    },
  },
});
