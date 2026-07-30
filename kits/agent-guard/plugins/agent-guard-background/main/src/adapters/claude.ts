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
  readClaudeConfiguration,
  readJsonFile,
} from './config-reader.js';

export interface ClaudeAdapterOptions {
  settingsPath?: string;
  sessionsDirectory?: string;
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): AgentAdapter {
  return {
    id: 'claude',
    async discoverConfiguration() {
      if (!options.settingsPath) return readClaudeConfiguration({});
      try {
        return readClaudeConfiguration(await readJsonFile(options.settingsPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return readClaudeConfiguration({});
        throw error;
      }
    },
    classifyProcess: classifyClaudeProcess,
    discoverSessionActivity: (sinceMs) => (
      discoverSessionMetadata('claude', options.sessionsDirectory, sinceMs)
    ),
    selectSafeControlTarget(tree, incident) {
      return selectSafeTarget(tree, incident, classifyClaudeProcess);
    },
  };
}

function classifyClaudeProcess(process: ProcessSnapshot): AgentProcessRole | null {
  if (path.basename(process.executable).toLowerCase() !== 'claude') return null;
  if (process.commandMarkers.includes('hook')) return 'hook';
  if (process.commandMarkers.includes('task') || process.parentRoleHint === 'host') return 'task';
  return 'host';
}

function selectSafeTarget(
  tree: ProcessTreeSnapshot,
  incident: IncidentEvidence,
  classify: (process: ProcessSnapshot) => AgentProcessRole | null,
): ControlTargetCandidate | null {
  if (incident.agent !== 'claude' || incident.confidence !== 'confirmed') return null;
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
