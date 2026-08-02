import type {
  AgentId,
  HistorySeries,
  TrafficHistoryResult,
} from '@itharbors/agent-guard-contracts';

export type HistoryRange = '1h' | '24h' | '7d' | '30d' | '90d' | '1y';

export interface AgentMetricSummary {
  metric: HistorySeries['metric'];
  unit: HistorySeries['unit'];
  value: number | null;
  coverageRatio: number;
}

export interface AgentHistorySummary {
  agent: AgentId;
  metrics: AgentMetricSummary[];
}

export interface HistoryAxisTick {
  at: number;
  label: string;
}

const AGENTS: readonly AgentId[] = ['claude', 'codex'];

const METRICS_BY_DOMAIN = {
  network: ['bytes-in', 'bytes-out'],
  'model-usage': ['input-tokens', 'output-tokens', 'cache-tokens', 'requests', 'sessions'],
} as const satisfies Record<TrafficHistoryResult['domain'], readonly HistorySeries['metric'][]>;

export function summarizeHistoryByAgent(result: TrafficHistoryResult): AgentHistorySummary[] {
  return AGENTS.map((agent) => ({
    agent,
    metrics: METRICS_BY_DOMAIN[result.domain].map((metric) => {
      const series = result.series.filter((item) => item.agent === agent && item.metric === metric);
      const points = series.flatMap((item) => item.points);
      const covered = points.filter((point) => point.value !== null);
      return {
        metric,
        unit: series[0]?.unit ?? historyMetricUnit(metric),
        value: covered.length === 0 ? null : covered.reduce((sum, point) => sum + point.value!, 0),
        coverageRatio: points.length === 0 ? 0 : covered.length / points.length,
      };
    }),
  }));
}

export function createHistoryAxisTicks(from: number, to: number, range: HistoryRange): HistoryAxisTick[] {
  return Array.from({ length: 5 }, (_, index) => {
    const at = from + (to - from) * index / 4;
    return { at, label: formatAxisLabel(at, range, index === 0) };
  });
}

function formatAxisLabel(at: number, range: HistoryRange, isFirstTick: boolean): string {
  const values = localDateParts(at);
  if (range === '1h') return `${values.hour}:${values.minute}`;
  if (range === '24h') return isFirstTick
    ? `${values.month}-${values.day} ${values.hour}:${values.minute}`
    : `${values.hour}:${values.minute}`;
  if (range === '7d' || range === '30d') return `${values.month}-${values.day}`;
  return `${values.year}-${values.month}`;
}

function localDateParts(at: number): Record<'year' | 'month' | 'day' | 'hour' | 'minute', string> {
  const formatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return formatter.formatToParts(new Date(at)).reduce((parts, part) => (
    part.type in parts ? { ...parts, [part.type]: part.value } : parts
  ), { year: '', month: '', day: '', hour: '', minute: '' });
}

function historyMetricUnit(metric: HistorySeries['metric']): HistorySeries['unit'] {
  if (metric === 'bytes-in' || metric === 'bytes-out') return 'bytes';
  if (metric === 'input-tokens' || metric === 'output-tokens' || metric === 'cache-tokens') return 'tokens';
  return metric;
}
