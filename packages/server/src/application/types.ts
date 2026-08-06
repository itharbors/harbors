import type { NormalizedMenuResult } from '../framework/menu/types';
import type { KitPermission } from '@itharbors/kit-core';
import type { CredentialCapabilitySnapshot } from '@itharbors/plugin-types';

export interface ApplicationPluginSpec {
  name: string;
  path: string;
  kits: string[];
  permissions?: KitPermission[];
  legacyDataDirectories?: string[];
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
export type ApplicationPluginStatus =
  | 'pending'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'failed'
  | 'stopping'
  | 'stopped';

export interface ApplicationPluginState {
  name: string;
  path: string;
  kits: string[];
  status: ApplicationPluginStatus;
  generation?: string;
  pid?: number;
  restartCount?: number;
  lastFailureAt?: number;
  errorCode?: string;
  retryAfterMs?: number;
}

export interface ApplicationBootstrap {
  phase: ApplicationPhase;
  plugins: ApplicationPluginState[];
  diagnostics: ApplicationDiagnostic[];
  menu: NormalizedMenuResult;
  credentials?: CredentialCapabilitySnapshot;
}

export interface ApplicationEvent {
  type: 'application-bootstrap';
  bootstrap: ApplicationBootstrap;
}
