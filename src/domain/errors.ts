export type DomainErrorCode =
  | 'illegal_transition'
  | 'not_found'
  | 'forbidden'
  | 'invalid_input'
  | 'approval_required'
  | 'approval_mismatch'
  | 'proposal_not_current'
  | 'duplicate_operation'
  | 'reconciliation_required'
  | 'retry_limit_reached'
  | 'invalid_assessment'
  | 'conflict';

/** A rule violation the caller can act on. Carries a stable code for APIs and tools. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}
