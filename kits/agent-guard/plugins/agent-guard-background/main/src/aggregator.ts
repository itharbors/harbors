import type { AttributionConfidence } from '@itharbors/agent-guard-contracts';
import { computeCounterDelta } from './netstat-collector.js';
import type { AttributedConnection } from './attribution.js';

export interface AttributedCounterSample {
  epoch: number;
  connection: AttributedConnection;
}

export interface MetricWindow {
  startedAt: number;
  endedAt: number;
  complete: boolean;
  controlEligible: boolean;
  bytesIn: bigint;
  bytesOut: bigint;
  connections: number;
  newConnections: number;
  confidence: AttributionConfidence;
}

function connectionKey(connection: AttributedConnection): string {
  const value = connection.counter;
  return [
    value.pid, value.processStartTime, value.executableIdentity,
    value.localAddress, value.remoteAddress, value.transport,
  ].join('\0');
}

export function aggregateMetricWindow(samples: readonly AttributedCounterSample[]): MetricWindow {
  if (samples.length === 0) {
    return {
      startedAt: 0, endedAt: 0, complete: false, controlEligible: false,
      bytesIn: 0n, bytesOut: 0n, connections: 0, newConnections: 0, confidence: 'unknown',
    };
  }
  const ordered = [...samples].sort(
    (left, right) => left.connection.counter.observedAt - right.connection.counter.observedAt,
  );
  const grouped = new Map<string, AttributedCounterSample[]>();
  for (const sample of ordered) {
    const key = connectionKey(sample.connection);
    const values = grouped.get(key) ?? [];
    values.push(sample);
    grouped.set(key, values);
  }
  let bytesIn = 0n;
  let bytesOut = 0n;
  let complete = true;
  for (const values of grouped.values()) {
    if (values.length < 2) {
      complete = false;
      continue;
    }
    const first = values[0];
    const last = values[values.length - 1];
    const delta = computeCounterDelta(
      { epoch: first.epoch, counter: first.connection.counter },
      { epoch: last.epoch, counter: last.connection.counter },
    );
    complete &&= delta.complete;
    bytesIn += delta.bytesIn;
    bytesOut += delta.bytesOut;
  }
  const confidences = ordered.map(({ connection }) => connection.confidence);
  const confidence: AttributionConfidence = confidences.every((value) => value === 'confirmed')
    ? 'confirmed'
    : confidences.some((value) => value !== 'unknown') ? 'probable' : 'unknown';
  return {
    startedAt: ordered[0].connection.counter.observedAt,
    endedAt: ordered[ordered.length - 1].connection.counter.observedAt,
    complete,
    controlEligible: complete && confidence === 'confirmed',
    bytesIn,
    bytesOut,
    connections: grouped.size,
    newConnections: [...grouped.values()].filter((values) => values.length === 1).length,
    confidence,
  };
}
