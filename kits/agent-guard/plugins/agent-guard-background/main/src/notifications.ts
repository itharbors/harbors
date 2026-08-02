export interface IncidentNotice {
  agent: 'claude' | 'codex';
  endpoint: string;
  ruleId: string;
  level: 'warning' | 'tripped';
  summary: string;
}

export function createIncidentNotifier(options: {
  create(input: Record<string, unknown>): Promise<unknown>;
  now?: () => number;
  dedupeMs?: number;
}) {
  const now = options.now ?? Date.now;
  const dedupeMs = options.dedupeMs ?? 10 * 60_000;
  const sent = new Map<string, number>();
  return {
    async notify(notice: IncidentNotice): Promise<boolean> {
      const key = `${notice.agent}\0${notice.endpoint}\0${notice.ruleId}`;
      const previous = sent.get(key);
      const current = now();
      if (previous !== undefined && current - previous < dedupeMs) return false;
      try {
        await options.create({
            title: notice.level === 'tripped' ? 'Agent Guard stopped abnormal activity' : 'Agent Guard traffic warning',
            body: notice.summary,
            level: notice.level === 'tripped' ? 'error' : 'warning',
            source: 'Agent Guard',
            persistent: notice.level === 'tripped',
          });
        sent.set(key, current);
        return true;
      } catch {
        return false;
      }
    },
  };
}
