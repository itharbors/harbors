import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolve4, resolve6 } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';

import {
  normalizeCommand,
  normalizePolicy,
  normalizeSnapshot,
  type AgentEndpointSnapshot,
  type AgentGuardSnapshot,
  type IncidentSummary,
  type PolicyV1,
} from '@itharbors/agent-guard-contracts';
import { createClaudeAdapter } from './adapters/claude.js';
import { createCodexAdapter } from './adapters/codex.js';
import { DnsHistory, attributeConnection } from './attribution.js';
import { RollingBaseline } from './baseline.js';
import { BoundedMap, BoundedSet } from './bounded-cache.js';
import {
  computeCounterDelta,
  createNetstatCollector,
  createNetstatSnapshotParser,
  type EpochCounter,
} from './netstat-collector.js';
import { observeProcesses } from './process-observer.js';
import { buildProcessTree } from './process-observer.js';
import { createProcessController, type VerifiedControlTarget } from './process-controller.js';
import { PolicyEngine } from './policy.js';
import { createIncidentNotifier } from './notifications.js';
import { createAgentGuardStore, type PersistedIncidentV1, type PersistedMetricV1 } from './storage.js';
import { createWatchdogClient } from './watchdog.js';
import type { AgentProcessRole, ProcessSnapshot } from './types.js';

interface CollectorLike {
  start(): void;
  stop(): void;
  snapshot(): { running: boolean; epoch: number; incomplete?: boolean; lastObservedAt?: number | null };
}

interface ControllerLike {
  pause(target: VerifiedControlTarget, incidentId?: string): Promise<void> | void;
  resume(target: VerifiedControlTarget): Promise<void> | void;
  terminateRecursive(target: VerifiedControlTarget): Promise<void> | void;
  pausedTargets(): VerifiedControlTarget[];
}

interface AgentGuardServiceOptions {
  collector: CollectorLike;
  controller: ControllerLike;
  initialPolicy: PolicyV1;
  scheduleInterval: typeof setInterval;
  clearScheduledInterval: typeof clearInterval;
  flushMetrics(): Promise<void> | void;
  evaluate(): Promise<void> | void;
  endpoints?: () => AgentEndpointSnapshot[];
  onStart?: () => Promise<void> | void;
  onDispose?: () => Promise<void> | void;
  onPolicyChanged?: (policy: PolicyV1) => Promise<void> | void;
  isLearning?: () => boolean;
}

export function createAgentGuardService(options: AgentGuardServiceOptions) {
  let started = false;
  let disposed = false;
  let policy = normalizePolicy(options.initialPolicy);
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const incidentTargets = new Map<string, VerifiedControlTarget>();
  const incidents: IncidentSummary[] = [];
  const ignoredUntil = new Map<string, number>();

  return {
    async start() {
      if (started) return;
      if (disposed) throw new Error('Agent Guard service is disposed');
      started = true;
      await options.onStart?.();
      options.collector.start();
      timers.push(options.scheduleInterval(() => {
        void Promise.resolve(options.flushMetrics()).catch(() => undefined);
      }, 10_000));
      timers.push(options.scheduleInterval(() => {
        void Promise.resolve(options.evaluate()).catch(() => undefined);
      }, policy.evaluationWindowSeconds * 1000));
    },
    async getSnapshot(): Promise<AgentGuardSnapshot> {
      const collector = options.collector.snapshot();
      const incidentState = incidents.some((incident) => incident.state === 'tripped')
        ? 'tripped'
        : incidents.some((incident) => incident.state === 'warning') ? 'warning' : undefined;
      return normalizeSnapshot({
        schemaVersion: 1,
        observedAt: Date.now(),
        state: !collector.running || collector.incomplete ? 'degraded' : incidentState ?? (options.isLearning?.() ? 'learning' : 'normal'),
        collector: {
          status: collector.running ? 'running' : 'degraded',
          epoch: collector.epoch,
          lastObservedAt: collector.lastObservedAt ?? null,
          incomplete: !collector.running || Boolean(collector.incomplete),
        },
        endpoints: options.endpoints?.() ?? [],
        incidents,
      });
    },
    async updatePolicy(input: unknown) {
      policy = normalizePolicy(input);
      await options.onPolicyChanged?.(policy);
      return policy;
    },
    async executeCommand(input: unknown) {
      const command = normalizeCommand(input);
      const target = incidentTargets.get(command.incidentId);
      if (!target && command.type !== 'ignore') throw new Error('Incident has no safe control target');
      if (command.type === 'resume') await options.controller.resume(target!);
      if (command.type === 'terminate') await options.controller.terminateRecursive(target!);
      if (command.type === 'ignore') {
        ignoredUntil.set(command.incidentId, Date.now() + command.durationMinutes * 60_000);
      }
      return { ok: true, type: command.type };
    },
    async getIncidents(input: unknown = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Incident query must be an object');
      const fields = Object.keys(input as object);
      if (fields.some((field) => field !== 'limit')) throw new TypeError('Incident query contains unknown field');
      const limit = (input as { limit?: unknown }).limit ?? 100;
      if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 1000) throw new TypeError('Incident limit is invalid');
      return incidents.slice(-(limit as number));
    },
    registerIncident(id: string, target?: VerifiedControlTarget | null, summary?: IncidentSummary) {
      if (target) incidentTargets.set(id, { ...target });
      if (summary) {
        const existing = incidents.findIndex((incident) => incident.id === summary.id);
        if (existing >= 0) incidents[existing] = summary;
        else incidents.push(summary);
      }
    },
    isIgnored(id: string, now = Date.now()) {
      const until = ignoredUntil.get(id);
      if (until === undefined) return false;
      if (until <= now) {
        ignoredUntil.delete(id);
        return false;
      }
      return true;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of timers) options.clearScheduledInterval(timer);
      timers.length = 0;
      for (const target of options.controller.pausedTargets()) {
        try { await options.controller.resume(target); } catch { /* watchdog remains the fail-safe */ }
      }
      options.collector.stop();
      await options.onDispose?.();
    },
  };
}

export async function createDefaultAgentGuardService(env: NodeJS.ProcessEnv) {
  const policyPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '../../../../resources/policy-v1.json',
  );
  const basePolicy = normalizePolicy(JSON.parse(fs.readFileSync(policyPath, 'utf8')));
  const processMap = new Map<number, ProcessSnapshot>();
  const claude = createClaudeAdapter({
    settingsPath: path.join(os.homedir(), '.claude', 'settings.json'),
    sessionsDirectory: path.join(os.homedir(), '.claude', 'projects'),
  });
  const codex = createCodexAdapter({
    configPath: path.join(os.homedir(), '.codex', 'config.toml'),
    sessionsDirectory: path.join(os.homedir(), '.codex', 'sessions'),
  });
  const adapters = [claude, codex] as const;
  const fallbackAdapters = [createClaudeAdapter(), createCodexAdapter()] as const;
  let configurations = await Promise.all(adapters.map(async (adapter, index) => {
    try { return await adapter.discoverConfiguration(); }
    catch { return fallbackAdapters[index].discoverConfiguration(); }
  }));
  const store = await createAgentGuardStore({
    dataDir: env.HARBORS_AGENT_GUARD_DATA_DIR,
    hostMode: env.HARBORS_HOST_MODE === 'desktop' ? 'desktop' : 'web',
  });
  const persistedState = await store.loadState();
  const salt = persistedState ? Buffer.from(persistedState.saltHex, 'hex') : randomBytes(32);
  const createdAt = persistedState?.createdAt ?? Date.now();
  let policyOverrides = persistedState?.policyOverrides ?? {};
  const initialPolicy = applyPolicyOverrides(basePolicy, policyOverrides);
  if (!persistedState && store.status === 'ready') {
    await store.saveState({
      schemaVersion: 1,
      createdAt,
      saltHex: salt.toString('hex'),
      policyOverrides: {},
      baselines: [],
    });
  }
  const dns = new DnsHistory();
  const endpointTotals = new Map<string, AgentEndpointSnapshot>();
  const previousCounters = new BoundedMap<string, EpochCounter>(8_192);
  const endpointRuntime = new Map<string, {
    remoteDigest: string;
    bytesIn: number;
    bytesOut: number;
    connections: Set<string>;
    knownConnections: Set<string>;
    newConnections: Set<string>;
    processIds: Set<number>;
    history: Array<{ at: number; bytesOut: number; connections: number; sessions: number; tasks: number }>;
    baseline: RollingBaseline;
    complete: boolean;
  }>();
  const previousAgentPids = [new Set<number>(), new Set<number>()];
  const startedAt = createdAt;
  let lastEvaluationAt = startedAt;
  let policyEngine = new PolicyEngine(initialPolicy);
  let observerTimer: ReturnType<typeof setInterval> | undefined;
  let configurationTimer: ReturnType<typeof setInterval> | undefined;
  let dnsTimer: ReturnType<typeof setInterval> | undefined;
  let service: ReturnType<typeof createAgentGuardService>;

  const classify = (process: ProcessSnapshot): { role: AgentProcessRole; index: number } | undefined => {
    const claudeRole = claude.classifyProcess(process);
    if (claudeRole) return { role: claudeRole, index: 0 };
    const codexRole = codex.classifyProcess(process);
    return codexRole ? { role: codexRole, index: 1 } : undefined;
  };
  const snapshotParser = createNetstatSnapshotParser({ resolveProcess: (pid) => processMap.get(pid) });
  const collector = createNetstatCollector({
    parseSnapshot: snapshotParser,
    onCounter(value) {
      const process = processMap.get(value.counter.pid);
      const classified = process && classify(process);
      if (!classified) return;
      const attributed = attributeConnection({
        counter: value.counter,
        processRole: classified.role,
        configuration: configurations[classified.index],
        salt,
      }, dns, Date.now());
      const counterKey = `${value.counter.pid}\0${value.counter.processStartTime}\0${value.counter.localAddress}\0${value.counter.remoteAddress}`;
      const previous = previousCounters.get(counterKey);
      previousCounters.set(counterKey, value);
      if (!previous) return;
      const delta = computeCounterDelta(previous, value);
      const endpointKey = `${attributed.agent}\0${attributed.provider}\0${attributed.displayHostname}`;
      const current = endpointTotals.get(endpointKey) ?? {
        agent: attributed.agent,
        provider: attributed.provider,
        hostname: attributed.displayHostname,
        confidence: attributed.confidence,
        bytesIn: 0, bytesOut: 0, bytesInPerMinute: 0, bytesOutPerMinute: 0,
        connections: 0, activeTasks: 0,
      };
      const deltaIn = safeCounterNumber(delta.bytesIn);
      const deltaOut = safeCounterNumber(delta.bytesOut);
      endpointTotals.set(endpointKey, {
        ...current,
        confidence: attributed.confidence,
        bytesIn: Math.min(Number.MAX_SAFE_INTEGER, current.bytesIn + deltaIn),
        bytesOut: Math.min(Number.MAX_SAFE_INTEGER, current.bytesOut + deltaOut),
        activeTasks: classified.role === 'task' || classified.role === 'hook' ? 1 : 0,
      });
      const runtime = endpointRuntime.get(endpointKey) ?? {
        remoteDigest: attributed.remoteDigest,
        bytesIn: 0,
        bytesOut: 0,
        connections: new Set<string>(),
        knownConnections: new BoundedSet<string>(4_096),
        newConnections: new Set<string>(),
        processIds: new Set<number>(),
        history: [],
        baseline: restoreBaseline(endpointKey, persistedState?.baselines),
        complete: true,
      };
      runtime.bytesIn = Math.min(Number.MAX_SAFE_INTEGER, runtime.bytesIn + deltaIn);
      runtime.bytesOut = Math.min(Number.MAX_SAFE_INTEGER, runtime.bytesOut + deltaOut);
      runtime.connections.add(counterKey);
      if (!runtime.knownConnections.has(counterKey)) runtime.newConnections.add(counterKey);
      runtime.knownConnections.add(counterKey);
      runtime.processIds.add(value.counter.pid);
      runtime.complete &&= delta.complete;
      endpointRuntime.set(endpointKey, runtime);
      const projected = endpointTotals.get(endpointKey)!;
      projected.connections = runtime.connections.size;
    },
    onIncomplete() {
      previousCounters.clear();
      for (const runtime of endpointRuntime.values()) runtime.complete = false;
    },
  });
  const getLive = async (pid: number) => {
    const process = processMap.get(pid);
    const classified = process && classify(process);
    return process && classified ? { ...process, role: classified.role } : null;
  };
  const priorLedger = await store.loadControlLedger();
  if (priorLedger.length > 0) {
    const recovery = createWatchdogClient({});
    await recovery.update(priorLedger);
    await recovery.recover();
    if (store.status === 'ready') await store.saveControlLedger([]);
  }
  const watchdog = createWatchdogClient({});
  const controller = createProcessController({
    getProcess: getLive,
    listDescendants: async (pid) => collectDescendants(pid, processMap)
      .flatMap((process) => {
        const classified = classify(process);
        return classified ? [{ ...process, role: classified.role }] : [];
      }),
    listProcessGroup: async (processGroupId) => [...processMap.values()]
      .filter((candidate) => candidate.processGroupId === processGroupId)
      .flatMap((candidate) => {
        const classified = classify(candidate);
        return classified ? [{ ...candidate, role: classified.role }] : [];
      }),
    signal: (target, name) => { process.kill(target, name); },
    saveLedger: (entries) => store.saveControlLedger(entries),
    onLedgerChanged: (entries) => watchdog.update(entries),
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    isProtectedProcessGroup: (processGroupId) => (
      processMap.get(process.pid)?.processGroupId === processGroupId
      || [...processMap.values()].some((candidate) => {
        if (candidate.processGroupId !== processGroupId) return false;
        const classified = classify(candidate);
        return !classified || (classified.role !== 'task' && classified.role !== 'hook');
      })
    ),
  });
  const refreshProcesses = async () => {
    const processes = await observeProcesses();
    processMap.clear();
    for (const process of processes) processMap.set(process.pid, process);
  };
  const notificationPort = parseNotificationPort(env.HARBORS_NOTIFICATION_PORT);
  const notifier = notificationPort ? createIncidentNotifier({ port: notificationPort }) : undefined;
  const refreshConfigurations = async () => {
    const discovered = await Promise.allSettled(adapters.map((adapter) => adapter.discoverConfiguration()));
    configurations = configurations.map((current, index) => (
      discovered[index].status === 'fulfilled' ? discovered[index].value : current
    ));
  };
  const refreshDns = async () => {
    const now = Date.now();
    for (const configuration of configurations) {
      const hostname = new URL(configuration.endpoint).hostname;
      const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
      const addresses = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
      if (addresses.length > 0) dns.update(hostname, addresses, now, 5 * 60_000);
    }
  };
  const evaluate = async () => {
    const now = Date.now();
    const activityResults = await Promise.allSettled(
      adapters.map((adapter) => adapter.discoverSessionActivity(lastEvaluationAt)),
    );
    const activities = activityResults.map((result) => result.status === 'fulfilled' ? result.value : []);
    const persistedMetrics: PersistedMetricV1[] = [];
    const persistedIncidents: PersistedIncidentV1[] = [];
    for (const [key, runtime] of endpointRuntime) {
      const projected = endpointTotals.get(key)!;
      const adapterIndex = projected.agent === 'claude' ? 0 : 1;
      const agentProcesses = [...processMap.values()].filter((process) => adapters[adapterIndex].classifyProcess(process));
      const tree = buildProcessTree(agentProcesses, {
        maxNodes: 256,
        previousPids: previousAgentPids[adapterIndex],
        classify: (process) => adapters[adapterIndex].classifyProcess(process),
      });
      previousAgentPids[adapterIndex] = new Set(agentProcesses.map((process) => process.pid));
      const sessions = activities[adapterIndex].length;
      const bucket = {
        at: now,
        bytesOut: runtime.bytesOut,
        connections: runtime.newConnections.size,
        sessions,
        tasks: tree.metrics.newTaskProcesses,
      };
      runtime.history.push(bucket);
      projected.bytesInPerMinute = runtime.bytesIn;
      projected.bytesOutPerMinute = runtime.bytesOut;
      projected.activeTasks = tree.metrics.activeTaskProcesses;
      runtime.history = runtime.history.filter((item) => (
        now - item.at < policyEngine.policy.trafficWindowMinutes * 60_000
      ));
      const tenMinute = runtime.history.reduce((sum, item) => ({
        bytesOut: sum.bytesOut + item.bytesOut,
        sessions: sum.sessions + item.sessions,
        tasks: sum.tasks + item.tasks,
      }), { bytesOut: 0, sessions: 0, tasks: 0 });
      const result = policyEngine.evaluate({
        at: now,
        agent: projected.agent,
        endpoint: projected.hostname,
        learning: now - startedAt < policyEngine.policy.learningHours * 60 * 60_000,
        complete: runtime.complete,
        confidence: projected.confidence,
        bytesOutPerMinute: runtime.bytesOut,
        bytesOutTenMinutes: tenMinute.bytesOut,
        sessionsPerMinute: sessions,
        tasksPerMinute: tree.metrics.newTaskProcesses,
        connectionsPerMinute: runtime.newConnections.size,
        sessionsTenMinutes: tenMinute.sessions,
        tasksTenMinutes: tenMinute.tasks,
        recursiveTasksInWindow: tree.metrics.newTaskProcesses,
        baseline: runtime.baseline.snapshot(),
        processTree: tree.metrics,
      });
      runtime.baseline.add(runtime.bytesOut);
      persistedMetrics.push({
        schemaVersion: 1, at: now, agent: projected.agent, provider: projected.provider,
        hostname: projected.hostname, remoteDigest: runtime.remoteDigest,
        bytesIn: runtime.bytesIn, bytesOut: runtime.bytesOut,
        connections: runtime.connections.size, activeTasks: tree.metrics.activeTaskProcesses,
        confidence: projected.confidence, complete: runtime.complete,
      });
      if (result.ruleId && result.incidentId) {
        if (service.isIgnored(result.incidentId, now)) {
          runtime.bytesIn = 0;
          runtime.bytesOut = 0;
          runtime.connections.clear();
          runtime.newConnections.clear();
          runtime.processIds.clear();
          runtime.complete = true;
          continue;
        }
        const candidateProcess = tree.processes.find((process) => {
          const role = adapters[adapterIndex].classifyProcess(process);
          return role === 'task' || role === 'hook';
        });
        const target = candidateProcess
          ? adapters[adapterIndex].selectSafeControlTarget(tree, {
              agent: projected.agent,
              confidence: projected.confidence,
              processIds: [candidateProcess.pid],
              evidenceCodes: result.evidence.map((item) => item.code),
            })
          : null;
        const control = target ? result.control : null;
        const state = control ? result.state as 'tripped' : 'warning';
        const summary = `${projected.agent} ${projected.hostname}: ${result.ruleId}`;
        service.registerIncident(result.incidentId, target, {
          id: result.incidentId, openedAt: now, updatedAt: now,
          agent: projected.agent, provider: projected.provider, hostname: projected.hostname,
          state, ruleId: result.ruleId, confidence: projected.confidence, summary,
        });
        if (control?.action === 'pause') await controller.pause(target!, result.incidentId);
        if (control?.action === 'terminate-recursive-subtree') await controller.terminateRecursive(target!);
        await notifier?.notify({
          agent: projected.agent, endpoint: projected.hostname, ruleId: result.ruleId,
          level: control ? 'tripped' : 'warning', summary,
        }).catch(() => undefined);
        persistedIncidents.push({
          schemaVersion: 1, id: result.incidentId, at: now, ruleId: result.ruleId,
          state, agent: projected.agent, provider: projected.provider, hostname: projected.hostname,
          summary, evidenceCodes: result.evidence.map((item) => item.code),
          action: control?.action === 'pause' ? 'paused'
            : control?.action === 'terminate-recursive-subtree' ? 'terminated' : 'none',
        });
      }
      runtime.bytesIn = 0;
      runtime.bytesOut = 0;
      runtime.connections.clear();
      runtime.newConnections.clear();
      runtime.processIds.clear();
      runtime.complete = true;
    }
    if (store.status === 'ready') {
      await store.appendMetrics(persistedMetrics);
      await store.appendIncidents(persistedIncidents);
      await store.saveState({
        schemaVersion: 1, createdAt: startedAt, saltHex: salt.toString('hex'), policyOverrides,
        baselines: [...endpointRuntime].map(([key, runtime]) => ({ key, values: runtime.baseline.values() })),
      });
    }
    lastEvaluationAt = now;
  };
  service = createAgentGuardService({
    collector,
    controller,
    initialPolicy,
    scheduleInterval: setInterval,
    clearScheduledInterval: clearInterval,
    flushMetrics: async () => undefined,
    evaluate,
    endpoints: () => [...endpointTotals.values()],
    onStart: async () => {
      await refreshProcesses();
      await refreshConfigurations();
      await refreshDns();
      observerTimer = setInterval(() => { void refreshProcesses().catch(() => undefined); }, 5_000);
      configurationTimer = setInterval(() => { void refreshConfigurations(); }, 60_000);
      dnsTimer = setInterval(() => { void refreshDns(); }, 4 * 60_000);
    },
    onDispose: async () => {
      if (observerTimer) clearInterval(observerTimer);
      if (configurationTimer) clearInterval(configurationTimer);
      if (dnsTimer) clearInterval(dnsTimer);
      await watchdog.shutdown();
    },
    onPolicyChanged: async (policy) => {
      policyEngine = new PolicyEngine(policy);
      policyOverrides = {
        fixedWarningOutboundMiB: policy.fixedWarning.outboundMiB,
        fixedTripOutboundMiB: policy.fixedTrip.outboundMiB,
      };
      if (store.status === 'ready') {
        await store.saveState({
          schemaVersion: 1, createdAt: startedAt, saltHex: salt.toString('hex'), policyOverrides,
          baselines: [...endpointRuntime].map(([key, runtime]) => ({ key, values: runtime.baseline.values() })),
        });
      }
    },
    isLearning: () => Date.now() - startedAt < policyEngine.policy.learningHours * 60 * 60_000,
  });
  return service;
}

function safeCounterNumber(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function restoreBaseline(
  key: string,
  persisted: Array<{ key: string; values: number[] }> | undefined,
): RollingBaseline {
  const baseline = new RollingBaseline();
  for (const value of persisted?.find((item) => item.key === key)?.values ?? []) baseline.add(value);
  return baseline;
}

function applyPolicyOverrides(policy: PolicyV1, overrides: Record<string, unknown>): PolicyV1 {
  const warning = overrides.fixedWarningOutboundMiB;
  const trip = overrides.fixedTripOutboundMiB;
  return normalizePolicy({
    ...policy,
    fixedWarning: {
      ...policy.fixedWarning,
      outboundMiB: typeof warning === 'number' ? warning : policy.fixedWarning.outboundMiB,
    },
    fixedTrip: {
      ...policy.fixedTrip,
      outboundMiB: typeof trip === 'number' ? trip : policy.fixedTrip.outboundMiB,
    },
  });
}

function parseNotificationPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function collectDescendants(pid: number, processes: Map<number, ProcessSnapshot>): ProcessSnapshot[] {
  const found: ProcessSnapshot[] = [];
  const pending = [pid];
  while (pending.length > 0 && found.length < 256) {
    const parent = pending.shift()!;
    for (const process of processes.values()) {
      if (process.ppid !== parent) continue;
      found.push(process);
      pending.push(process.pid);
    }
  }
  return found;
}
