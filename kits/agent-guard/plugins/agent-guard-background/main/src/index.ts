import { createDefaultAgentGuardService } from './service.js';

declare const editor: any;

interface AgentGuardRuntime {
  readonly paths: {
    readonly data: string;
    readonly legacyData: readonly string[];
  };
  readonly host: {
    readonly mode: 'desktop' | 'web';
  };
}

let service: Awaited<ReturnType<typeof createDefaultAgentGuardService>> | null = null;

editor.plugin.define({
  lifecycle: {
    async load(runtime: AgentGuardRuntime) {
      service = await createDefaultAgentGuardService({
        dataDir: runtime.paths.data,
        legacyDataDirs: runtime.paths.legacyData,
        hostMode: runtime.host.mode,
        notificationPort: process.env.HARBORS_NOTIFICATION_PORT,
      });
      await service.start();
    },
    async unload() {
      await service?.dispose();
      service = null;
    },
  },
  methods: {
    getSnapshot: () => requireService().getSnapshot(),
    updatePolicy: (input: unknown) => requireService().updatePolicy(input),
    executeCommand: (input: unknown) => requireService().executeCommand(input),
    getIncidents: (input: unknown) => requireService().getIncidents(input),
  },
});

function requireService() {
  if (!service) throw new Error('Agent Guard background service is unavailable');
  return service;
}
