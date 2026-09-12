export type ContextStoreErrorCode =
  | 'CONTEXT_STORE_NOT_READY'
  | 'CONVERSATION_NOT_FOUND'
  | 'CONVERSATION_BUSY'
  | 'CONVERSATION_ARCHIVED'
  | 'CONVERSATION_DELETED'
  | 'EVENT_CONFLICT'
  | 'CONTEXT_BUDGET_EXCEEDED'
  | 'DATABASE_CORRUPT'
  | 'MIGRATION_FAILED'
  | 'PROJECTION_UNAVAILABLE'
  | 'STORE_VERSION_STALE';

export class ContextStoreError extends Error {
  constructor(readonly code: ContextStoreErrorCode, message = code) {
    super(message);
    this.name = 'ContextStoreError';
  }
}
