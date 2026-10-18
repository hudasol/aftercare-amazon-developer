/**
 * Proposed actions, scoped approvals and operation records.
 *
 * Lifecycle shown to people:
 *   Prepared -> Approved -> Submitted -> Confirmed
 * with the side states Blocked (no valid proposal) and Outcome unknown.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ReturnReasonSchema } from './policy.js';

export const ActionTypeSchema = z.enum([
  'create_return_authorization',
  'refund_without_return',
  'replacement_order',
  'manufacturer_warranty_referral',
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export interface ActionDefinition {
  type: ActionType;
  label: string;
  /** Consequential actions change state in an external system and always need approval. */
  consequential: boolean;
  preconditions: readonly PreconditionId[];
}

export const PreconditionIdSchema = z.enum([
  'goal_is_return',
  'goal_is_exchange',
  'item_identified',
  'policy_determined',
  'reason_known',
  'within_return_window',
  'no_material_conflict',
  'no_open_return_for_item',
  'price_within_returnless_limit',
  'return_window_closed',
  'reason_is_defect',
]);
export type PreconditionId = z.infer<typeof PreconditionIdSchema>;

export const PRECONDITION_TEXT: Record<PreconditionId, string> = {
  goal_is_return: 'The customer asked to return the item.',
  goal_is_exchange: 'The customer asked for a replacement.',
  item_identified: 'The item is matched to exactly one order.',
  policy_determined: 'The governing return policy version is known.',
  reason_known: 'The reason for the return is known.',
  within_return_window: 'The governing policy allows a return today.',
  no_material_conflict: 'No unresolved conflict could change the decision.',
  no_open_return_for_item: 'No other return for this item is in progress or complete.',
  price_within_returnless_limit: 'The price is within the limit for a refund without return.',
  return_window_closed: 'Every return window for this item has closed.',
  reason_is_defect: 'The item is reported as defective.',
};

export const ACTION_CATALOG: Record<ActionType, ActionDefinition> = {
  create_return_authorization: {
    type: 'create_return_authorization',
    label: 'Start a return for a refund',
    consequential: true,
    preconditions: [
      'goal_is_return',
      'item_identified',
      'policy_determined',
      'reason_known',
      'no_material_conflict',
      'within_return_window',
      'no_open_return_for_item',
    ],
  },
  refund_without_return: {
    type: 'refund_without_return',
    label: 'Refund without sending the item back',
    consequential: true,
    preconditions: [
      'goal_is_return',
      'item_identified',
      'policy_determined',
      'within_return_window',
      'price_within_returnless_limit',
    ],
  },
  replacement_order: {
    type: 'replacement_order',
    label: 'Send a replacement',
    consequential: true,
    preconditions: ['goal_is_exchange', 'item_identified', 'within_return_window'],
  },
  manufacturer_warranty_referral: {
    type: 'manufacturer_warranty_referral',
    label: 'Point the customer to the manufacturer warranty',
    consequential: false,
    preconditions: ['item_identified', 'reason_is_defect', 'return_window_closed'],
  },
};

export const ReturnParametersSchema = z.object({
  orderId: z.string().min(1),
  lineId: z.string().min(1),
  productName: z.string().min(1),
  reason: ReturnReasonSchema,
  resolution: z.literal('refund'),
  returnShipping: z.enum(['prepaid_label', 'customer_paid']),
  refundAmountCents: z.number().int().positive(),
  currency: z.string().length(3),
  policyVersion: z.string().min(1),
  policyRuleId: z.string().min(1),
  returnBy: z.string().min(1),
});
export type ReturnParameters = z.infer<typeof ReturnParametersSchema>;

export const ConditionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
});

/**
 * Proposal status covers authorization only. What happened at the retailer
 * after approval is tracked on the operation, not here.
 */
export const ProposalStatusSchema = z.enum(['prepared', 'approved', 'declined', 'superseded']);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const ProposalSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1),
  actionType: z.literal('create_return_authorization'),
  parameters: ReturnParametersSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  preconditions: z.array(
    ConditionSchema.extend({ status: z.literal('met'), evidenceIds: z.array(z.string()) }),
  ),
  postconditions: z.array(ConditionSchema),
  verification: z.array(ConditionSchema),
  requiresApproval: z.literal(true),
  status: ProposalStatusSchema,
  assessmentId: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  proposalId: z.string().min(1),
  caseId: z.string().min(1),
  /** The approval covers exactly the proposal with this digest. */
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  approvedBy: z.string().min(1),
  channel: z.enum(['assistant_surface', 'mcp_client']),
  statement: z.string().min(1),
  approvedAt: z.string(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const OperationStatusSchema = z.enum([
  /** Written before the adapter call. If found after a crash, the outcome is unknown. */
  'submitting',
  /** The retailer acknowledged the request. Not yet verified. */
  'accepted',
  /** Postconditions verified against the retailer's record. */
  'confirmed',
  /** The retailer refused the request. Nothing was created. */
  'rejected',
  /** Definitely not executed (reported unprocessed, or reconciliation found no record). */
  'failed',
  /** May or may not have been executed. Must be reconciled before any retry. */
  'outcome_unknown',
]);
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

export const OperationSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1),
  proposalId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  status: OperationStatusSchema,
  attempts: z.number().int().nonnegative(),
  externalRef: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Last observation from the retailer, as reported by the adapter. */
  observed: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Operation = z.infer<typeof OperationSchema>;

export const MAX_SUBMISSION_ATTEMPTS = 3;

/** Statuses that block a new submission for the same proposal. */
export const BLOCKING_OPERATION_STATUSES: readonly OperationStatus[] = [
  'submitting',
  'accepted',
  'confirmed',
  'outcome_unknown',
];

/** Canonical JSON: object keys sorted, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function proposalDigest(
  caseId: string,
  actionType: ActionType,
  parameters: ReturnParameters,
): string {
  return createHash('sha256')
    .update(canonicalJson({ caseId, actionType, parameters }))
    .digest('hex');
}
