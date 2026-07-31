export interface IncidentNotice {
  agent: 'claude' | 'codex';
  endpoint: string;
  ruleId: string;
  level: 'warning' | 'tripped';
  summary: string;
}

export function createIncidentNotifier(options: {
  port: number;
  fetch?: typeof fetch;
  now?: () => number;
  dedupeMs?: number;
}) {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new TypeError('Notification port must be between 1 and 65535');
  }
  const request = options.fetch ?? fetch;
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
        const response = await request(`http://127.0.0.1:${options.port}/v1/notifications`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: notice.level === 'tripped' ? 'Agent Guard stopped abnormal activity' : 'Agent Guard traffic warning',
            body: notice.summary,
            level: notice.level === 'tripped' ? 'error' : 'warning',
            source: 'Agent Guard',
            persistent: notice.level === 'tripped',
          }),
        });
        if (!response.ok) return false;
        sent.set(key, current);
        return true;
      } catch {
        return false;
      }
    },
  };
}
