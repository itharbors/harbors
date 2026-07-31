export type SkillManifest = {
  name: string;
  description: string;
};

export type SkillOrigin = 'source' | 'global' | 'system' | 'disabled' | 'trash';

export type SkillDiagnostic = {
  code: string;
  message: string;
  relativePath?: string;
};

export type SkillCandidate = {
  id: string;
  origin: SkillOrigin;
  directory: string;
  basename: string;
  manifest: SkillManifest | null;
  digest: string | null;
  protected: boolean;
  diagnostics: SkillDiagnostic[];
};

export type ScanLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

export type ScanOptions = {
  limits: ScanLimits;
  signal?: AbortSignal;
};

export type SkillDigest = {
  value: string;
  files: string[];
  totalBytes: number;
};

export type SkillScanResult = {
  candidates: SkillCandidate[];
  diagnostics: SkillDiagnostic[];
  truncated: boolean;
};

export type SkillStatus =
  | 'source-only'
  | 'current'
  | 'update-available'
  | 'global-only'
  | 'disabled'
  | 'trashed'
  | 'protected'
  | 'conflict'
  | 'invalid';

export type SkillAction = 'install' | 'update' | 'disable' | 'uninstall' | 'restore';

export type CompareInput = {
  source: SkillCandidate[];
  global: SkillCandidate[];
  recovery: SkillCandidate[];
};

export type SkillListItem = {
  id: string;
  name: string;
  description: string;
  basename: string;
  status: SkillStatus;
  actions: SkillAction[];
  sourceDigest: string | null;
  globalDigest: string | null;
  recoveryDigest: string | null;
  protected: boolean;
  diagnostics: SkillDiagnostic[];
};

export type SkillManagerErrorCode =
  | 'INVALID_SKILL'
  | 'UNSAFE_PATH'
  | 'SCAN_LIMIT'
  | 'SCAN_CANCELLED'
  | 'STALE_SNAPSHOT'
  | 'SKILL_CONFLICT';

export class SkillManagerError extends Error {
  readonly code: SkillManagerErrorCode;

  constructor(code: SkillManagerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SkillManagerError';
    this.code = code;
  }
}
