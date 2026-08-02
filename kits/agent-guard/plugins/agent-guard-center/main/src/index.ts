declare const editor: any;

const BACKGROUND = '@itharbors/agent-guard-background';
const PANEL = '@itharbors/agent-guard-center.guard';
let runtime: any;

editor.plugin.define({
  lifecycle: {
    load(context: any) { runtime = context; },
    unload() { runtime = null; },
  },
  methods: {
    getSnapshot: () => requireRuntime().application.request(BACKGROUND, 'getSnapshot'),
    updatePolicy: (input: unknown) => requireRuntime().application.request(BACKGROUND, 'updatePolicy', input),
    executeCommand: (input: unknown) => requireRuntime().application.request(BACKGROUND, 'executeCommand', input),
    getIncidents: (input: unknown) => requireRuntime().application.request(BACKGROUND, 'getIncidents', input),
    getTrafficHistory: (input: unknown) => requireRuntime().application.request(BACKGROUND, 'getTrafficHistory', input),
    getHistoryStatus: () => requireRuntime().application.request(BACKGROUND, 'getHistoryStatus'),
    updateHistorySettings: (input: unknown) => requireRuntime().application.request(BACKGROUND, 'updateHistorySettings', input),
    runHistoryBackfill: (input: unknown) => requireRuntime().application.request(BACKGROUND, 'runHistoryBackfill', input),
    clearHistory: (input: unknown) => requireRuntime().application.request(BACKGROUND, 'clearHistory', input),
    openGuardPanel: () => requireRuntime().window.openPanel(PANEL),
  },
});

function requireRuntime() {
  if (!runtime) throw new Error('Agent Guard center is unavailable');
  return runtime;
}
