import os from 'node:os';
import path from 'node:path';

import { createSkillService, type SkillService } from './skill-service.js';

declare const editor: any;

let service: SkillService | undefined;

editor.plugin.define({
  lifecycle: {
    async load(runtime: { message: { broadcast(topic: string, payload: unknown): void } }) {
      service?.dispose();
      service = await createSkillService({
        codexHome: resolveCodexHome(),
        homeDirectory: os.homedir(),
        broadcast: (topic, payload) => runtime.message.broadcast(topic, payload),
      });
    },
    async unload() {
      service?.dispose();
      service = undefined;
    },
  },
  methods: {
    getSnapshot: () => requiredService().getSnapshot(),
    browseDirectory: (input: unknown) => requiredService().browseDirectory(input),
    selectSource: (input: unknown) => requiredService().selectSource(input),
    clearSource: () => requiredService().clearSource(),
    rescan: () => requiredService().rescan(),
    getSkillDetail: (input: unknown) => requiredService().getSkillDetail(input),
    performAction: (input: unknown) => requiredService().performAction(input),
  },
});

function requiredService(): SkillService {
  if (!service) throw new Error('Skill Manager is not loaded');
  return service;
}

function resolveCodexHome(): string {
  const configured = process.env.CODEX_HOME;
  if (configured !== undefined && configured !== '') {
    if (!path.isAbsolute(configured)) throw new Error('CODEX_HOME must be an absolute path');
    return configured;
  }
  return path.join(os.homedir(), '.codex');
}
