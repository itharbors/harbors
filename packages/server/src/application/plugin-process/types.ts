export type ApplicationPluginProcessStatus =
  | 'pending'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'failed'
  | 'stopping'
  | 'stopped';

export interface ApplicationPluginProcessError {
  readonly code: string;
  readonly message: string;
}

export interface ApplicationPluginProcessState {
  readonly status: ApplicationPluginProcessStatus;
  readonly generation: string | null;
  readonly pid: number | null;
  readonly restartCount: number;
  readonly lastFailureAt: number | null;
  readonly error: ApplicationPluginProcessError | null;
  readonly retryAfterMs: number | null;
}
