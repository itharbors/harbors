export type NativeCredentialErrorCode =
  | 'BACKEND_LOCKED'
  | 'BACKEND_UNAVAILABLE'
  | 'ACCESS_DENIED'
  | 'OPERATION_FAILED';

export declare function getPassword(service: string, account: string): string | null;
export declare function setPassword(service: string, account: string, secret: string): void;
export declare function deletePassword(service: string, account: string): boolean;
