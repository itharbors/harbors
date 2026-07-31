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
