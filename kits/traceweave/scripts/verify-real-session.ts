import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { discoverCodexRuns } from '../plugins/traceweave-core/main/dist/codex-discovery.js';
import { TraceweaveService } from '../plugins/traceweave-core/main/dist/service.js';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function sourceSnapshot(runs) {
  return new Map(await Promise.all(runs.map(async (run) => {
    const value = await stat(run.rolloutPath);
    return [run.rolloutPath, `${value.size}:${value.mtimeMs}`];
  })));
}

function snapshotsEqual(before, after) {
  return before.size === after.size
    && [...before].every(([file, value]) => after.get(file) === value);
}

export async function verifyRealSession(codexHome) {
  const discoveredBefore = await discoverCodexRuns(codexHome);
  const before = await sourceSnapshot(discoveredBefore);
  const service = new TraceweaveService(codexHome);
  try {
    const summaries = await service.listRuns();
    const active = summaries.filter((summary) => !summary.archived).length;
    const archived = summaries.filter((summary) => summary.archived).length;
    if (active + archived !== summaries.length) throw new Error('INVALID_SESSION_COUNTS');
    let trace;
    for (const summary of summaries.slice(0, 20)) {
      const candidate = await service.loadRun({ runId: summary.id });
      if (candidate.turns.some((turn) => turn.nodes.length > 0)) { trace = candidate; break; }
    }
    if (!trace) throw new Error('NO_ELIGIBLE_RUN');

    const nodes = trace.turns.flatMap((turn) => turn.nodes);
    const discoveredAfter = await discoverCodexRuns(codexHome);
    const after = await sourceSnapshot(discoveredAfter);
    const unchanged = snapshotsEqual(before, after);
    if (!unchanged) throw new Error('SOURCE_CHANGED');

    return [
      'TraceWeave real-session verification: PASS',
      `sessions=${summaries.length} active=${active} archived=${archived}`,
      `turns=${trace.turns.length} nodes=${nodes.length} edges=${trace.turns.reduce((sum, turn) => sum + turn.edges.length, 0)}`,
      `observed=${nodes.filter((node) => node.evidence.class === 'observed').length} derived=${nodes.filter((node) => node.evidence.class === 'derived').length} inferred=${nodes.filter((node) => node.evidence.class === 'inferred').length}`,
      `warnings=${trace.warnings.length} source_unchanged=${unchanged}`,
    ].join('\n');
  } finally {
    service.dispose();
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const codexHome = path.resolve(argument('--codex-home') ?? process.env.CODEX_HOME?.trim() ?? path.join(homedir(), '.codex'));
  verifyRealSession(codexHome)
    .then((output) => process.stdout.write(`${output}\n`))
    .catch((error) => {
      const reason = error instanceof Error && error.message === 'NO_ELIGIBLE_RUN'
        ? 'no_eligible_run'
        : error instanceof Error && error.message === 'SOURCE_CHANGED'
          ? 'source_changed'
          : 'verification_failed';
      process.stderr.write(`TraceWeave real-session verification: FAIL\nreason=${reason}\n`);
      process.exitCode = 1;
    });
}
