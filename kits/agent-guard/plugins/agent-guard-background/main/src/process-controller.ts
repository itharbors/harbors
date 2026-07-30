import type { AgentProcessRole } from './types.js';
import type { ControlLedgerEntryV1 } from './storage.js';

export interface VerifiedControlTarget {
  pid: number;
  processStartTime: number;
  executableIdentity: string;
  processGroupId: number;
  role: 'task' | 'hook';
}

export type LiveControlProcess = Omit<VerifiedControlTarget, 'role'> & {
  ppid?: number;
  role: AgentProcessRole;
};

export type ControlTargetErrorCode = 'CONTROL_TARGET_STALE' | 'CONTROL_TARGET_UNSAFE';

export class ControlTargetError extends Error {
  constructor(readonly code: ControlTargetErrorCode, message: string) {
    super(message);
    this.name = 'ControlTargetError';
  }
}

interface ProcessControllerOptions {
  getProcess(pid: number): Promise<LiveControlProcess | null>;
  listDescendants(pid: number): Promise<LiveControlProcess[]>;
  listProcessGroup?: (processGroupId: number) => Promise<LiveControlProcess[]>;
  signal(target: number, signal: 'SIGSTOP' | 'SIGCONT' | 'SIGTERM' | 'SIGKILL'): void | Promise<void>;
  saveLedger(entries: ControlLedgerEntryV1[]): Promise<void>;
  onLedgerChanged?: (entries: ControlLedgerEntryV1[]) => Promise<void> | void;
  wait(milliseconds: number): Promise<void>;
  isProtectedProcessGroup?: (processGroupId: number) => boolean;
}

export function createProcessController(options: ProcessControllerOptions) {
  const paused = new Map<number, {
    target: VerifiedControlTarget;
    incidentId: string;
    members: VerifiedControlTarget[];
  }>();

  const revalidate = async (target: VerifiedControlTarget): Promise<LiveControlProcess> => {
    if (target.role !== 'task' && target.role !== 'hook') {
      throw new ControlTargetError('CONTROL_TARGET_UNSAFE', 'Only task and Hook targets may be controlled');
    }
    const live = await options.getProcess(target.pid);
    if (!live
      || live.pid !== target.pid
      || live.processStartTime !== target.processStartTime
      || live.executableIdentity !== target.executableIdentity
      || live.processGroupId !== target.processGroupId) {
      throw new ControlTargetError('CONTROL_TARGET_STALE', 'Control target identity changed');
    }
    if (live.role !== target.role || (live.role !== 'task' && live.role !== 'hook')) {
      throw new ControlTargetError('CONTROL_TARGET_UNSAFE', 'Control target role is unsafe');
    }
    if (options.isProtectedProcessGroup?.(live.processGroupId)) {
      throw new ControlTargetError('CONTROL_TARGET_UNSAFE', 'Control target shares a protected process group');
    }
    return live;
  };

  const ledgerEntries = () => (
    [...paused.values()].flatMap(({ members, incidentId }) => members.map((target) => ({
        schemaVersion: 1 as const,
        incidentId,
        pid: target.pid,
        processGroupId: target.processGroupId,
        processStartTime: target.processStartTime,
        executableIdentity: target.executableIdentity,
        action: 'paused' as const,
      })))
  );
  const persistLedger = async () => {
    const entries = ledgerEntries();
    await options.saveLedger(entries);
    await options.onLedgerChanged?.(entries);
  };
  const rollbackPause = async (pid: number) => {
    paused.delete(pid);
    const entries = ledgerEntries();
    try { await options.saveLedger(entries); } catch { /* preserve the control failure */ }
    try { await options.onLedgerChanged?.(entries); } catch { /* preserve the control failure */ }
  };

  return {
    async pause(target: VerifiedControlTarget, incidentId = 'unknown') {
      if (paused.has(target.pid)) return;
      const live = await revalidate(target);
      const candidates = options.listProcessGroup
        ? await options.listProcessGroup(target.processGroupId)
        : [live];
      const members = [...new Map(candidates.map((candidate) => [candidate.pid, candidate])).values()];
      if (!members.some((candidate) => candidate.pid === target.pid)) members.push(live);
      for (const member of members) await revalidate(member as VerifiedControlTarget);
      paused.set(target.pid, {
        target: { ...target }, incidentId,
        members: members.map((member) => ({ ...member, role: member.role as 'task' | 'hook' })),
      });
      try {
        await persistLedger();
        await options.signal(-target.processGroupId, 'SIGSTOP');
      } catch (error) {
        await rollbackPause(target.pid);
        throw error;
      }
    },
    async resume(target: VerifiedControlTarget) {
      if (!paused.has(target.pid)) return;
      await revalidate(target);
      await options.signal(-target.processGroupId, 'SIGCONT');
      paused.delete(target.pid);
      await persistLedger();
    },
    async terminateRecursive(target: VerifiedControlTarget) {
      await revalidate(target);
      const descendants = await options.listDescendants(target.pid);
      const original = [
        ...descendants.filter((candidate) => candidate.role === 'task' || candidate.role === 'hook'),
        { ...target },
      ];
      const byPid = new Map(original.map((candidate) => [candidate.pid, candidate]));
      const depth = (candidate: LiveControlProcess): number => {
        let result = 0;
        let current: LiveControlProcess | undefined = candidate;
        const seen = new Set<number>();
        while (current?.ppid && byPid.has(current.ppid) && !seen.has(current.pid)) {
          seen.add(current.pid);
          result += 1;
          current = byPid.get(current.ppid);
        }
        return result;
      };
      const ordered = [...original].sort((left, right) => depth(right) - depth(left));
      for (const candidate of ordered) {
        await revalidate(candidate as VerifiedControlTarget);
        await options.signal(candidate.pid, 'SIGTERM');
      }
      await options.wait(3_000);
      for (const candidate of ordered) {
        try {
          await revalidate(candidate as VerifiedControlTarget);
          await options.signal(candidate.pid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof ControlTargetError) || error.code !== 'CONTROL_TARGET_STALE') throw error;
        }
      }
    },
    pausedTargets: () => [...paused.values()].map(({ target }) => ({ ...target })),
  };
}
