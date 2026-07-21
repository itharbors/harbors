type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogEntry = {
  id: number;
  level: LogLevel;
  message: string;
  meta?: unknown;
  timestamp: string;
};

type LogInput = {
  level?: unknown;
  message?: unknown;
  meta?: unknown;
};

declare const editor: any;

let runtime: any;
let nextId = 1;
const MAX_LOGS = 500;
const LOGS_CHANGED_TOPIC = 'log.changed';
const logs: LogEntry[] = [
  createLog('info', 'Log plugin loaded', undefined),
  createLog('debug', 'Waiting for runtime events...', undefined),
];

editor.plugin.define({
  lifecycle: {
    load(ctx: any) {
      runtime = ctx;
    },
  },
  methods: {
    openLogPanel() {
      return runtime.window.openPanel('@itharbors/log.log');
    },
    getLogs() {
      return [...logs];
    },
    appendLog(entry: LogInput | null = {}) {
      const input = normalizeLogInput(entry);
      const level = normalizeLevel(input.level);
      const message = typeof input.message === 'string' && input.message.trim()
        ? input.message
        : 'New log entry';
      const log = createLog(level, message, input.meta);
      logs.push(log);
      if (logs.length > MAX_LOGS) {
        logs.splice(0, logs.length - MAX_LOGS);
      }
      runtime.message.broadcast(LOGS_CHANGED_TOPIC, [...logs]);
      return log;
    },
    clearLogs() {
      logs.length = 0;
      runtime.message.broadcast(LOGS_CHANGED_TOPIC, []);
      return [];
    },
  },
});

function createLog(level: LogLevel, message: string, meta: unknown): LogEntry {
  return {
    id: nextId++,
    level,
    message,
    meta,
    timestamp: new Date().toISOString(),
  };
}

function normalizeLevel(level: unknown): LogLevel {
  return ['debug', 'info', 'warn', 'error'].includes(String(level)) ? level as LogLevel : 'info';
}

function normalizeLogInput(entry: LogInput | null | undefined): LogInput {
  return entry && typeof entry === 'object' ? entry : {};
}
