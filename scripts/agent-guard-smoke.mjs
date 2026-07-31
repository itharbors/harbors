#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

const FIXTURE_SOURCE = `
import net from 'node:net';
let socket;
let timer;
let ticks = 0;
setInterval(() => process.send?.({ type: 'tick', value: ++ticks }), 50);
process.on('message', (message) => {
  if (message.type === 'connect') socket = net.connect(message.port, message.host);
  if (message.type === 'stress') {
    clearInterval(timer);
    if (message.enabled) timer = setInterval(() => socket?.write(Buffer.alloc(32 * 1024)), 10);
  }
});
process.send?.({ type: 'ready' });
`;

const SINK_SOURCE = `
import net from 'node:net';
let receivedBytes = 0;
const server = net.createServer((socket) => {
  socket.on('data', (chunk) => { receivedBytes += chunk.length; });
});
server.listen(0, '127.0.0.1', () => {
  process.send?.({ type: 'ready', port: server.address().port });
});
setInterval(() => process.send?.({ type: 'received', value: receivedBytes }), 250);
`;

const execute = promisify(execFile);
const options = parseArguments(process.argv.slice(2));
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Agent Guard smoke testing requires macOS arm64');
}

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const backgroundDist = path.join(
  repositoryRoot, 'kits/agent-guard/plugins/agent-guard-background/main/dist',
);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'harbors-agent-guard-smoke-'));
const fixtureExecutable = path.join(temporaryRoot, 'codex');
const fixtureSource = path.join(temporaryRoot, 'fixture.mjs');
const sinkSource = path.join(temporaryRoot, 'sink.mjs');
const reportPath = path.resolve(repositoryRoot, options.report);
let child;
let sink;
let collector;
let controller;
let watchdog;
let receivedBytes = 0;
let fixtureTicks = 0;

try {
  await copyFile(process.execPath, fixtureExecutable);
  await writeFile(fixtureSource, FIXTURE_SOURCE, { mode: 0o600 });
  await writeFile(sinkSource, SINK_SOURCE, { mode: 0o600 });
  sink = spawn(process.execPath, [sinkSource], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { PATH: '/usr/bin:/bin', HARBORS_AGENT_GUARD_FIXTURE: 'sink' },
  });
  sink.on('message', (message) => {
    if (message?.type === 'received') receivedBytes = message.value;
  });
  const sinkReady = await waitForMessage(sink, 'ready', 5_000);
  if (!Number.isSafeInteger(sinkReady.port)) throw new Error('Fixture endpoint did not bind');

  const hostBaselineRssBytes = process.memoryUsage().rss;
  const [processModule, collectorModule, controllerModule, watchdogModule] = await Promise.all([
    import(path.join(backgroundDist, 'process-observer.js')),
    import(path.join(backgroundDist, 'netstat-collector.js')),
    import(path.join(backgroundDist, 'process-controller.js')),
    import(path.join(backgroundDist, 'watchdog.js')),
  ]);
  child = spawn(fixtureExecutable, [fixtureSource], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { PATH: '/usr/bin:/bin', HARBORS_AGENT_GUARD_FIXTURE: '1' },
  });
  child.on('message', (message) => {
    if (message?.type === 'tick') fixtureTicks = message.value;
  });
  await waitForMessage(child, 'ready', 5_000);
  child.send({ type: 'connect', host: '127.0.0.1', port: sinkReady.port });

  const observed = await waitForFixture(processModule.observeProcesses, child.pid, process.pid);
  const ownProcessGroupId = Number((await execute('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)])).stdout.trim());
  if (!child.pid || observed.ppid !== process.pid) {
    throw new Error('Refusing to control a process not created by this smoke test');
  }
  if (!Number.isSafeInteger(ownProcessGroupId) || observed.processGroupId === ownProcessGroupId) {
    throw new Error(`Fixture must use an isolated process group (${observed.processGroupId}/${ownProcessGroupId})`);
  }
  const fixture = {
    ...observed,
    commandMarkers: ['task'],
    parentRoleHint: 'host',
    role: 'task',
  };
  const processMap = new Map([[fixture.pid, fixture]]);
  const parser = collectorModule.createNetstatSnapshotParser({
    resolveProcess: (pid) => processMap.get(pid),
  });
  let observedBytes = 0n;
  let observedInboundBytes = 0n;
  let observedCounterCount = 0;
  const previous = new Map();
  collector = collectorModule.createNetstatCollector({
    parseSnapshot: parser,
    onCounter(value) {
      observedCounterCount += 1;
      const key = `${value.counter.pid}\0${value.counter.localAddress}\0${value.counter.remoteAddress}`;
      const prior = previous.get(key);
      previous.set(key, value);
      if (prior) {
        const delta = collectorModule.computeCounterDelta(prior, value);
        observedBytes += delta.bytesOut;
        observedInboundBytes += delta.bytesIn;
      }
    },
  });
  watchdog = watchdogModule.createWatchdogClient({});
  const ledger = [];
  controller = controllerModule.createProcessController({
    getProcess: async (pid) => pid === fixture.pid ? fixture : null,
    listDescendants: async () => [],
    listProcessGroup: async () => [fixture],
    signal: (pid, signal) => process.kill(pid, signal),
    saveLedger: async (entries) => { ledger.splice(0, ledger.length, ...entries); },
    onLedgerChanged: (entries) => watchdog.update(entries),
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    isProtectedProcessGroup: (processGroupId) => processGroupId === ownProcessGroupId,
  });

  const target = {
    pid: fixture.pid,
    processStartTime: fixture.processStartTime,
    executableIdentity: fixture.executableIdentity,
    processGroupId: fixture.processGroupId,
    role: 'task',
  };
  await controller.pause(target, 'smoke-pause');
  await delay(75);
  const pausedTicks = fixtureTicks;
  await delay(200);
  const pausedTicksAfterWindow = fixtureTicks;
  await controller.resume(target);
  await delay(250);
  if (pausedTicksAfterWindow !== pausedTicks || fixtureTicks <= pausedTicks || ledger.length !== 0) {
    throw new Error('Fixture pause/resume verification failed');
  }

  await controller.pause(target, 'smoke-crash-recovery');
  await delay(75);
  const beforeWatchdogRecovery = fixtureTicks;
  await watchdog.recover();
  await delay(500);
  if (fixtureTicks <= beforeWatchdogRecovery) {
    throw new Error('Detached watchdog did not recover the paused fixture');
  }
  watchdog = watchdogModule.createWatchdogClient({});
  await controller.resume(target);
  await watchdog.shutdown();
  watchdog = undefined;

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const baselineSamples = [];
  const idleSamples = [];
  const stressSamples = [];
  const startedAt = Date.now();
  const idleAt = startedAt + Math.floor(options.durationSeconds * 1_000 / 3);
  const stressAt = startedAt + Math.floor(options.durationSeconds * 2_000 / 3);
  let phase = 'baseline';
  let previousCpu = process.cpuUsage();
  let previousCpuAt = performance.now();
  while (Date.now() - startedAt < options.durationSeconds * 1_000) {
    if (phase === 'baseline' && Date.now() >= idleAt) {
      phase = 'idle';
      collector.start();
      watchdog = watchdogModule.createWatchdogClient({});
    }
    if (phase === 'idle' && Date.now() >= stressAt) {
      phase = 'stress';
      child.send({ type: 'stress', enabled: true });
    }
    const external = await sampleProcesses([watchdog?.pid].filter(Boolean));
    const currentCpu = process.cpuUsage();
    const currentCpuAt = performance.now();
    const ownCpuPercent = (
      (currentCpu.user - previousCpu.user) + (currentCpu.system - previousCpu.system)
    ) / 1_000 / Math.max(1, currentCpuAt - previousCpuAt) * 100;
    previousCpu = currentCpu;
    previousCpuAt = currentCpuAt;
    const sample = {
      cpuPercent: ownCpuPercent + external.cpuPercent,
      rssBytes: process.memoryUsage().rss + external.rssBytes,
    };
    if (phase === 'baseline') baselineSamples.push(sample);
    else if (phase === 'idle') idleSamples.push(sample);
    else stressSamples.push(sample);
    await delay(1_000);
  }
  histogram.disable();
  child.send({ type: 'stress', enabled: false });
  const metricRecordBytes = Buffer.byteLength(`${JSON.stringify({
    schemaVersion: 1, at: Date.now(), agent: 'codex', provider: 'fixture',
    hostname: 'localhost', remoteDigest: '0123456789abcdef', bytesIn: receivedBytes,
    bytesOut: Number(observedBytes), connections: 1, activeTasks: 1,
    confidence: 'confirmed', complete: true,
  })}\n`);
  const storageProjectionBytes = metricRecordBytes * 24 * 60;
  const netstatCpuPercent = await measureNetstatCpuPercent();
  const report = createReport({
    durationSeconds: options.durationSeconds,
    baseline: summarize(baselineSamples),
    idle: summarize(idleSamples),
    stress: summarize(stressSamples),
    hostBaselineRssBytes,
    eventLoopP99Ms: histogram.percentile(99) / 1e6,
    storageProjectionBytes,
    receivedBytes,
    observedBytes: Number(observedBytes),
    observedInboundBytes: Number(observedInboundBytes),
    observedCounterCount,
    collectorEpoch: collector.snapshot().epoch,
    collectorMaxPollDurationMs: collector.snapshot().maxPollDurationMs,
    netstatCpuPercent,
  });
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, report, { mode: 0o600 });
  process.stdout.write(`REPORT=${reportPath}\n`);
} finally {
  collector?.stop();
  for (const target of controller?.pausedTargets?.() ?? []) {
    try { await controller.resume(target); } catch { /* fixture cleanup follows */ }
  }
  try { await watchdog?.shutdown(); } catch { /* fixture cleanup follows */ }
  if (child?.pid) {
    try { process.kill(child.pid, 'SIGCONT'); } catch {}
    try { process.kill(child.pid, 'SIGTERM'); } catch {}
  }
  if (sink?.pid) {
    try { process.kill(sink.pid, 'SIGTERM'); } catch {}
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

function parseArguments(args) {
  let durationSeconds = 30;
  let report = 'docs/superpowers/reports/2026-07-30-agent-traffic-guard-performance.md';
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === '--duration-seconds') durationSeconds = Number(value);
    else if (flag === '--report') report = value;
    else throw new Error(`Unknown smoke option: ${flag}`);
  }
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 3_600) {
    throw new Error('Smoke duration must be an integer from 10 to 3600 seconds');
  }
  if (typeof report !== 'string' || !report.endsWith('.md') || path.isAbsolute(report) || report.includes('..')) {
    throw new Error('Smoke report must be a repository-relative Markdown path');
  }
  return { durationSeconds, report };
}

async function waitForMessage(childProcess, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Fixture did not send ${type}`)), timeoutMs);
    const listener = (message) => {
      if (message?.type !== type) return;
      clearTimeout(timeout);
      childProcess.off('message', listener);
      resolve(message);
    };
    childProcess.on('message', listener);
  });
}

async function waitForFixture(observe, pid, expectedParentPid) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = (await observe()).find((process) => process.pid === pid);
    if (value?.ppid === expectedParentPid) return value;
    await delay(100);
  }
  throw new Error('Fixture process identity was not observable');
}

async function sampleProcesses(pids) {
  if (pids.length === 0) return { cpuPercent: 0, rssBytes: 0 };
  const { stdout } = await execute('/bin/ps', ['-o', 'pid=,%cpu=,rss=', '-p', pids.join(',')]);
  return stdout.trim().split(/\r?\n/u).filter(Boolean).reduce((sum, line) => {
    const [, cpu, rss] = line.trim().split(/\s+/u).map(Number);
    return { cpuPercent: sum.cpuPercent + cpu, rssBytes: sum.rssBytes + rss * 1024 };
  }, { cpuPercent: 0, rssBytes: 0 });
}

async function measureNetstatCpuPercent() {
  const iterations = 100;
  const script = `i=0
while [ "$i" -lt ${iterations} ]; do
  /usr/sbin/netstat -anv -p tcp >/dev/null
  i=$((i + 1))
done`;
  const { stderr } = await execute('/usr/bin/time', ['-lp', '/bin/sh', '-c', script], {
    env: { PATH: '/usr/sbin:/usr/bin:/bin' }, maxBuffer: 1024 * 1024,
  });
  const user = Number(stderr.match(/^user\s+([0-9.]+)$/mu)?.[1]);
  const system = Number(stderr.match(/^sys\s+([0-9.]+)$/mu)?.[1]);
  if (!Number.isFinite(user) || !Number.isFinite(system)) {
    throw new Error('Unable to parse netstat CPU calibration');
  }
  return ((user + system) / iterations) / 5 * 100;
}

function summarize(samples) {
  if (samples.length === 0) return { cpuPercent: 0, peakRssBytes: 0 };
  return {
    cpuPercent: samples.reduce((sum, sample) => sum + sample.cpuPercent, 0) / samples.length,
    peakRssBytes: Math.max(...samples.map((sample) => sample.rssBytes)),
  };
}

function createReport(values) {
  const mib = (bytes) => bytes / (1024 * 1024);
  const idleIncrementalCpu = Math.max(0, values.idle.cpuPercent - values.baseline.cpuPercent)
    + values.netstatCpuPercent;
  const stressIncrementalCpu = Math.max(0, values.stress.cpuPercent - values.baseline.cpuPercent)
    + values.netstatCpuPercent;
  const incrementalPeakRssBytes = Math.max(0, values.stress.peakRssBytes - values.hostBaselineRssBytes);
  const checks = [
    ['Idle incremental CPU ≤ 0.5%', idleIncrementalCpu <= 0.5, `${idleIncrementalCpu.toFixed(2)}%`],
    ['Stress incremental CPU ≤ 2%', stressIncrementalCpu <= 2, `${stressIncrementalCpu.toFixed(2)}%`],
    ['Incremental background + watchdog RSS ≤ 50 MiB', incrementalPeakRssBytes <= 50 * 1024 * 1024, `${mib(incrementalPeakRssBytes).toFixed(1)} MiB`],
    ['Projected metrics ≤ 20 MiB/day', values.storageProjectionBytes <= 20 * 1024 * 1024, `${mib(values.storageProjectionBytes).toFixed(2)} MiB/day`],
    ['Fixture traffic observed by netstat snapshots', values.observedBytes + values.observedInboundBytes > 0, `${values.observedBytes + values.observedInboundBytes} bytes`],
  ];
  return `# Agent Guard performance report

- Recorded: ${new Date().toISOString()}
- Hardware: ${os.cpus()[0]?.model ?? 'unknown'} (${os.cpus().length} logical CPUs), ${Math.round(os.totalmem() / 1024 ** 3)} GiB RAM
- OS/runtime: ${os.type()} ${os.release()} ${process.arch}, Node ${process.version}
- Duration: ${values.durationSeconds} seconds; equal thirds harness baseline, guard idle, and fixture traffic
- Scope: smoke harness + 5-second netstat snapshots + detached recovery watchdog; fixture Agent and traffic-sink CPU/RSS excluded

| Budget | Result | Measurement |
| --- | --- | --- |
${checks.map(([name, passed, measurement]) => `| ${name} | ${passed ? 'PASS' : 'FAIL'} | ${measurement} |`).join('\n')}

Additional evidence: harness baseline CPU ${values.baseline.cpuPercent.toFixed(2)}%; guard idle CPU ${values.idle.cpuPercent.toFixed(2)}%; guard stress CPU ${values.stress.cpuPercent.toFixed(2)}%; calibrated netstat CPU ${values.netstatCpuPercent.toFixed(2)}%; event-loop p99 ${values.eventLoopP99Ms.toFixed(2)} ms; slowest netstat poll ${values.collectorMaxPollDurationMs.toFixed(2)} ms; local fixture received ${values.receivedBytes} bytes; netstat emitted ${values.observedCounterCount} counters in ${values.collectorEpoch} collector epoch(s), attributing ${values.observedBytes} outbound and ${values.observedInboundBytes} inbound bytes. The 100,000-observation unit benchmark is a boundedness check, not a substitute for this real macOS measurement.
`;
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
