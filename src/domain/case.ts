/**
 * Resolution case lifecycle and its legal transitions.
 */
import { z } from 'zod';
import { DomainError } from './errors.js';

export const CaseStateSchema = z.enum([
  /** Created; evidence is still being gathered. */
  'open',
  /** Blocked until the customer supplies something only they can provide. */
  'needs_information',
  /** Blocked on something the customer cannot fix (conflicting records, retailer refusal). */
  'needs_review',
  /** A valid proposal exists and waits for explicit, scoped customer approval. */
  'awaiting_approval',
  /** Approved; not yet successfully submitted (first attempt or retry after a definite failure). */
  'ready_to_submit',
  /** A submission is in flight. Persisted before the adapter is called. */
  'executing',
  /** The retailer accepted the request; its outcome has not been verified yet. */
  'awaiting_verification',
  /** A submission may or may not have happened; it must be reconciled before anything else. */
  'needs_reconciliation',
  /** The action's postconditions were verified. */
  'resolved',
  /** The policy does not allow the requested resolution. */
  'not_eligible',
  /** Closed by the customer without a resolution. */
  'closed',
]);
export type CaseState = z.infer<typeof CaseStateSchema>;

const ASSESSABLE: CaseState[] = [
  'open',
  'needs_information',
  'needs_review',
  'awaiting_approval',
  'not_eligible',
];

const TRANSITIONS: Record<CaseState, readonly CaseState[]> = {
  open: [...ASSESSABLE, 'closed'],
  needs_information: [...ASSESSABLE, 'closed'],
  needs_review: [...ASSESSABLE, 'closed'],
  not_eligible: [...ASSESSABLE, 'closed'],
  awaiting_approval: [...ASSESSABLE, 'ready_to_submit', 'closed'],
  // An approved action can still be invalidated by new evidence before submission.
  ready_to_submit: [...ASSESSABLE, 'executing', 'closed'],
  executing: ['awaiting_verification', 'needs_reconciliation', 'ready_to_submit', 'needs_review'],
  awaiting_verification: [
    'awaiting_verification',
    'resolved',
    'needs_reconciliation',
    'needs_review',
  ],
  needs_reconciliation: [
    'needs_reconciliation',
    'awaiting_verification',
    'resolved',
    'ready_to_submit',
    'needs_review',
  ],
  resolved: [],
  closed: [],
};

export function canTransition(from: CaseState, to: CaseState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: CaseState, to: CaseState): void {
  if (!canTransition(from, to)) {
    throw new DomainError('illegal_transition', `A case cannot move from ${from} to ${to}.`);
  }
}

export function isTerminal(state: CaseState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** States in which an operation may exist that the case must not lose track of. */
export const OPERATION_STATES: readonly CaseState[] = [
  'executing',
  'awaiting_verification',
  'needs_reconciliation',
];

export const GoalSchema = z.object({
  type: z.enum(['return', 'exchange', 'unknown']),
  productQuery: z.string().nullable(),
});
export type Goal = z.infer<typeof GoalSchema>;

export const CaseRecordSchema = z.object({
  id: z.string().min(1),
  customerRef: z.string().min(1),
  state: CaseStateSchema,
  goal: GoalSchema,
  /** Business date eligibility is evaluated on. Pinned per case so demo outcomes are repeatable. */
  asOf: z.string(),
  title: z.string(),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CaseRecord = z.infer<typeof CaseRecordSchema>;

export function listTransitions(): Record<CaseState, readonly CaseState[]> {
  return TRANSITIONS;
}
