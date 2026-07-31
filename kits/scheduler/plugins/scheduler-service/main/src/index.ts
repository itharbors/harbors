import path from 'node:path';

import { createScheduler, type Scheduler } from './scheduler.js';
import { createScriptRunner } from './script-runner.js';
import { createSchedulerStore } from './store.js';

declare const editor: any;

let scheduler: Scheduler | null = null;

editor.plugin.define({
  lifecycle: {
    async load() {
      const dataRoot = process.env.HARBORS_DATA_ROOT?.trim()
        || path.resolve(process.cwd(), '.harbors-data');
      scheduler = createScheduler({
        store: createSchedulerStore(path.join(dataRoot, 'kits', 'scheduler', 'state.v1.json')),
        runner: createScriptRunner(),
      });
      await scheduler.initialize();
    },
    async unload() {
      const current = scheduler;
      scheduler = null;
      await current?.dispose();
    },
  },
  methods: {
    getSnapshot() {
      return requireScheduler().getSnapshot();
    },
    saveJob(input: unknown) {
      return requireScheduler().saveJob(input);
    },
    deleteJob(id: unknown) {
      return requireScheduler().deleteJob(id);
    },
    setJobEnabled(id: unknown, enabled: unknown) {
      return requireScheduler().setJobEnabled(id, enabled);
    },
    runJobNow(id: unknown) {
      return requireScheduler().runJobNow(id);
    },
  },
});

function requireScheduler(): Scheduler {
  if (!scheduler) throw new Error('Scheduler service is unavailable');
  return scheduler;
}
