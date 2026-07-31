import { createHmac, randomBytes } from 'node:crypto';

import type { DiscoveredRun } from './codex-discovery.js';

export class RunRegistry {
  readonly #secret = randomBytes(32);
  readonly #runs = new Map<string, DiscoveredRun>();

  replace(runs: DiscoveredRun[]): void {
    this.#runs.clear();
    for (const run of runs) this.#runs.set(this.idFor(run.rolloutPath), run);
  }

  idFor(rolloutPath: string): string {
    return createHmac('sha256', this.#secret).update(rolloutPath).digest('base64url').slice(0, 22);
  }

  get(id: string): DiscoveredRun | undefined { return this.#runs.get(id); }
  entries(): Array<[string, DiscoveredRun]> { return [...this.#runs.entries()]; }
}
