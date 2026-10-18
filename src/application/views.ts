/**
 * Read models returned by the HTTP API and MCP tools. Everything here is
 * derived from persisted records; nothing is computed in the UI.
 */
import type { Approval, Operation, Proposal } from '../domain/actions.js';
import type { Assessment } from '../domain/assessment.js';
import type { CaseRecord, CaseState } from '../domain/case.js';
import type { Evidence } from '../domain/evidence.js';
import type { AttemptRecord, EventRecord, MessageRecord } from './repository.js';

export const STATE_LABELS: Record<CaseState, string> = {
  open: 'Gathering details',
  needs_information: 'Waiting for you',
  needs_review: 'Paused for review',
  awaiting_approval: 'Waiting for your approval',
  ready_to_submit: 'Approved, ready to submit',
  executing: 'Submitting',
  awaiting_verification: 'Submitted, checking result',
  needs_reconciliation: 'Outcome unknown, checking',
  resolved: 'Resolved',
  not_eligible: 'Not eligible',
  closed: 'Closed',
};

/** The single action lifecycle stage shown to people. */
export type LifecycleStage =
  | 'none'
  | 'blocked'
  | 'prepared'
  | 'approved'
  | 'submitted'
  | 'outcome_unknown'
  | 'confirmed'
  | 'failed'
  | 'refused';

export interface ActionLifecycle {
  stage: LifecycleStage;
  label: string;
  proposalId: string | null;
  operationId: string | null;
  detail: string;
}

const STAGE_LABELS: Record<LifecycleStage, string> = {
  none: 'No action yet',
  blocked: 'Blocked',
  prepared: 'Prepared',
  approved: 'Approved',
  submitted: 'Submitted',
  outcome_unknown: 'Outcome unknown',
  confirmed: 'Confirmed',
  failed: 'Not executed',
  refused: 'Refused by retailer',
};

export function deriveLifecycle(
  assessment: Assessment | null,
  proposals: readonly Proposal[],
  operations: readonly Operation[],
): ActionLifecycle {
  const latestOp = [...operations].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
  const live = [...proposals]
    .reverse()
    .find((p) => p.status === 'prepared' || p.status === 'approved');
  const make = (
    stage: LifecycleStage,
    detail: string,
    p?: Proposal | null,
    o?: Operation | null,
  ) => ({
    stage,
    label: STAGE_LABELS[stage],
    proposalId: p?.id ?? o?.proposalId ?? null,
    operationId: o?.id ?? null,
    detail,
  });
  if (latestOp) {
    switch (latestOp.status) {
      case 'confirmed':
        return make(
          'confirmed',
          'The retailer’s record matches what was approved.',
          null,
          latestOp,
        );
      case 'accepted':
        return make('submitted', 'Accepted by the retailer; not yet verified.', null, latestOp);
      case 'submitting':
      case 'outcome_unknown':
        return make('outcome_unknown', 'May or may not have reached the retailer.', null, latestOp);
      case 'rejected':
        return make('refused', latestOp.lastError ?? 'Refused by the retailer.', null, latestOp);
      case 'failed':
        if (live?.status === 'approved' && live.id === latestOp.proposalId) {
          return make(
            'approved',
            'Last attempt definitely did not execute; approval still applies.',
            live,
            latestOp,
          );
        }
        return make('failed', latestOp.lastError ?? 'Not executed.', null, latestOp);
    }
  }
  if (live?.status === 'approved')
    return make('approved', 'Approved by the customer; not yet submitted.', live);
  if (live?.status === 'prepared')
    return make('prepared', 'Proposed; nothing authorized or submitted.', live);
  if (
    assessment &&
    (assessment.blockers.length > 0 || assessment.nextStep.kind === 'request_information')
  ) {
    return make('blocked', assessment.nextStep.rationale);
  }
  return make('none', 'No action proposed.');
}

export interface CaseView {
  case: CaseRecord & { stateLabel: string };
  assessmentId: string | null;
  assessment: Assessment | null;
  lifecycle: ActionLifecycle;
  messages: MessageRecord[];
  evidence: Evidence[];
  proposals: Proposal[];
  approvals: Approval[];
  operations: Operation[];
  attempts: AttemptRecord[];
  events: EventRecord[];
}

export interface CaseSummary {
  id: string;
  title: string;
  state: CaseState;
  stateLabel: string;
  headline: string | null;
  updatedAt: string;
}
