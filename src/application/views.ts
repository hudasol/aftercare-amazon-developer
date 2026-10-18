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

export type JourneyStatus =
  'done' | 'current' | 'waiting_on_customer' | 'paused' | 'unknown' | 'stopped' | 'upcoming';

export interface JourneyStage {
  id: 'understand' | 'evidence' | 'clear' | 'approve' | 'submit' | 'confirm';
  label: string;
  status: JourneyStatus;
  note: string;
}

/**
 * The case journey shown on both surfaces, derived from the persisted case
 * state, evidence and action lifecycle. Computed here so no UI has to infer it.
 */
export function deriveJourney(
  record: CaseRecord,
  assessment: Assessment | null,
  evidence: readonly Evidence[],
  lifecycle: ActionLifecycle,
): JourneyStage[] {
  const s = record.state;
  const hasStatement = evidence.some((e) => e.kind === 'customer_statement');
  const hasRecords =
    evidence.some((e) => e.kind === 'order_search') &&
    evidence.some((e) => e.kind === 'policy_document');
  const past = (states: CaseState[]) => states.includes(s);
  const afterApproval: CaseState[] = [
    'ready_to_submit',
    'executing',
    'awaiting_verification',
    'needs_reconciliation',
    'resolved',
  ];
  const stage = (
    id: JourneyStage['id'],
    label: string,
    status: JourneyStatus,
    note = '',
  ): JourneyStage => ({ id, label, status, note });

  const clear: JourneyStage = (() => {
    if (s === 'needs_information') {
      return stage(
        'clear',
        'Clear blockers',
        'waiting_on_customer',
        assessment?.missing[0]?.label ?? 'Waiting for you',
      );
    }
    if (s === 'needs_review' && !['refused', 'failed'].includes(lifecycle.stage)) {
      return stage(
        'clear',
        'Clear blockers',
        'paused',
        assessment?.blockers[0]?.title ?? 'Paused for review',
      );
    }
    if (s === 'not_eligible') return stage('clear', 'Check eligibility', 'stopped', 'Not eligible');
    if (past(['awaiting_approval', 'closed', ...afterApproval]) || s === 'needs_review') {
      return stage('clear', 'Clear blockers', 'done', 'Eligible');
    }
    return stage('clear', 'Clear blockers', hasRecords ? 'current' : 'upcoming');
  })();

  const approve: JourneyStage =
    past(afterApproval) || lifecycle.stage === 'refused'
      ? stage('approve', 'Your approval', 'done', 'Approved')
      : s === 'awaiting_approval'
        ? stage('approve', 'Your approval', 'waiting_on_customer', 'Waiting for you')
        : s === 'closed'
          ? stage('approve', 'Your approval', 'stopped', 'Declined')
          : stage('approve', 'Your approval', 'upcoming');

  const submit: JourneyStage =
    lifecycle.stage === 'outcome_unknown'
      ? stage('submit', 'Submitted', 'unknown', 'Outcome unknown')
      : lifecycle.stage === 'refused'
        ? stage('submit', 'Submitted', 'stopped', 'Refused by retailer')
        : lifecycle.stage === 'submitted' || lifecycle.stage === 'confirmed'
          ? stage('submit', 'Submitted', 'done', 'Accepted by retailer')
          : s === 'ready_to_submit' || s === 'executing'
            ? stage(
                'submit',
                'Submitted',
                'current',
                lifecycle.stage === 'approved' && lifecycle.operationId
                  ? 'Retry pending'
                  : 'Sending',
              )
            : stage('submit', 'Submitted', 'upcoming');

  const confirm: JourneyStage =
    lifecycle.stage === 'confirmed'
      ? stage('confirm', 'Confirmed', 'done', 'Verified with retailer')
      : lifecycle.stage === 'submitted'
        ? stage('confirm', 'Confirmed', 'current', 'Checking')
        : stage('confirm', 'Confirmed', 'upcoming');

  return [
    stage('understand', 'Understand', hasStatement ? 'done' : 'current', record.title),
    stage(
      'evidence',
      'Check records',
      hasRecords ? 'done' : 'current',
      hasRecords ? `${evidence.length} items` : 'Looking up',
    ),
    clear,
    approve,
    submit,
    confirm,
  ];
}

export interface CaseView {
  case: CaseRecord & { stateLabel: string };
  assessmentId: string | null;
  assessment: Assessment | null;
  lifecycle: ActionLifecycle;
  journey: JourneyStage[];
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
