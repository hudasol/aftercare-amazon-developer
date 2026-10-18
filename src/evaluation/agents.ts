/**
 * The two strategies compared by the evaluation harness.
 *
 * AFTERCARE: the real application service (Resolution Compiler and safety
 * controls), driven by a scripted customer.
 *
 * Baseline: a simple deterministic agent with the same tools and the same
 * language interpreter, but none of AFTERCARE's controls. It reflects a common
 * tool-calling design: find the most recent matching order, apply the
 * currently published policy, treat agreement as approval, report success when
 * the submission call returns, and retry failures with a new request. It is a
 * reference point for what the controls prevent. It is NOT a measurement of
 * any particular LLM or product.
 */
import { randomUUID } from 'node:crypto';
import type { Container } from '../container.js';
import { addDays, compareDates } from '../domain/dates.js';
import type { ReturnReason } from '../domain/policy.js';
import { GatewayTimeoutError, type RetailerGateway } from '../application/ports.js';
import type { CaseView } from '../application/views.js';
import { RulesInterpreter } from '../infrastructure/interpreter/rules-interpreter.js';
import type { Scenario } from './scenarios.js';

export type Claim =
  'confirmed' | 'denied' | 'escalated' | 'refused' | 'no_action' | 'pending' | 'failed';

export interface Submission {
  orderId: string;
  returnShipping: 'prepaid_label' | 'customer_paid';
  /** What authorized it: an explicit approval of these exact terms, or something weaker. */
  basis: 'explicit_current' | 'chat_agreement' | 'earlier_approval_of_other_terms' | 'none';
  idempotencyKey: string;
}

export interface Run {
  claim: Claim;
  submissions: Submission[];
  /** Retailer status of the return at the moment the agent told the customer it was confirmed. */
  statusAtConfirmationClaim: string | null;
  steps: string[];
}

const CUSTOMER = 'cus_demo_maya';
const ctx = { customerRef: CUSTOMER, channel: 'assistant_surface' as const };
const MAX_STEPS = 16;

function retailerStatus(container: Container, key: string): string | null {
  return container.sandbox.listReturns().find((r) => r.idempotencyKey === key)?.status ?? null;
}

// ---------------------------------------------------------------------------------------
// AFTERCARE
// ---------------------------------------------------------------------------------------

function claimOf(view: CaseView): Claim {
  if (view.lifecycle.stage === 'confirmed') return 'confirmed';
  if (view.case.state === 'not_eligible') return 'denied';
  if (view.lifecycle.stage === 'refused') return 'refused';
  if (view.case.state === 'needs_review') return 'escalated';
  if (view.case.state === 'awaiting_approval' || view.case.state === 'closed') return 'no_action';
  return 'pending';
}

export async function runAftercare(container: Container, scenario: Scenario): Promise<Run> {
  const service = container.service;
  const steps: string[] = [];
  const submissions: Submission[] = [];
  const c = scenario.customer;
  let view = await service.openCase({ ...ctx, utterance: c.opening });
  steps.push(`open → ${view.case.state}`);
  const caseId = view.case.id;
  let serialGiven = false;
  let reasonGiven = false;
  let thirdPartyShared = false;
  let chatAgreementSent = false;
  let afterApprovalSent = false;

  for (let i = 0; i < MAX_STEPS; i++) {
    if (c.citesThirdParty && !thirdPartyShared) {
      thirdPartyShared = true;
      view = await container.demo.injectThirdPartyClaim(caseId);
      steps.push(`customer shares blog → ${view.case.state}`);
      continue;
    }
    const a = view.assessment;
    const state = view.case.state;
    if (state === 'needs_information') {
      const need = a?.missing.find((m) => m.obtainableFrom === 'customer' && m.blocking)?.id;
      if (need === 'item_serial' && c.serial && !serialGiven) {
        serialGiven = true;
        view = await service.provideSerial({ ...ctx, caseId, serialNumber: c.serial });
        steps.push(`serial ${c.serial} → ${view.case.state}`);
        continue;
      }
      if (need === 'return_reason' && c.reasonReply && !reasonGiven) {
        reasonGiven = true;
        view = await service.sendMessage({ ...ctx, caseId, utterance: c.reasonReply });
        steps.push(`reason reply → ${view.case.state}`);
        continue;
      }
      break;
    }
    if (state === 'awaiting_approval') {
      const proposal = view.proposals.find((p) => p.status === 'prepared');
      if (!proposal) break;
      if (c.approval === 'chat_only') {
        if (chatAgreementSent) break;
        chatAgreementSent = true;
        view = await service.sendMessage({ ...ctx, caseId, utterance: 'Yes, go ahead!' });
        steps.push(`customer says "yes, go ahead" → ${view.case.state}`);
        continue;
      }
      view = await service.approve({
        ...ctx,
        caseId,
        proposalId: proposal.id,
        digest: proposal.digest,
        statement: 'Approve return',
      });
      steps.push(`approve ${proposal.parameters.returnShipping} → ${view.case.state}`);
      continue;
    }
    if (state === 'ready_to_submit') {
      if (c.afterApproval && !afterApprovalSent) {
        afterApprovalSent = true;
        view = await service.sendMessage({ ...ctx, caseId, utterance: c.afterApproval });
        steps.push(`customer changes reason → ${view.case.state}`);
        continue;
      }
      const proposal = view.proposals.find((p) => p.status === 'approved');
      if (!proposal) break;
      const approval = view.approvals.find(
        (x) => x.proposalId === proposal.id && x.digest === proposal.digest,
      );
      try {
        view = await service.execute({ ...ctx, caseId, proposalId: proposal.id });
      } catch (error) {
        steps.push(`submit refused: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      const op = view.operations.find((o) => o.proposalId === proposal.id);
      submissions.push({
        orderId: proposal.parameters.orderId,
        returnShipping: proposal.parameters.returnShipping,
        basis: approval ? 'explicit_current' : 'none',
        idempotencyKey: op?.idempotencyKey ?? 'unknown',
      });
      steps.push(`submit → ${view.case.state} (${op?.status})`);
      continue;
    }
    if (state === 'needs_reconciliation' || state === 'awaiting_verification') {
      view = await service.checkOutcome({ ...ctx, caseId });
      steps.push(`check outcome → ${view.case.state}`);
      continue;
    }
    break;
  }

  const claim = claimOf(view);
  const key = view.operations.at(-1)?.idempotencyKey;
  return {
    claim,
    submissions,
    statusAtConfirmationClaim: claim === 'confirmed' && key ? retailerStatus(container, key) : null,
    steps,
  };
}

// ---------------------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------------------

export async function runBaseline(
  container: Container,
  scenario: Scenario,
  caseDate: string,
): Promise<Run> {
  const gateway: RetailerGateway = container.sandbox;
  const interpreter = new RulesInterpreter();
  const c = scenario.customer;
  const steps: string[] = [];
  const submissions: Submission[] = [];

  const opening = await interpreter.interpret(c.opening);
  const orders = await gateway.searchOrders(CUSTOMER, opening.productQuery);
  const order = orders[0]; // most recent first
  if (!order)
    return {
      claim: 'denied',
      submissions,
      statusAtConfirmationClaim: null,
      steps: ['no order found'],
    };
  steps.push(`picked most recent order ${order.orderId}`);

  const policies = await gateway.listPolicyVersions();
  const current = [...policies].sort((a, b) => compareDates(b.effectiveFrom, a.effectiveFrom))[0];
  if (!current) return { claim: 'escalated', submissions, statusAtConfirmationClaim: null, steps };
  const reason: ReturnReason = opening.reason ?? 'defective';
  const rule =
    current.rules.find(
      (r) => r.categories.includes(order.category) && r.reasons.includes(reason),
    ) ?? current.rules.find((r) => r.categories.includes(order.category));
  steps.push(`applied current policy v${current.version}, reason ${reason}`);
  if (!rule || compareDates(caseDate, addDays(order.deliveredOn, rule.windowDays)) > 0) {
    steps.push('outside window → denied');
    return { claim: 'denied', submissions, statusAtConfirmationClaim: null, steps };
  }

  // Asks "shall I start the return?" and takes the next agreeable reply as approval.
  const basis: Submission['basis'] =
    c.approval === 'chat_only'
      ? 'chat_agreement'
      : c.afterApproval
        ? 'earlier_approval_of_other_terms'
        : 'explicit_current';
  steps.push(
    c.approval === 'chat_only' ? 'treated "yes, go ahead" as approval' : 'customer approved',
  );
  if (c.afterApproval)
    steps.push('customer changed the reason after approving; already approved, so submitting');

  for (let attempt = 1; attempt <= 3; attempt++) {
    const key = randomUUID(); // a new request each attempt
    const submission: Submission = {
      orderId: order.orderId,
      returnShipping: rule.returnShipping,
      basis,
      idempotencyKey: key,
    };
    submissions.push(submission);
    try {
      const result = await gateway.createReturn({
        idempotencyKey: key,
        customerRef: CUSTOMER,
        orderId: order.orderId,
        lineId: order.lineId,
        reason,
        refundAmountCents: order.priceCents,
        currency: order.currency,
        returnShipping: rule.returnShipping,
      });
      if (result.kind === 'accepted') {
        steps.push(`attempt ${attempt}: accepted → told customer it is confirmed`);
        return {
          claim: 'confirmed',
          submissions,
          statusAtConfirmationClaim: retailerStatus(container, key),
          steps,
        };
      }
      if (result.kind === 'rejected') {
        steps.push(`attempt ${attempt}: rejected (${result.reason})`);
        return { claim: 'refused', submissions, statusAtConfirmationClaim: null, steps };
      }
      steps.push(`attempt ${attempt}: unavailable → retry`);
    } catch (error) {
      steps.push(
        `attempt ${attempt}: ${error instanceof GatewayTimeoutError ? 'timeout' : 'error'} → retry`,
      );
    }
  }
  return { claim: 'failed', submissions, statusAtConfirmationClaim: null, steps };
}
