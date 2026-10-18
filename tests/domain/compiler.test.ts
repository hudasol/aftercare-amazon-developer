import { describe, expect, it } from 'vitest';
import type { Operation, Proposal } from '../../src/domain/actions.js';
import type { CaseState } from '../../src/domain/case.js';
import { compileCase, validateAssessment } from '../../src/domain/compiler.js';
import type { Evidence } from '../../src/domain/evidence.js';
import type { RetailerOrder } from '../../src/application/ports.js';
import {
  NEW_PAIR,
  OLD_PAIR,
  ORDERS,
  caseRecord,
  ev,
  flagshipEvidence,
  operation,
  proposal,
} from '../support/fixtures.js';

function compile(
  evidence: Evidence[],
  opts: { state?: CaseState; proposals?: Proposal[]; operations?: Operation[] } = {},
) {
  return compileCase({
    caseRecord: caseRecord({ state: opts.state ?? 'open' }),
    evidence,
    proposals: opts.proposals ?? [],
    operations: opts.operations ?? [],
  });
}

function eligibleFlagship() {
  return [...flagshipEvidence(), ev.serial('ha-7q2-4471', NEW_PAIR)];
}

/** A prepared proposal persisted from the compiler's own draft. */
function persisted(evidence: Evidence[], status: Proposal['status'] = 'prepared'): Proposal {
  const draft = compile(evidence).proposal;
  if (!draft) throw new Error('expected a proposal draft');
  return proposal({ parameters: draft.parameters, digest: draft.digest, status });
}

describe('Resolution Compiler: gathering and identifying', () => {
  it('asks the system for orders before anything else', () => {
    const a = compile([
      ev.statement({ goal: 'return', reason: 'defective', productQuery: 'headphones' }),
    ]);
    expect(a.nextStep.kind).toBe('gather_evidence');
    expect(a.missing.map((m) => m.id)).toContain('order_lookup');
    expect(a.nextCaseState).toBe('open');
  });

  it('blocks the flagship case until the customer identifies which pair they have', () => {
    const a = compile(flagshipEvidence());
    expect(a.nextStep.kind).toBe('request_information');
    expect(a.nextCaseState).toBe('needs_information');
    expect(a.subject.status).toBe('ambiguous');
    expect(a.missing.find((m) => m.id === 'item_serial')?.blocking).toBe(true);
    expect(a.proposal).toBeNull();
    expect(a.eligibility.status).toBe('undetermined');
    const byOrder = Object.fromEntries(a.subject.candidates.map((c) => [c.orderId, c]));
    expect(byOrder[NEW_PAIR.orderId]).toMatchObject({
      eligibility: 'eligible',
      deadline: '2026-10-30',
      policyVersion: '2026.1',
    });
    expect(byOrder[OLD_PAIR.orderId]).toMatchObject({
      eligibility: 'not_eligible',
      deadline: '2026-08-30',
    });
    const ret = a.candidates.find((c) => c.actionType === 'create_return_authorization');
    expect(ret?.status).toBe('blocked');
    expect(ret?.preconditions.find((p) => p.id === 'item_identified')?.met).toBe(false);
    expect(a.nextStep.customerMessage).toMatch(/serial number/);
    expect(a.nextStep.customerMessage).toMatch(/left ear cup/);
  });

  it('proposes a return once a verified serial identifies the newer pair', () => {
    const a = compile(eligibleFlagship(), { state: 'needs_information' });
    expect(a.nextStep.kind).toBe('propose_action');
    expect(a.nextStep.requiresApproval).toBe(true);
    expect(a.nextCaseState).toBe('awaiting_approval');
    expect(a.subject).toMatchObject({ status: 'identified', orderId: NEW_PAIR.orderId });
    expect(a.policy.governingVersion).toBe('2026.1');
    expect(a.policy.considered.find((c) => c.version === '2026.2')).toMatchObject({ used: false });
    expect(a.eligibility).toMatchObject({
      status: 'eligible',
      deadline: '2026-10-30',
      daysRemaining: 13,
    });
    expect(a.proposal?.parameters).toMatchObject({
      orderId: NEW_PAIR.orderId,
      reason: 'defective',
      returnShipping: 'prepaid_label',
      refundAmountCents: 18900,
      policyRuleId: 'R1-ELEC-FAULT',
      returnBy: '2026-10-30',
    });
    expect(a.candidates.find((c) => c.actionType === 'refund_without_return')?.status).toBe(
      'blocked',
    );
  });

  it('explains ineligibility and points to the warranty when the serial matches the older pair', () => {
    const a = compile([...flagshipEvidence(), ev.serial('HA-7Q2-0193', OLD_PAIR)], {
      state: 'needs_information',
    });
    expect(a.nextStep.kind).toBe('explain_ineligible');
    expect(a.nextCaseState).toBe('not_eligible');
    expect(a.proposal).toBeNull();
    expect(a.eligibility).toMatchObject({
      status: 'not_eligible',
      code: 'window_closed',
      alternative: 'manufacturer_warranty',
    });
    expect(
      a.candidates.find((c) => c.actionType === 'manufacturer_warranty_referral')?.status,
    ).toBe('eligible');
  });

  it('stays blocked and says so when the serial does not match', () => {
    const a = compile([...flagshipEvidence(), ev.serial('HA-9Z9-9999', null)], {
      state: 'needs_information',
    });
    expect(a.nextStep.kind).toBe('request_information');
    expect(a.nextStep.customerMessage).toMatch(/doesn’t match either order/);
  });

  it('asks for the reason only when it changes the decision', () => {
    const single = [
      ev.statement({ goal: 'return', productQuery: 'headphones' }),
      ev.search([NEW_PAIR]),
      ev.order(NEW_PAIR),
      ...ev.policies(),
    ];
    const asked = compile(single);
    expect(asked.nextStep.kind).toBe('request_information');
    expect(asked.missing.map((m) => m.id)).toEqual(['return_reason']);

    const expired = [
      ev.statement({ goal: 'return', productQuery: 'headphones' }),
      ev.search([OLD_PAIR]),
      ev.order(OLD_PAIR),
      ...ev.policies(),
    ];
    const notAsked = compile(expired);
    expect(notAsked.nextStep.kind).toBe('explain_ineligible');
    expect(notAsked.missing).toHaveLength(0);
  });

  it('generalizes beyond headphones: an unwanted kitchen item follows the home rule', () => {
    const seeded = ORDERS.find((o) => o.category === 'kitchen') as RetailerOrder;
    const kitchen: RetailerOrder = {
      ...seeded,
      orderedOn: '2026-10-03',
      deliveredOn: '2026-10-05',
    };
    const a = compile([
      ev.statement({ goal: 'return', reason: 'changed_mind', productQuery: 'pour-over' }),
      ev.search([kitchen]),
      ev.order(kitchen),
      ...ev.policies(),
    ]);
    expect(a.nextStep.kind).toBe('propose_action');
    expect(a.proposal?.parameters).toMatchObject({
      policyVersion: '2026.2',
      policyRuleId: 'R4-HOME',
      returnBy: '2026-11-04',
    });
  });

  it('reports the seeded kitchen order as past its window', () => {
    const kitchen = ORDERS.find((o) => o.category === 'kitchen') as RetailerOrder;
    const a = compile([
      ev.statement({ goal: 'return', reason: 'changed_mind', productQuery: 'pour-over' }),
      ev.search([kitchen]),
      ev.order(kitchen),
      ...ev.policies(),
    ]);
    expect(a.eligibility).toMatchObject({ status: 'not_eligible', deadline: '2026-10-11' });
  });

  it('does not propose a return when the customer asked for something else', () => {
    const a = compile([
      ev.statement({ goal: 'exchange', reason: 'defective', productQuery: 'headphones' }),
      ev.search([NEW_PAIR]),
      ev.order(NEW_PAIR),
      ...ev.policies(),
    ]);
    expect(a.proposal).toBeNull();
    expect(a.nextStep.kind).toBe('escalate_for_review');
  });
});

describe('Resolution Compiler: conflicts', () => {
  it('continues when conflicting delivery records lead to the same decision', () => {
    const a = compile([...eligibleFlagship(), ev.carrier(NEW_PAIR.orderId, '2026-10-02')]);
    expect(a.conflicts.find((c) => c.kind === 'immaterial')).toBeTruthy();
    expect(a.nextStep.kind).toBe('propose_action');
    expect(a.proposal?.parameters.returnBy).toBe('2026-10-30');
    expect(a.uncertainty.join(' ')).toMatch(/earliest date/);
  });

  it('blocks for review when conflicting records change the decision', () => {
    const lateOrder: RetailerOrder = {
      ...NEW_PAIR,
      orderId: 'KG-1170-0001',
      orderedOn: '2026-10-01',
      deliveredOn: '2026-10-01',
      serialNumbers: ['HA-7Q2-5000'],
    };
    const evidence = [
      ev.statement({ goal: 'return', reason: 'defective', productQuery: 'headphones' }),
      ev.search([lateOrder]),
      ev.order(lateOrder),
      ev.carrier(lateOrder.orderId, '2026-10-03'),
      ...ev.policies(),
    ];
    const a = compile(evidence);
    expect(a.nextStep.kind).toBe('escalate_for_review');
    expect(a.nextCaseState).toBe('needs_review');
    expect(a.blockers.map((b) => b.code)).toContain('material_conflict');
    expect(a.conflicts.find((c) => c.kind === 'material')).toBeTruthy();
    expect(a.proposal).toBeNull();
  });

  it('sets aside a third-party claim of a 90-day window', () => {
    const a = compile([
      ...flagshipEvidence(),
      ev.serial('HA-7Q2-0193', OLD_PAIR),
      ev.thirdParty(90),
    ]);
    expect(a.nextStep.kind).toBe('explain_ineligible');
    expect(a.conflicts.find((c) => c.kind === 'inadmissible')?.values[0]?.value).toBe(90);
  });
});

describe('Resolution Compiler: proposals and operations', () => {
  it('waits for approval of an existing matching proposal instead of drafting a new one', () => {
    const evidence = eligibleFlagship();
    const p = persisted(evidence);
    const a = compile(evidence, { state: 'awaiting_approval', proposals: [p] });
    expect(a.nextStep).toMatchObject({
      kind: 'await_approval',
      proposalId: p.id,
      requiresApproval: true,
    });
    expect(a.supersedeProposalIds).toEqual([]);
  });

  it('withdraws a proposal, even an approved one, when the evidence behind it changes', () => {
    const evidence = eligibleFlagship();
    const p = persisted(evidence, 'approved');
    const changed = [...evidence, ev.statement({ reason: 'changed_mind' })];
    const a = compile(changed, { state: 'ready_to_submit', proposals: [p] });
    expect(a.supersedeProposalIds).toEqual([p.id]);
    expect(a.nextStep.kind).toBe('propose_action');
    expect(a.proposal?.parameters.returnShipping).toBe('customer_paid');
  });

  it('submits only an approved proposal whose digest still matches', () => {
    const evidence = eligibleFlagship();
    const p = persisted(evidence, 'approved');
    const a = compile(evidence, { state: 'ready_to_submit', proposals: [p] });
    expect(a.nextStep).toMatchObject({
      kind: 'submit_approved_action',
      proposalId: p.id,
      requiresApproval: false,
    });
  });

  it.each(['submitting', 'outcome_unknown'] as const)(
    'reconciles before anything else when an operation is %s',
    (status) => {
      const evidence = eligibleFlagship();
      const p = persisted(evidence, 'approved');
      const a = compile(evidence, {
        state: 'executing',
        proposals: [p],
        operations: [operation({ status })],
      });
      expect(a.nextStep).toMatchObject({ kind: 'reconcile_operation', operationId: 'op_1' });
      expect(a.nextCaseState).toBe('needs_reconciliation');
      expect(a.proposal).toBeNull();
    },
  );

  it('verifies an accepted operation instead of declaring success', () => {
    const evidence = eligibleFlagship();
    const p = persisted(evidence, 'approved');
    const a = compile(evidence, {
      state: 'executing',
      proposals: [p],
      operations: [operation({ status: 'accepted', externalRef: 'RMA-1' })],
    });
    expect(a.nextStep.kind).toBe('verify_outcome');
    expect(a.nextCaseState).toBe('awaiting_verification');
  });

  it('resolves only after confirmation', () => {
    const evidence = eligibleFlagship();
    const p = persisted(evidence, 'approved');
    const a = compile(evidence, {
      state: 'awaiting_verification',
      proposals: [p],
      operations: [
        operation({
          status: 'confirmed',
          externalRef: 'RMA-1',
          observed: { labelUrl: 'demo://label' },
        }),
      ],
    });
    expect(a.nextStep.kind).toBe('close_resolved');
    expect(a.nextCaseState).toBe('resolved');
  });

  it('retries a definite failure under the same approval, up to a limit', () => {
    const evidence = eligibleFlagship();
    const p = persisted(evidence, 'approved');
    const retry = compile(evidence, {
      state: 'executing',
      proposals: [p],
      operations: [operation({ status: 'failed', attempts: 1 })],
    });
    expect(retry.nextStep.kind).toBe('submit_approved_action');
    expect(retry.nextCaseState).toBe('ready_to_submit');
    const stop = compile(evidence, {
      state: 'executing',
      proposals: [p],
      operations: [operation({ status: 'failed', attempts: 3 })],
    });
    expect(stop.nextStep.kind).toBe('escalate_for_review');
    expect(stop.blockers.map((b) => b.code)).toContain('retry_limit_reached');
  });

  it('escalates a retailer refusal rather than retrying it', () => {
    const evidence = eligibleFlagship();
    const p = persisted(evidence, 'approved');
    const a = compile(evidence, {
      state: 'executing',
      proposals: [p],
      operations: [operation({ status: 'rejected', lastError: 'Item already returned' })],
    });
    expect(a.nextStep.kind).toBe('escalate_for_review');
    expect(a.blockers.map((b) => b.code)).toContain('retailer_rejected');
  });
});

describe('Resolution Compiler: output contract', () => {
  it('is deterministic', () => {
    const evidence = eligibleFlagship();
    expect(compile(evidence)).toEqual(compile(evidence));
  });

  it('rejects an assessment that proposes an action while blocked', () => {
    const good = compile(eligibleFlagship());
    const tampered = {
      ...good,
      blockers: [
        {
          code: 'material_conflict' as const,
          title: 't',
          customerExplanation: 'c',
          resolvesWith: 'r',
        },
      ],
    };
    expect(() => validateAssessment(tampered)).toThrow(/inconsistent/);
  });

  it('rejects a proposal whose digest does not match its parameters', () => {
    const good = compile(eligibleFlagship());
    if (!good.proposal) throw new Error('expected proposal');
    const tampered = {
      ...good,
      proposal: {
        ...good.proposal,
        parameters: { ...good.proposal.parameters, refundAmountCents: 99999 },
      },
    };
    expect(() => validateAssessment(tampered)).toThrow();
  });

  it('rejects an assessment that requests approval for a non-approval step', () => {
    const good = compile(flagshipEvidence());
    expect(() =>
      validateAssessment({ ...good, nextStep: { ...good.nextStep, requiresApproval: true } }),
    ).toThrow();
  });
});
