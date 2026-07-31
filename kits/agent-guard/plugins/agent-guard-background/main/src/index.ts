import { createDefaultAgentGuardService } from './service.js';

declare const editor: any;

let service: Awaited<ReturnType<typeof createDefaultAgentGuardService>> | null = null;

editor.plugin.define({
  lifecycle: {
    async load() {
      service = await createDefaultAgentGuardService(process.env);
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
