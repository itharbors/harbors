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
  signal(target: number, signal: 'SIGSTOP' | 'SIGCONT' | 'SIGTERM' | 'SIGKILL'): void | Promise<void>;
  saveLedger(entries: ControlLedgerEntryV1[]): Promise<void>;
  wait(milliseconds: number): Promise<void>;
}

export function createProcessController(options: ProcessControllerOptions) {
  const paused = new Map<number, { target: VerifiedControlTarget; incidentId: string }>();

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
    return live;
  };

  const persistLedger = () => options.saveLedger([...paused.values()].map(({ target, incidentId }) => ({
    schemaVersion: 1,
    incidentId,
    pid: target.pid,
    processGroupId: target.processGroupId,
    processStartTime: target.processStartTime,
    executableIdentity: target.executableIdentity,
    action: 'paused',
  })));

  return {
    async pause(target: VerifiedControlTarget, incidentId = 'unknown') {
      if (paused.has(target.pid)) return;
      await revalidate(target);
      paused.set(target.pid, { target: { ...target }, incidentId });
      await persistLedger();
      try {
        await options.signal(-target.processGroupId, 'SIGSTOP');
      } catch (error) {
        paused.delete(target.pid);
        await persistLedger();
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
