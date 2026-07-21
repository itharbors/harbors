import type { NormalizedMenuResult } from '../framework/menu/types';

export interface ApplicationPluginSpec {
  name: string;
  path: string;
  kits: string[];
}

export type ApplicationDiagnosticCode =
  | 'INVALID_KIT_MANIFEST'
  | 'INVALID_STARTUP_PLUGINS'
  | 'STARTUP_PLUGIN_OVERLAP'
  | 'PLUGIN_RESOLUTION_FAILED'
  | 'PLUGIN_PATH_CONFLICT';

export interface ApplicationDiagnostic {
  code: ApplicationDiagnosticCode;
  message: string;
  kit?: string;
  plugin?: string;
}

export type ApplicationPhase = 'starting' | 'ready' | 'degraded' | 'stopping' | 'stopped';
export type ApplicationPluginStatus = 'pending' | 'running' | 'failed' | 'stopped';

export interface ApplicationPluginState {
  name: string;
  path: string;
  kits: string[];
  status: ApplicationPluginStatus;
  error?: string;
}

export interface ApplicationBootstrap {
  phase: ApplicationPhase;
  plugins: ApplicationPluginState[];
  diagnostics: ApplicationDiagnostic[];
  menu: NormalizedMenuResult;
}

export interface ApplicationEvent {
  type: 'application-bootstrap';
  bootstrap: ApplicationBootstrap;
}
