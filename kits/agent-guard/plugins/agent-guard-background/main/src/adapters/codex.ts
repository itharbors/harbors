import path from 'node:path';

import type {
  AgentAdapter,
  AgentProcessRole,
  ControlTargetCandidate,
  IncidentEvidence,
  ProcessSnapshot,
  ProcessTreeSnapshot,
} from '../types.js';
import {
  discoverSessionMetadata,
  readCodexConfiguration,
  readTextFile,
} from './config-reader.js';

export interface CodexAdapterOptions {
  configPath?: string;
  sessionsDirectory?: string;
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): AgentAdapter {
  return {
    id: 'codex',
    async discoverConfiguration() {
      if (!options.configPath) return readCodexConfiguration('');
      try {
        return readCodexConfiguration(await readTextFile(options.configPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return readCodexConfiguration('');
        throw error;
      }
    },
    classifyProcess: classifyCodexProcess,
    discoverSessionActivity: (sinceMs) => (
      discoverSessionMetadata('codex', options.sessionsDirectory, sinceMs)
    ),
    selectSafeControlTarget(tree, incident) {
      return selectSafeTarget(tree, incident, classifyCodexProcess);
    },
  };
}

function classifyCodexProcess(process: ProcessSnapshot): AgentProcessRole | null {
  const executable = process.executable.toLowerCase();
  const basename = path.basename(executable);
  const isCodex = basename === 'codex' || executable.includes('codex.app') || basename.includes('codex helper');
  if (!isCodex) return null;
  if (basename.includes('helper') || process.commandMarkers.some((marker) => (
    ['renderer', 'helper', 'app-server'].includes(marker)
  ))) return 'host';
  if (basename === 'codex' && process.parentRoleHint === 'host') return 'task';
  if (executable.includes('.app/')) return 'host';
  if (process.parentRoleHint === 'host' || process.commandMarkers.includes('task')) return 'task';
  return 'host';
}

function selectSafeTarget(
  tree: ProcessTreeSnapshot,
  incident: IncidentEvidence,
  classify: (process: ProcessSnapshot) => AgentProcessRole | null,
): ControlTargetCandidate | null {
  if (incident.agent !== 'codex' || incident.confidence !== 'confirmed') return null;
  const selected = tree.processes.filter((process) => incident.processIds.includes(process.pid));
  if (selected.length !== 1) return null;
  const process = selected[0];
  const role = classify(process);
  if (role !== 'task' && role !== 'hook') return null;
  const sharesHostGroup = tree.processes.some((candidate) => (
    candidate.pid !== process.pid
    && candidate.processGroupId === process.processGroupId
    && classify(candidate) === 'host'
  ));
  if (sharesHostGroup) return null;
  return {
    pid: process.pid,
    processGroupId: process.processGroupId,
    processStartTime: process.processStartTime,
    executableIdentity: process.executableIdentity,
    role,
  };
}
