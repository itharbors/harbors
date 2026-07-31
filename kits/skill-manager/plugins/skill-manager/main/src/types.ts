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

export type RecoveryAction = 'disabled' | 'trash';

export type RecoveryRecord = {
  schemaVersion: 1;
  id: string;
  action: RecoveryAction;
  skillName: string;
  originalBasename: string;
  digest: string;
  createdAt: string;
};

export type RecoveryEntry = RecoveryRecord & {
  directory: string;
  manifest: SkillManifest | null;
  valid: boolean;
  diagnostics: SkillDiagnostic[];
};

export type MoveInput = {
  globalRoot: string;
  candidate: SkillCandidate;
  action: RecoveryAction;
  expectedDigest: string;
};

export type RestoreInput = {
  globalRoot: string;
  id: string;
  expectedDigest: string;
};

export type MutationAction = 'install' | 'update' | 'disable' | 'uninstall' | 'restore';

export type MutationInput = {
  revision: number;
  expectedDigest: string;
  source?: SkillCandidate;
  global?: SkillCandidate;
  recoveryId?: string;
};

export type MutationReceipt = {
  action: MutationAction;
  status: 'completed' | 'recovery-required';
  revision: number;
  basename: string;
  digest: string;
  recoveryId?: string;
};

export type SkillSnapshot = {
  revision: number;
  generation: number;
  mode: 'global' | 'source';
  globalRootLabel: string;
  sourceRootLabel: string | null;
  scanning: boolean;
  truncated: boolean;
  counts: Record<SkillStatus, number>;
  items: SkillListItem[];
  diagnostics: SkillDiagnostic[];
};

export type SkillDetail = {
  id: string;
  revision: number;
  name: string;
  description: string;
  status: SkillStatus;
  diagnostics: SkillDiagnostic[];
  source: SkillDetailLocation | null;
  global: SkillDetailLocation | null;
  recovery: SkillDetailLocation | null;
};

export type SkillDetailLocation = {
  origin: SkillOrigin;
  basename: string;
  manifest: SkillManifest;
  digest: string;
  text: string;
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
