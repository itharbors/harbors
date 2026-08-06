import type { AttributionConfidence } from '@itharbors/agent-guard-contracts';

export type AgentId = 'claude' | 'codex';
export type AgentProcessRole = 'host' | 'task' | 'hook' | 'helper';

export interface AgentConfiguration {
  agent: AgentId;
  provider: string;
  endpoint: string;
  model?: string;
  hookExecutables: Array<{ event: string; executable: string }>;
}

export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  processGroupId: number;
  processStartTime: number;
  executable: string;
  executableIdentity: string;
  commandMarkers: string[];
  parentRoleHint: AgentProcessRole | null;
}

export interface ProcessTreeSnapshot {
  observedAt: number;
  processes: ProcessSnapshot[];
}

export interface ProcessTreeMetrics {
  sameExecutableDepth: number;
  maxWidth: number;
  newTaskProcesses: number;
  activeTaskProcesses: number;
  bounded: boolean;
}

export interface ConnectionCounter {
  observedAt: number;
  pid: number;
  processStartTime: number;
  executableIdentity: string;
  localAddress: string;
  remoteAddress: string;
  transport: 'tcp' | 'udp';
  state: string;
  bytesIn: bigint;
  bytesOut: bigint;
}

export interface SessionActivity {
  agent: AgentId;
  observedAt: number;
  sessionIdHash: string;
  kind: 'created' | 'updated';
}

export interface IncidentEvidence {
  agent: AgentId;
  confidence: AttributionConfidence;
  processIds: number[];
  evidenceCodes: string[];
}

export interface ControlTargetCandidate {
  pid: number;
  processGroupId: number;
  processStartTime: number;
  executableIdentity: string;
  role: Extract<AgentProcessRole, 'task' | 'hook'>;
}

export interface AgentAdapter {
  id: AgentId;
  discoverConfiguration(): Promise<AgentConfiguration>;
  discoverConfigurations(): Promise<AgentConfiguration[]>;
  classifyProcess(process: ProcessSnapshot): AgentProcessRole | null;
  discoverSessionActivity(sinceMs: number): Promise<SessionActivity[]>;
  selectSafeControlTarget(
    tree: ProcessTreeSnapshot,
    incident: IncidentEvidence,
  ): ControlTargetCandidate | null;
}
