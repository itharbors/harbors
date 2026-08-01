import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  AgentProcessRole,
  ProcessSnapshot,
  ProcessTreeMetrics,
  ProcessTreeSnapshot,
} from './types.js';

const execFile = promisify(execFileCallback);
const MAX_PS_OUTPUT_BYTES = 4 * 1024 * 1024;

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

interface ObserveProcessesOptions {
  execFile?: ExecFileLike;
}

export interface BuildProcessTreeOptions {
  maxNodes: number;
  classify: (process: ProcessSnapshot) => AgentProcessRole | null;
  previousPids?: ReadonlySet<number>;
}

export type MeasuredProcessTree = ProcessTreeSnapshot & { metrics: ProcessTreeMetrics };

export function buildProcessTree(
  snapshots: readonly ProcessSnapshot[],
  options: BuildProcessTreeOptions,
): MeasuredProcessTree {
  if (!Number.isSafeInteger(options.maxNodes) || options.maxNodes <= 0) {
    throw new TypeError('maxNodes must be a positive integer');
  }
  const unique = new Map<number, ProcessSnapshot>();
  for (const snapshot of snapshots) {
    if (unique.size >= options.maxNodes) break;
    if (!unique.has(snapshot.pid)) unique.set(snapshot.pid, snapshot);
  }
  const processes = [...unique.values()];
  const children = new Map<number, number>();
  for (const process of processes) {
    children.set(process.ppid, (children.get(process.ppid) ?? 0) + 1);
  }
  const depthMemo = new Map<number, number>();
  const visiting = new Set<number>();
  const depth = (process: ProcessSnapshot): number => {
    const known = depthMemo.get(process.pid);
    if (known !== undefined) return known;
    if (visiting.has(process.pid)) return 1;
    visiting.add(process.pid);
    const parent = unique.get(process.ppid);
    const result = parent?.executableIdentity === process.executableIdentity
      ? depth(parent) + 1
      : 1;
    visiting.delete(process.pid);
    depthMemo.set(process.pid, result);
    return result;
  };
  const roles = processes.map((process) => ({ process, role: options.classify(process) }));
  const taskProcesses = roles.filter(({ role }) => role === 'task' || role === 'hook');
  return {
    observedAt: Date.now(),
    processes,
    metrics: {
      sameExecutableDepth: processes.reduce((maximum, process) => Math.max(maximum, depth(process)), 0),
      maxWidth: Math.max(0, ...children.values()),
      newTaskProcesses: taskProcesses.filter(({ process }) => !options.previousPids?.has(process.pid)).length,
      activeTaskProcesses: taskProcesses.length,
      bounded: unique.size < snapshots.length,
    },
  };
}

function positiveInteger(value: string, context: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${context} is invalid`);
  return parsed;
}

function allowlistedMarkers(executable: string): string[] {
  const markers: string[] = [];
  if (/Codex Helper \(Renderer\)/iu.test(executable)) markers.push('renderer');
  if (/Codex Helper/iu.test(executable) && !markers.includes('renderer')) markers.push('helper');
  return markers;
}

function isAgentExecutable(executable: string): boolean {
  const basename = path.basename(executable).toLowerCase();
  return basename === 'claude'
    || basename === 'codex'
    || basename === 'chatgpt'
    || executable.toLowerCase().includes('/codex.app/');
}

export function parsePsRows(output: string): ProcessSnapshot[] {
  if (Buffer.byteLength(output) > MAX_PS_OUTPUT_BYTES) throw new TypeError('ps output exceeds size limit');
  const snapshots: ProcessSnapshot[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    const tabFields = line.split('\t');
    const macFields = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u,
    );
    let fields: string[];
    if (tabFields.length === 5) {
      fields = tabFields;
    } else if (macFields) {
      const start = Date.parse(macFields[4]);
      if (!Number.isFinite(start)) continue;
      fields = [macFields[1], macFields[2], macFields[3], String(start), macFields[5]];
    } else {
      continue;
    }
    const [pid, ppid, processGroupId, processStartTime, executable] = fields;
    const isBareAgentExecutable = path.basename(executable) === executable
      && isAgentExecutable(executable);
    if (!path.isAbsolute(executable) && !isBareAgentExecutable) continue;
    snapshots.push({
      pid: positiveInteger(pid, 'pid'),
      ppid: positiveInteger(ppid, 'ppid'),
      processGroupId: positiveInteger(processGroupId, 'processGroupId'),
      processStartTime: positiveInteger(processStartTime, 'processStartTime'),
      executable,
      executableIdentity: `path:${executable}`,
      commandMarkers: allowlistedMarkers(executable),
      parentRoleHint: null,
    });
  }
  const byPid = new Map(snapshots.map((snapshot) => [snapshot.pid, snapshot]));
  return snapshots.map((snapshot) => {
    const parent = byPid.get(snapshot.ppid);
    return parent && isAgentExecutable(parent.executable)
      ? { ...snapshot, parentRoleHint: 'host' }
      : snapshot;
  });
}

export async function observeProcesses(options: ObserveProcessesOptions = {}): Promise<ProcessSnapshot[]> {
  const runExecFile = options.execFile ?? (execFile as unknown as ExecFileLike);
  const { stdout } = await runExecFile('/bin/ps', [
    '-axo', 'pid=,ppid=,pgid=,lstart=,comm=',
  ], {
    maxBuffer: MAX_PS_OUTPUT_BYTES,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  // Production callers may replace this command adapter with a tab-delimited native snapshot.
  // Never return raw ps text; an unsupported layout becomes an empty, incomplete observation.
  return parsePsRows(stdout);
}
