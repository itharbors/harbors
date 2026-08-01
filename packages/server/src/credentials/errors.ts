export type CredentialErrorCode =
  | 'CREDENTIALS_DISABLED'
  | 'CREDENTIALS_UNAVAILABLE'
  | 'CREDENTIALS_LOCKED'
  | 'CREDENTIAL_PROFILE_NOT_FOUND'
  | 'CREDENTIAL_PROFILE_CONFLICT'
  | 'CREDENTIAL_OPERATION_FAILED';

export const CREDENTIAL_ERROR_MESSAGES: Readonly<Record<CredentialErrorCode, string>> = {
  CREDENTIALS_DISABLED: '凭据存储已禁用',
  CREDENTIALS_UNAVAILABLE: '系统凭据库不可用',
  CREDENTIALS_LOCKED: '系统凭据库已锁定',
  CREDENTIAL_PROFILE_NOT_FOUND: '凭据配置不存在',
  CREDENTIAL_PROFILE_CONFLICT: '凭据配置已发生变化',
  CREDENTIAL_OPERATION_FAILED: '凭据操作失败',
};

export class CredentialError extends Error {
  readonly code: CredentialErrorCode;

  constructor(code: CredentialErrorCode) {
    super(CREDENTIAL_ERROR_MESSAGES[code]);
    this.name = 'CredentialError';
    this.code = code;
  }
}

export function credentialError(code: CredentialErrorCode): CredentialError {
  return new CredentialError(code);
}

export function isCredentialError(error: unknown): error is CredentialError {
  return error instanceof CredentialError;
}
