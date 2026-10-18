/**
 * The Resolution Compiler's output contract.
 *
 * An assessment is checked twice before anything is persisted or acted on:
 * once against this schema and once against cross-field invariants (for
 * example, a proposal may never accompany an unresolved blocker).
 */
import { z } from 'zod';
import {
  ActionTypeSchema,
  ConditionSchema,
  PreconditionIdSchema,
  ReturnParametersSchema,
  proposalDigest,
} from './actions.js';
import { CaseStateSchema, canTransition, type CaseState } from './case.js';
import { FactValueSchema } from './evidence.js';

export const COMPILER_VERSION = '1.0.0';

export const NextStepKindSchema = z.enum([
  'gather_evidence',
  'request_information',
  'escalate_for_review',
  'explain_ineligible',
  'propose_action',
  'await_approval',
  'submit_approved_action',
  'verify_outcome',
  'reconcile_operation',
  'close_resolved',
]);
export type NextStepKind = z.infer<typeof NextStepKindSchema>;

const APPROVAL_STEPS: readonly NextStepKind[] = ['propose_action', 'await_approval'];
const ACTION_STEPS: readonly NextStepKind[] = [
  'propose_action',
  'await_approval',
  'submit_approved_action',
];

export const MissingItemSchema = z.object({
  id: z.enum([
    'order_lookup',
    'policy_documents',
    'order_match',
    'item_serial',
    'return_reason',
    'product_description',
  ]),
  label: z.string(),
  why: z.string(),
  obtainableFrom: z.enum(['customer', 'system']),
  blocking: z.boolean(),
});
export type MissingItem = z.infer<typeof MissingItemSchema>;

export const BlockerSchema = z.object({
  code: z.enum([
    'item_not_identified',
    'reason_unknown',
    'material_conflict',
    'policy_ambiguous',
    'no_policy_in_effect',
    'retailer_rejected',
    'outcome_mismatch',
    'retry_limit_reached',
    'existing_return',
    'nothing_to_return',
  ]),
  title: z.string(),
  customerExplanation: z.string(),
  resolvesWith: z.string(),
});
export type Blocker = z.infer<typeof BlockerSchema>;

const EligibilityViewSchema = z.object({
  status: z.enum(['eligible', 'not_eligible', 'undetermined']),
  code: z.enum(['window_closed', 'not_covered']).nullable(),
  ruleId: z.string().nullable(),
  ruleSummary: z.string().nullable(),
  deadline: z.string().nullable(),
  daysSinceDelivery: z.number().int().nullable(),
  daysRemaining: z.number().int().nullable(),
  alternative: z.enum(['manufacturer_warranty']).nullable(),
  explanation: z.string(),
});

export const CandidateOrderSchema = z.object({
  orderId: z.string(),
  lineId: z.string(),
  productName: z.string(),
  orderedOn: z.string().nullable(),
  deliveredOn: z.string().nullable(),
  policyVersion: z.string().nullable(),
  eligibility: z.enum(['eligible', 'not_eligible', 'undetermined']),
  deadline: z.string().nullable(),
});
export type CandidateOrder = z.infer<typeof CandidateOrderSchema>;

export const ProposalDraftSchema = z.object({
  actionType: z.literal('create_return_authorization'),
  parameters: ReturnParametersSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  preconditions: z.array(
    ConditionSchema.extend({ status: z.literal('met'), evidenceIds: z.array(z.string()) }),
  ),
  postconditions: z.array(ConditionSchema),
  verification: z.array(ConditionSchema),
});
export type ProposalDraft = z.infer<typeof ProposalDraftSchema>;

export const AssessmentSchema = z.object({
  caseId: z.string().min(1),
  caseVersion: z.number().int().nonnegative(),
  fromState: CaseStateSchema,
  compilerVersion: z.string(),
  asOf: z.string(),
  headline: z.string().min(1),
  facts: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      value: FactValueSchema,
      status: z.enum(['established', 'resolved_by_authority', 'unresolved_conflict']),
      evidenceIds: z.array(z.string()),
      explanation: z.string(),
    }),
  ),
  derived: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      value: z.union([z.string(), z.number()]),
      basis: z.string(),
    }),
  ),
  conflicts: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      kind: z.enum(['resolved_by_authority', 'immaterial', 'material', 'inadmissible']),
      values: z.array(
        z.object({ value: FactValueSchema, evidenceIds: z.array(z.string()), source: z.string() }),
      ),
      explanation: z.string(),
    }),
  ),
  missing: z.array(MissingItemSchema),
  subject: z.object({
    status: z.enum(['identified', 'ambiguous', 'not_found', 'not_searched']),
    orderId: z.string().nullable(),
    lineId: z.string().nullable(),
    basis: z.string(),
    candidates: z.array(CandidateOrderSchema),
  }),
  policy: z.object({
    status: z.enum(['selected', 'none_in_effect', 'ambiguous', 'not_loaded', 'not_applicable']),
    governingVersion: z.string().nullable(),
    governingTitle: z.string().nullable(),
    reference: z.string().nullable(),
    rule: z.string(),
    considered: z.array(
      z.object({
        version: z.string(),
        effectiveFrom: z.string(),
        effectiveTo: z.string().nullable(),
        used: z.boolean(),
        reason: z.string(),
      }),
    ),
  }),
  eligibility: EligibilityViewSchema,
  candidates: z.array(
    z.object({
      actionType: ActionTypeSchema,
      label: z.string(),
      consequential: z.boolean(),
      status: z.enum(['eligible', 'blocked']),
      preconditions: z.array(
        z.object({
          id: PreconditionIdSchema,
          description: z.string(),
          met: z.boolean(),
          detail: z.string(),
        }),
      ),
      reason: z.string(),
    }),
  ),
  blockers: z.array(BlockerSchema),
  proposal: ProposalDraftSchema.nullable(),
  /** Existing proposals that no longer match the evidence and must be withdrawn. */
  supersedeProposalIds: z.array(z.string()),
  nextStep: z.object({
    kind: NextStepKindSchema,
    rationale: z.string().min(1),
    customerMessage: z.string().min(1),
    speech: z.string().min(1),
    requiresApproval: z.boolean(),
    proposalId: z.string().nullable(),
    operationId: z.string().nullable(),
  }),
  nextCaseState: CaseStateSchema,
  uncertainty: z.array(z.string()),
  trace: z.array(
    z.object({
      stage: z.enum([
        'facts',
        'subject',
        'policy',
        'eligibility',
        'actions',
        'operations',
        'decision',
      ]),
      outcome: z.string(),
      detail: z.string(),
    }),
  ),
});
export type Assessment = z.infer<typeof AssessmentSchema>;

/**
 * Cross-field checks. Returns a list of violations; empty means consistent.
 * A non-empty list is a defect in the compiler, never something to work around.
 */
export function checkAssessmentInvariants(a: Assessment): string[] {
  const violations: string[] = [];
  const kind = a.nextStep.kind;
  const returnCandidate = a.candidates.find((c) => c.actionType === 'create_return_authorization');

  if (ACTION_STEPS.includes(kind)) {
    if (a.eligibility.status !== 'eligible') {
      violations.push(`${kind} requires eligibility "eligible", got "${a.eligibility.status}".`);
    }
    if (a.blockers.length > 0) {
      violations.push(
        `${kind} cannot proceed while blockers exist (${a.blockers.map((b) => b.code).join(', ')}).`,
      );
    }
    if (!a.proposal) violations.push(`${kind} requires a proposal.`);
    if (!returnCandidate || returnCandidate.status !== 'eligible') {
      violations.push(`${kind} requires the return action to be eligible.`);
    }
  }
  if (APPROVAL_STEPS.includes(kind) !== a.nextStep.requiresApproval) {
    violations.push(`requiresApproval must be true exactly for ${APPROVAL_STEPS.join(' and ')}.`);
  }
  if ((kind === 'await_approval' || kind === 'submit_approved_action') && !a.nextStep.proposalId) {
    violations.push(`${kind} must reference an existing proposal.`);
  }
  if ((kind === 'verify_outcome' || kind === 'reconcile_operation') && !a.nextStep.operationId) {
    violations.push(`${kind} must reference an operation.`);
  }
  if (a.proposal) {
    const expected = proposalDigest(a.caseId, a.proposal.actionType, a.proposal.parameters);
    if (expected !== a.proposal.digest)
      violations.push('Proposal digest does not match its parameters.');
    if (a.eligibility.status !== 'eligible') {
      violations.push('A proposal cannot exist unless the return is eligible.');
    }
    if (returnCandidate?.preconditions.some((p) => !p.met)) {
      violations.push('A proposal cannot exist while any of its preconditions is unmet.');
    }
  }
  if (kind === 'request_information') {
    if (!a.missing.some((m) => m.blocking && m.obtainableFrom === 'customer')) {
      violations.push('request_information requires a blocking item the customer can provide.');
    }
  }
  if (kind === 'gather_evidence' && !a.missing.some((m) => m.obtainableFrom === 'system')) {
    violations.push('gather_evidence requires missing system evidence.');
  }
  if (a.eligibility.status === 'eligible' && (!a.eligibility.deadline || !a.eligibility.ruleId)) {
    violations.push('An eligible result must name its rule and deadline.');
  }
  if (
    a.blockers.some((b) => b.code === 'material_conflict') &&
    !a.conflicts.some((c) => c.kind === 'material')
  ) {
    violations.push('A material-conflict blocker must cite a material conflict.');
  }
  if (!canTransition(a.fromState, a.nextCaseState) && a.fromState !== a.nextCaseState) {
    violations.push(`Illegal transition ${a.fromState} -> ${a.nextCaseState}.`);
  }
  return violations;
}

/** States the compiler may choose. Executing is set only by the execution use case. */
export const COMPILER_STATES: readonly CaseState[] = CaseStateSchema.options.filter(
  (s) => s !== 'executing' && s !== 'closed',
);
