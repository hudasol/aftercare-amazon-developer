/**
 * Resolution Compiler.
 *
 * Turns the persisted state of a case (evidence, proposals, operations) into a
 * validated assessment and one justified next step. It is a pure function:
 * the same snapshot always compiles to the same assessment, so decisions can
 * be replayed and audited.
 *
 * Stages:
 *   facts       resolve claims per fact using the authority policy
 *   subject     work out which order line the case is about
 *   policy      choose the governing policy version for each candidate
 *   eligibility evaluate rules, testing unresolved conflicts for materiality
 *   actions     evaluate every catalog action's preconditions
 *   operations  account for proposals and operations already on record
 *   decision    choose the next step and the next case state
 *
 * The compiler asks for information only when it changes the decision, and
 * never proposes an action whose preconditions are unmet.
 */
import {
  ACTION_CATALOG,
  BLOCKING_OPERATION_STATUSES,
  MAX_SUBMISSION_ATTEMPTS,
  PRECONDITION_TEXT,
  proposalDigest,
  type ActionType,
  type Operation,
  type PreconditionId,
  type Proposal,
  type ReturnParameters,
} from './actions.js';
import {
  AssessmentSchema,
  COMPILER_VERSION,
  checkAssessmentInvariants,
  type Assessment,
  type Blocker,
  type CandidateOrder,
  type MissingItem,
  type NextStepKind,
  type ProposalDraft,
} from './assessment.js';
import type { CaseRecord, CaseState } from './case.js';
import { compareDates, isIsoDate, type IsoDate } from './dates.js';
import { DomainError } from './errors.js';
import {
  activeEvidence,
  factKey,
  formatValue,
  inadmissibleClaims,
  INADMISSIBLE_REASON,
  resolveFacts,
  type Evidence,
  type ResolvedFact,
} from './evidence.js';
import { date, describeCandidates, money } from './narrative.js';
import {
  GOVERNING_VERSION_RULE,
  evaluateReturnEligibility,
  sameOutcome,
  selectGoverningPolicy,
  type ConsideredPolicy,
  type EligibilityResult,
  type PolicyDocument,
  type PolicySelection,
  type ReturnReason,
} from './policy.js';

export interface CompilerInput {
  caseRecord: CaseRecord;
  evidence: readonly Evidence[];
  proposals: readonly Proposal[];
  operations: readonly Operation[];
}

const REASONS: readonly ReturnReason[] = ['defective', 'changed_mind'];

const ATTRIBUTE_LABELS: Record<string, string> = {
  orderedOn: 'Order date',
  deliveredOn: 'Delivery date',
  productName: 'Product',
  category: 'Category',
  priceCents: 'Price paid (cents)',
  currency: 'Currency',
  lineId: 'Order line',
  seller: 'Sold by',
  serialNumbers: 'Serial numbers shipped',
  serialLocation: 'Where the serial number is printed',
  openReturn: 'Return already on file',
  goal: 'What the customer wants',
  reason: 'Reason for the return',
  issueDescription: 'Problem described',
  purchaseTimeHint: 'When the customer says they bought it',
  productQuery: 'Product described',
  serialNumber: 'Serial number given by the customer',
  windowDays: 'Return window (days)',
  query: 'Order search',
  resultCount: 'Orders found',
};

export function factLabel(subject: string, attribute: string): string {
  const base = ATTRIBUTE_LABELS[attribute] ?? attribute;
  return subject.startsWith('order:') ? `${base} (${subject.slice(6)})` : base;
}

interface OrderView {
  orderId: string;
  subject: string;
  lineId: string | null;
  productName: string;
  category: string | null;
  priceCents: number | null;
  currency: string;
  orderedOn: IsoDate[];
  deliveredOn: IsoDate[];
  serialNumbers: string[];
  serialLocation: string | null;
  openReturn: string | null;
  evidenceIds: string[];
}

interface Scenario {
  orderedOn: IsoDate;
  deliveredOn: IsoDate;
  reason: ReturnReason;
  selection: PolicySelection;
  result: EligibilityResult | null;
}

interface CandidateEvaluation {
  order: OrderView;
  status: 'eligible' | 'not_eligible' | 'undetermined';
  scenarios: Scenario[];
  policyIssue: 'none_in_effect' | 'ambiguous' | null;
  materialDateConflict: boolean;
  reasonNeeded: boolean;
  representative: Scenario | null;
}

export function normalizeSerial(serial: string): string {
  return serial.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function valueOf(facts: Map<string, ResolvedFact>, subject: string, attribute: string) {
  return facts.get(factKey(subject, attribute));
}

function dateCandidates(fact: ResolvedFact | undefined): IsoDate[] {
  if (!fact) return [];
  const values = fact.status === 'unresolved_conflict' ? fact.candidates : [fact.value];
  return values.filter((v): v is string => isIsoDate(v)).sort(compareDates);
}

function stringOf(fact: ResolvedFact | undefined): string | null {
  return fact && typeof fact.value === 'string' ? fact.value : null;
}

function buildOrderViews(evidence: readonly Evidence[], facts: Map<string, ResolvedFact>) {
  const subjects = new Map<string, string[]>();
  for (const item of activeEvidence(evidence)) {
    if (item.kind !== 'order_record' && item.kind !== 'carrier_scan') continue;
    for (const fact of item.facts) {
      if (!fact.subject.startsWith('order:')) continue;
      const ids = subjects.get(fact.subject) ?? [];
      if (!ids.includes(item.id)) ids.push(item.id);
      subjects.set(fact.subject, ids);
    }
  }
  const views: OrderView[] = [];
  for (const [subject, evidenceIds] of subjects) {
    const productName = stringOf(valueOf(facts, subject, 'productName'));
    if (!productName) continue; // a carrier scan alone does not make an order candidate
    const price = valueOf(facts, subject, 'priceCents')?.value;
    const serials = valueOf(facts, subject, 'serialNumbers')?.value;
    views.push({
      orderId: subject.slice('order:'.length),
      subject,
      lineId: stringOf(valueOf(facts, subject, 'lineId')),
      productName,
      category: stringOf(valueOf(facts, subject, 'category')),
      priceCents: typeof price === 'number' ? price : null,
      currency: stringOf(valueOf(facts, subject, 'currency')) ?? 'USD',
      orderedOn: dateCandidates(valueOf(facts, subject, 'orderedOn')),
      deliveredOn: dateCandidates(valueOf(facts, subject, 'deliveredOn')),
      serialNumbers: Array.isArray(serials) ? serials.map(normalizeSerial) : [],
      serialLocation: stringOf(valueOf(facts, subject, 'serialLocation')),
      openReturn: stringOf(valueOf(facts, subject, 'openReturn')),
      evidenceIds,
    });
  }
  return views.sort((a, b) =>
    compareDates(b.orderedOn[0] ?? '1970-01-01', a.orderedOn[0] ?? '1970-01-01'),
  );
}

function sameGroup(scenarios: Scenario[]): boolean {
  const first = scenarios[0];
  if (!first?.result) return false;
  const version = first.selection.status === 'selected' ? first.selection.governing.version : null;
  return scenarios.every(
    (s) =>
      s.result !== null &&
      sameOutcome(s.result, first.result as EligibilityResult) &&
      (s.selection.status === 'selected' ? s.selection.governing.version : null) === version,
  );
}

function evaluateCandidate(
  order: OrderView,
  policies: readonly PolicyDocument[],
  reason: ReturnReason | null,
  asOf: IsoDate,
): CandidateEvaluation {
  const reasons = reason ? [reason] : [...REASONS];
  const scenarios: Scenario[] = [];
  for (const orderedOn of order.orderedOn) {
    for (const deliveredOn of order.deliveredOn) {
      for (const r of reasons) {
        const selection = selectGoverningPolicy(policies, orderedOn);
        const result =
          selection.status === 'selected' && order.category
            ? evaluateReturnEligibility({
                policy: selection.governing,
                category: order.category,
                reason: r,
                deliveredOn,
                asOf,
              })
            : null;
        scenarios.push({ orderedOn, deliveredOn, reason: r, selection, result });
      }
    }
  }

  const issue = scenarios.find((s) => s.selection.status !== 'selected')?.selection.status;
  const policyIssue = issue === 'none_in_effect' || issue === 'ambiguous' ? issue : null;
  const hasDateConflict = order.orderedOn.length > 1 || order.deliveredOn.length > 1;
  const materialDateConflict =
    hasDateConflict && reasons.some((r) => !sameGroup(scenarios.filter((s) => s.reason === r)));
  const allNotEligible =
    scenarios.length > 0 && scenarios.every((s) => s.result?.status === 'not_eligible');
  const reasonNeeded = reasons.length > 1 && !allNotEligible;

  let status: CandidateEvaluation['status'] = 'undetermined';
  if (scenarios.length > 0 && !policyIssue && order.category && !materialDateConflict) {
    if (allNotEligible) status = 'not_eligible';
    else if (!reasonNeeded && sameGroup(scenarios)) status = 'eligible';
  }

  // Representative scenario: for an eligible item the earliest deadline (the
  // conservative reading when sources disagree); otherwise the first scenario.
  const withResults = scenarios.filter((s) => s.result !== null);
  const representative =
    status === 'eligible'
      ? (withResults.reduce<Scenario | null>((best, s) => {
          const d = s.result?.status === 'eligible' ? s.result.deadline : null;
          const bd = best?.result?.status === 'eligible' ? best.result.deadline : null;
          return !best || (d && bd && compareDates(d, bd) < 0) ? s : best;
        }, null) ?? null)
      : (withResults[0] ?? null);

  return {
    order,
    status,
    scenarios,
    policyIssue,
    materialDateConflict,
    reasonNeeded,
    representative,
  };
}

function resultDeadline(result: EligibilityResult | null | undefined): IsoDate | null {
  return result?.deadline ?? null;
}

function toCandidateOrder(c: CandidateEvaluation): CandidateOrder {
  const rep = c.representative;
  return {
    orderId: c.order.orderId,
    lineId: c.order.lineId ?? '',
    productName: c.order.productName,
    orderedOn: c.order.orderedOn[0] ?? null,
    deliveredOn: c.order.deliveredOn[0] ?? null,
    policyVersion: rep?.selection.status === 'selected' ? rep.selection.governing.version : null,
    eligibility: c.status,
    deadline: c.status === 'undetermined' ? null : resultDeadline(rep?.result),
  };
}

export function compileCase(input: CompilerInput): Assessment {
  const { caseRecord, evidence, proposals, operations } = input;
  const asOf = caseRecord.asOf;
  const trace: Assessment['trace'] = [];
  const missing: MissingItem[] = [];
  const blockers: Blocker[] = [];
  const uncertainty: string[] = [];
  const derived: Assessment['derived'] = [];

  // ---- Stage 1: facts --------------------------------------------------------
  const facts = resolveFacts(evidence);
  const conflicts: Assessment['conflicts'] = [];
  for (const [key, fact] of facts) {
    if (fact.status === 'resolved_by_authority') {
      conflicts.push({
        key,
        label: factLabel(fact.subject, fact.attribute),
        kind: 'resolved_by_authority',
        values: [
          { value: fact.value, evidenceIds: fact.supporting, source: 'deciding source' },
          ...fact.overruled.map((c) => ({
            value: c.value,
            evidenceIds: [c.evidenceId],
            source: c.sourceName,
          })),
        ],
        explanation: fact.explanation,
      });
    }
  }
  for (const claim of inadmissibleClaims(evidence)) {
    conflicts.push({
      key: factKey(claim.subject, claim.attribute),
      label: factLabel(claim.subject, claim.attribute),
      kind: 'inadmissible',
      values: [{ value: claim.value, evidenceIds: [claim.evidenceId], source: claim.sourceName }],
      explanation: `${claim.sourceName}: ${INADMISSIBLE_REASON}`,
    });
  }
  const unresolved = [...facts.values()].filter((f) => f.status === 'unresolved_conflict');
  trace.push({
    stage: 'facts',
    outcome: `${facts.size} facts resolved`,
    detail:
      `${conflicts.filter((c) => c.kind === 'resolved_by_authority').length} settled by authority, ` +
      `${unresolved.length} unresolved, ` +
      `${conflicts.filter((c) => c.kind === 'inadmissible').length} inadmissible claims set aside.`,
  });

  const goalFact = stringOf(valueOf(facts, 'case', 'goal'));
  const goal = goalFact ?? caseRecord.goal.type;
  const reasonValue = stringOf(valueOf(facts, 'case', 'reason'));
  const reason: ReturnReason | null =
    reasonValue === 'defective' || reasonValue === 'changed_mind' ? reasonValue : null;
  const policies = activeEvidence(evidence)
    .map((e) => e.policy)
    .filter((p): p is PolicyDocument => p !== null);
  const searchDone = activeEvidence(evidence).some((e) => e.kind === 'order_search');

  // ---- Stage 2 + 3 + 4: subject, policy, eligibility per candidate ----------
  const orders = buildOrderViews(evidence, facts);
  const evaluations = orders.map((o) => evaluateCandidate(o, policies, reason, asOf));
  const serialFact = valueOf(facts, 'item', 'serialNumber');
  const serial = typeof serialFact?.value === 'string' ? normalizeSerial(serialFact.value) : null;
  const serialMatches = serial
    ? evaluations.filter((e) => e.order.serialNumbers.includes(serial))
    : [];
  const failedSerial = [...evidence]
    .reverse()
    .find((e) => e.kind === 'item_serial' && e.verification === 'failed');

  let subjectStatus: Assessment['subject']['status'];
  let subjectBasis: string;
  let chosen: CandidateEvaluation | null = null;
  if (orders.length === 0) {
    subjectStatus = searchDone ? 'not_found' : 'not_searched';
    subjectBasis = searchDone
      ? 'The order search returned no matching orders.'
      : 'The customer’s orders have not been searched yet.';
  } else if (serial && serialMatches.length === 1) {
    chosen = serialMatches[0] as CandidateEvaluation;
    subjectStatus = 'identified';
    subjectBasis = `Serial ${String(serialFact?.value)} matches a unit shipped on order ${chosen.order.orderId}.`;
  } else if (orders.length === 1) {
    chosen = evaluations[0] as CandidateEvaluation;
    subjectStatus = 'identified';
    subjectBasis = `Only one order matches: ${chosen.order.orderId}.`;
  } else {
    subjectStatus = 'ambiguous';
    subjectBasis = `${orders.length} orders match and nothing yet shows which item the customer has.`;
  }
  trace.push({ stage: 'subject', outcome: subjectStatus, detail: subjectBasis });

  if (!searchDone && orders.length === 0) {
    missing.push({
      id: 'order_lookup',
      label: 'Matching orders',
      why: 'The case needs the purchase record before anything else can be decided.',
      obtainableFrom: 'system',
      blocking: true,
    });
  }
  if (orders.length > 0 && policies.length === 0) {
    missing.push({
      id: 'policy_documents',
      label: 'Return policy versions',
      why: 'Eligibility depends on the policy version that governs the order.',
      obtainableFrom: 'system',
      blocking: true,
    });
  }
  if (subjectStatus === 'not_found') {
    missing.push({
      id: 'order_match',
      label: 'Order number',
      why: 'No order on the account matched the description.',
      obtainableFrom: 'customer',
      blocking: true,
    });
  }

  // When several orders match, identity matters only if some candidate could be returned.
  const anyCandidateEligibleOrOpen = evaluations.some((e) => e.status !== 'not_eligible');
  if (subjectStatus === 'ambiguous' && anyCandidateEligibleOrOpen && policies.length > 0) {
    missing.push({
      id: 'item_serial',
      label: 'Serial number of the item',
      why: 'You have more than one matching order, and they don’t all allow a return, so I need to know which one you have.',
      obtainableFrom: 'customer',
      blocking: true,
    });
  }

  // Policy view for the chosen item (or the first candidate when unidentified).
  const focus = chosen ?? evaluations[0] ?? null;
  const focusSelection = focus?.representative?.selection ?? focus?.scenarios[0]?.selection ?? null;
  const considered: ConsideredPolicy[] = focusSelection?.considered ?? [];
  let policyStatus: Assessment['policy']['status'] =
    policies.length === 0
      ? 'not_loaded'
      : !focusSelection
        ? 'not_applicable'
        : focusSelection.status;
  if (focus?.policyIssue) policyStatus = focus.policyIssue;
  const governing = focusSelection?.status === 'selected' ? focusSelection.governing : null;
  trace.push({
    stage: 'policy',
    outcome: policyStatus,
    detail: governing
      ? `${governing.title} v${governing.version} governs. ${GOVERNING_VERSION_RULE}`
      : policyStatus === 'not_loaded'
        ? 'No policy documents attached yet.'
        : 'No single governing version could be determined.',
  });

  // Unresolved conflicts: material or not, judged on the focus item.
  for (const fact of unresolved) {
    const owner = evaluations.find((e) => e.order.subject === fact.subject);
    const material = owner?.materialDateConflict ?? false;
    conflicts.push({
      key: factKey(fact.subject, fact.attribute),
      label: factLabel(fact.subject, fact.attribute),
      kind: material ? 'material' : 'immaterial',
      values: fact.candidates.map((value) => ({
        value,
        evidenceIds: fact.supporting,
        source: 'record of record',
      })),
      explanation: material
        ? `${fact.explanation} The decision differs depending on which is right.`
        : `${fact.explanation} The decision is the same either way, so the case can continue.`,
    });
    if (!material) {
      uncertainty.push(
        `${factLabel(fact.subject, fact.attribute)} is uncertain (${fact.candidates.map(formatValue).join(' or ')}); the earliest date is used, which gives the earlier deadline.`,
      );
    }
  }

  if (focus?.policyIssue === 'ambiguous') {
    blockers.push({
      code: 'policy_ambiguous',
      title: 'Two policy versions claim the same date',
      customerExplanation:
        'The retailer’s policy records overlap for your order date, so I can’t tell which rules apply.',
      resolvesWith: 'Retailer support confirms which policy version governs.',
    });
  } else if (focus?.policyIssue === 'none_in_effect') {
    blockers.push({
      code: 'no_policy_in_effect',
      title: 'No policy covers the order date',
      customerExplanation: 'I couldn’t find a return policy that was in effect when you ordered.',
      resolvesWith: 'Retailer support supplies the policy in effect on the order date.',
    });
  }
  if (chosen?.materialDateConflict) {
    blockers.push({
      code: 'material_conflict',
      title: 'Records disagree on a date that decides eligibility',
      customerExplanation:
        'Two of the retailer’s records disagree about a date, and the answer changes whether a return is allowed.',
      resolvesWith: 'Retailer support confirms the correct date.',
    });
  }
  if (chosen && chosen.reasonNeeded && !chosen.policyIssue && !chosen.materialDateConflict) {
    missing.push({
      id: 'return_reason',
      label: 'Reason for the return',
      why: 'Faulty items and unwanted items follow different rules and shipping terms.',
      obtainableFrom: 'customer',
      blocking: true,
    });
  }
  if (chosen?.order.openReturn) {
    blockers.push({
      code: 'existing_return',
      title: 'A return is already on file',
      customerExplanation: `The retailer already has a return on file for this item (${chosen.order.openReturn}).`,
      resolvesWith: 'Check the existing return instead of opening a second one.',
    });
  }

  // Eligibility view.
  const rep = chosen?.representative ?? null;
  const repResult = rep?.result ?? null;
  let eligibility: Assessment['eligibility'];
  if (chosen && chosen.status !== 'undetermined' && repResult) {
    const eligible = repResult.status === 'eligible';
    eligibility = {
      status: chosen.status,
      code: repResult.status === 'not_eligible' ? repResult.code : null,
      ruleId: repResult.rule?.id ?? null,
      ruleSummary: repResult.rule?.summary ?? null,
      deadline: repResult.deadline,
      daysSinceDelivery: repResult.daysSinceDelivery,
      daysRemaining: repResult.status === 'eligible' ? repResult.daysRemaining : null,
      alternative:
        repResult.status === 'not_eligible' && reason === 'defective'
          ? repResult.alternative
          : null,
      explanation: eligible
        ? `Delivered ${date(rep?.deliveredOn ?? null)}. ${repResult.rule?.summary} Return by ${date(repResult.deadline)}.`
        : repResult.status === 'not_eligible' && repResult.code === 'window_closed'
          ? `Delivered ${date(rep?.deliveredOn ?? null)}. The return window closed on ${date(repResult.deadline)}.`
          : 'The governing policy has no return rule for this item and reason.',
    };
  } else if (
    !chosen &&
    evaluations.length > 0 &&
    evaluations.every((e) => e.status === 'not_eligible')
  ) {
    const first = evaluations[0]?.representative?.result ?? null;
    eligibility = {
      status: 'not_eligible',
      code: first?.status === 'not_eligible' ? first.code : 'window_closed',
      ruleId: first?.rule?.id ?? null,
      ruleSummary: first?.rule?.summary ?? null,
      deadline: first?.deadline ?? null,
      daysSinceDelivery: first?.daysSinceDelivery ?? null,
      daysRemaining: null,
      alternative:
        reason === 'defective' && first?.status === 'not_eligible' ? first.alternative : null,
      explanation: 'None of the matching orders can still be returned.',
    };
  } else {
    eligibility = {
      status: 'undetermined',
      code: null,
      ruleId: null,
      ruleSummary: null,
      deadline: null,
      daysSinceDelivery: null,
      daysRemaining: null,
      alternative: null,
      explanation:
        missing.length > 0
          ? `Waiting for: ${missing.map((m) => m.label.toLowerCase()).join(', ')}.`
          : blockers.length > 0
            ? blockers.map((b) => b.title).join('; ') + '.'
            : 'Not enough information to decide yet.',
    };
  }
  if (rep && repResult) {
    derived.push({
      key: 'days_since_delivery',
      label: 'Days since delivery',
      value: repResult.daysSinceDelivery,
      basis: `${rep.deliveredOn} to ${asOf} (case date)`,
    });
    if (repResult.deadline) {
      derived.push({
        key: 'return_deadline',
        label: 'Return deadline',
        value: repResult.deadline,
        basis: `${rep.deliveredOn} + ${repResult.rule?.windowDays ?? '?'} days (rule ${repResult.rule?.id ?? 'n/a'})`,
      });
    }
  }
  if (governing) {
    derived.push({
      key: 'governing_policy',
      label: 'Governing policy',
      value: `v${governing.version}`,
      basis: `Policy text: “${governing.appliesTo.text}” Order date ${rep?.orderedOn ?? focus?.order.orderedOn[0] ?? 'unknown'}.`,
    });
  }
  trace.push({
    stage: 'eligibility',
    outcome: eligibility.status,
    detail:
      eligibility.explanation +
      (evaluations.length > 1
        ? ` Candidates: ${evaluations.map((e) => `${e.order.orderId}=${e.status}`).join(', ')}.`
        : ''),
  });

  // ---- Stage 5: actions ------------------------------------------------------
  const activeOps = operations.filter((o) => BLOCKING_OPERATION_STATUSES.includes(o.status));
  const openReturnOnFile = Boolean(chosen?.order.openReturn) || activeOps.length > 0;
  const hasMaterialConflict = conflicts.some((c) => c.kind === 'material');
  const preconditionState = (id: PreconditionId): { met: boolean; detail: string } => {
    switch (id) {
      case 'goal_is_return':
        return { met: goal === 'return', detail: `Customer goal: ${goal}.` };
      case 'goal_is_exchange':
        return { met: goal === 'exchange', detail: `Customer goal: ${goal}.` };
      case 'item_identified':
        return { met: subjectStatus === 'identified', detail: subjectBasis };
      case 'policy_determined':
        return {
          met: governing !== null && !chosen?.policyIssue,
          detail: governing ? `v${governing.version}` : 'No governing version.',
        };
      case 'reason_known':
        return {
          met: reason !== null,
          detail: reason ? `Reason: ${reason}.` : 'Reason not stated.',
        };
      case 'within_return_window':
        return {
          met: eligibility.status === 'eligible',
          detail: eligibility.deadline
            ? `Deadline ${eligibility.deadline}.`
            : eligibility.explanation,
        };
      case 'no_material_conflict':
        return {
          met: !hasMaterialConflict,
          detail: hasMaterialConflict ? 'A conflict changes the decision.' : 'None.',
        };
      case 'no_open_return_for_item':
        return {
          met: !openReturnOnFile,
          detail: openReturnOnFile
            ? 'A return is already on file or in progress.'
            : 'None on file.',
        };
      case 'price_within_returnless_limit': {
        const limit = governing?.returnlessRefundMaxCents ?? 0;
        const price = chosen?.order.priceCents ?? null;
        return {
          met: price !== null && price <= limit,
          detail: `Price ${price === null ? 'unknown' : money(price, chosen?.order.currency ?? 'USD')}; limit ${money(limit, 'USD')}.`,
        };
      }
      case 'return_window_closed':
        return {
          met: eligibility.status === 'not_eligible' && eligibility.code === 'window_closed',
          detail: eligibility.deadline
            ? `Window ended ${eligibility.deadline}.`
            : 'Not established.',
        };
      case 'reason_is_defect':
        return { met: reason === 'defective', detail: reason ? `Reason: ${reason}.` : 'Unknown.' };
    }
  };
  const candidates: Assessment['candidates'] = (Object.keys(ACTION_CATALOG) as ActionType[]).map(
    (type) => {
      const def = ACTION_CATALOG[type];
      const pre = def.preconditions.map((id) => ({
        id,
        description: PRECONDITION_TEXT[id],
        ...preconditionState(id),
      }));
      const unmet = pre.filter((p) => !p.met);
      return {
        actionType: type,
        label: def.label,
        consequential: def.consequential,
        status: unmet.length === 0 ? ('eligible' as const) : ('blocked' as const),
        preconditions: pre,
        reason:
          unmet.length === 0
            ? 'All preconditions met.'
            : `Blocked: ${unmet.map((p) => p.description.replace(/\.$/, '').toLowerCase()).join('; ')}.`,
      };
    },
  );
  const returnAction = candidates.find((c) => c.actionType === 'create_return_authorization');
  trace.push({
    stage: 'actions',
    outcome:
      candidates
        .filter((c) => c.status === 'eligible')
        .map((c) => c.actionType)
        .join(', ') || 'no eligible actions',
    detail: candidates.map((c) => `${c.actionType}: ${c.status}`).join('; '),
  });

  // Draft the return proposal only when every precondition holds.
  let draft: ProposalDraft | null = null;
  if (
    returnAction?.status === 'eligible' &&
    chosen &&
    repResult?.status === 'eligible' &&
    reason &&
    chosen.order.lineId &&
    chosen.order.priceCents !== null &&
    governing
  ) {
    const parameters: ReturnParameters = {
      orderId: chosen.order.orderId,
      lineId: chosen.order.lineId,
      productName: chosen.order.productName,
      reason,
      resolution: 'refund',
      returnShipping: repResult.rule.returnShipping,
      refundAmountCents: chosen.order.priceCents,
      currency: chosen.order.currency,
      policyVersion: governing.version,
      policyRuleId: repResult.rule.id,
      returnBy: repResult.deadline,
    };
    draft = {
      actionType: 'create_return_authorization',
      parameters,
      digest: proposalDigest(caseRecord.id, 'create_return_authorization', parameters),
      preconditions: returnAction.preconditions.map((p) => ({
        id: p.id,
        description: p.description,
        status: 'met' as const,
        evidenceIds: chosen.order.evidenceIds,
      })),
      postconditions: [
        {
          id: 'rma_exists',
          description: `The retailer has a return on file for order ${parameters.orderId}, line ${parameters.lineId}.`,
        },
        { id: 'rma_authorized', description: 'The return is authorized (not pending or refused).' },
        {
          id: 'label_issued',
          description:
            parameters.returnShipping === 'prepaid_label'
              ? 'A prepaid return label has been issued.'
              : 'Return instructions have been issued (customer pays shipping).',
        },
        {
          id: 'refund_amount',
          description: `The refund on file is ${money(parameters.refundAmountCents, parameters.currency)}.`,
        },
      ],
      verification: [
        {
          id: 'lookup',
          description:
            'Read the return back from the retailer by its reference, not from the submission response.',
        },
        {
          id: 'match',
          description: 'Check order, line, refund amount and status against the approved proposal.',
        },
      ],
    };
  }

  // ---- Stage 6: operations ---------------------------------------------------
  const live = proposals.filter((p) => p.status === 'prepared' || p.status === 'approved');
  const latestOp = [...operations].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0] ?? null;
  const opForProposal = (id: string) => operations.find((o) => o.proposalId === id) ?? null;
  const pendingOp =
    latestOp && BLOCKING_OPERATION_STATUSES.includes(latestOp.status) ? latestOp : null;
  const matching = draft ? (live.find((p) => p.digest === draft.digest) ?? null) : null;
  const supersede = live
    .filter((p) => p.id !== matching?.id)
    .filter((p) => {
      const op = opForProposal(p.id);
      return !op || !BLOCKING_OPERATION_STATUSES.includes(op.status);
    })
    .filter(() => !pendingOp)
    .map((p) => p.id);
  trace.push({
    stage: 'operations',
    outcome: pendingOp
      ? `operation ${pendingOp.status}`
      : latestOp
        ? `last operation ${latestOp.status}`
        : 'none',
    detail:
      `${proposals.length} proposal(s), ${operations.length} operation(s) on record.` +
      (supersede.length
        ? ` Withdrawing ${supersede.length} proposal(s) that no longer match the evidence.`
        : ''),
  });

  // ---- Stage 7: decision -----------------------------------------------------
  const params = draft?.parameters ?? null;
  const product = chosen?.order.productName ?? orders[0]?.productName ?? 'your item';
  let kind: NextStepKind;
  let nextCaseState: CaseState;
  let rationale: string;
  let customerMessage: string;
  let speech: string;
  let proposalId: string | null = null;
  let operationId: string | null = null;
  const approvedProposal = (id: string) => proposals.find((p) => p.id === id) ?? null;

  if (pendingOp && (pendingOp.status === 'submitting' || pendingOp.status === 'outcome_unknown')) {
    kind = 'reconcile_operation';
    nextCaseState = 'needs_reconciliation';
    operationId = pendingOp.id;
    proposalId = pendingOp.proposalId;
    rationale =
      'A submission may have reached the retailer without a confirmed result. Resubmitting could create a duplicate, so the retailer’s records must be checked first.';
    customerMessage =
      'I sent your return to the retailer but didn’t get a clear answer back, so it may or may not have gone through. I won’t send it again blindly. I’ll check the retailer’s records first.';
    speech =
      'I didn’t get a clear answer from the retailer. I’ll check their records before doing anything else.';
  } else if (pendingOp && pendingOp.status === 'accepted') {
    kind = 'verify_outcome';
    nextCaseState = 'awaiting_verification';
    operationId = pendingOp.id;
    proposalId = pendingOp.proposalId;
    rationale =
      'The retailer acknowledged the request; acknowledgement is not proof. Verify the postconditions.';
    customerMessage = `The retailer accepted the return request${pendingOp.externalRef ? ` (reference ${pendingOp.externalRef})` : ''}. I’m checking that it’s fully set up before I call it done.`;
    speech = 'The retailer accepted the request. I’m checking it’s fully set up.';
  } else if (pendingOp && pendingOp.status === 'confirmed') {
    kind = 'close_resolved';
    nextCaseState = 'resolved';
    operationId = pendingOp.id;
    proposalId = pendingOp.proposalId;
    const p = approvedProposal(pendingOp.proposalId);
    const label = typeof pendingOp.observed?.['labelUrl'] === 'string';
    rationale = 'The retailer’s record matches every postcondition of the approved action.';
    customerMessage = p
      ? `Your return is confirmed. Return ${pendingOp.externalRef ?? ''} is authorized${label ? ' and your prepaid label is ready' : ''}. Your ${money(p.parameters.refundAmountCents, p.parameters.currency)} refund is issued once the retailer receives the ${p.parameters.productName}.`
      : 'Your return is confirmed.';
    speech = 'Your return is confirmed and the label is ready.';
  } else if (latestOp?.status === 'rejected') {
    kind = 'escalate_for_review';
    nextCaseState = 'needs_review';
    operationId = latestOp.id;
    proposalId = latestOp.proposalId;
    blockers.push({
      code: 'retailer_rejected',
      title: 'The retailer refused the return',
      customerExplanation: `The retailer declined the return request${latestOp.lastError ? `: ${latestOp.lastError}` : ''}.`,
      resolvesWith: 'Retailer support reviews the refusal.',
    });
    rationale =
      'The retailer refused the request. Retrying the same request would not change that.';
    customerMessage = `The retailer declined the return request${latestOp.lastError ? ` (“${latestOp.lastError}”)` : ''}. Nothing else was submitted. I’ve marked your case for review by the retailer’s support team.`;
    speech = 'The retailer declined the return. I’ve flagged it for their support team.';
  } else if (missing.some((m) => m.obtainableFrom === 'system')) {
    kind = 'gather_evidence';
    nextCaseState = 'open';
    rationale = `Retrieve ${missing
      .filter((m) => m.obtainableFrom === 'system')
      .map((m) => m.label.toLowerCase())
      .join(' and ')} from the retailer before deciding.`;
    customerMessage = 'Let me look up your order and the retailer’s return policy.';
    speech = 'Let me look up your order.';
  } else if (blockers.length > 0) {
    kind = 'escalate_for_review';
    nextCaseState = 'needs_review';
    const blocker = blockers[0] as Blocker;
    rationale = `${blocker.title}. This cannot be resolved by the customer, and guessing could start the wrong return.`;
    const conflict = conflicts.find((c) => c.kind === 'material');
    customerMessage =
      blocker.code === 'material_conflict' && conflict
        ? `The retailer’s records disagree about your ${conflict.label.replace(/ \(.*\)$/, '').toLowerCase()} (${conflict.values.map((v) => date(typeof v.value === 'string' ? v.value : null)).join(' vs ')}), and that difference decides whether a return is still allowed. I can’t start a return on an uncertain date, so I’ve flagged your case for review. Nothing has been submitted.`
        : blocker.code === 'existing_return'
          ? `${blocker.customerExplanation} I won’t open a second one.`
          : `${blocker.customerExplanation} I’ve flagged your case for review. Nothing has been submitted.`;
    speech =
      'I can’t safely continue yet, so I’ve flagged your case for review. Nothing was submitted.';
  } else if (missing.some((m) => m.blocking && m.obtainableFrom === 'customer')) {
    kind = 'request_information';
    nextCaseState = 'needs_information';
    const need = missing.find((m) => m.blocking && m.obtainableFrom === 'customer') as MissingItem;
    rationale = need.why;
    if (need.id === 'item_serial') {
      const location = evaluations.find((e) => e.order.serialLocation)?.order.serialLocation;
      const failed = failedSerial
        ? `The serial number you gave (${failedSerial.facts.find((f) => f.attribute === 'serialNumber')?.value ?? ''}) doesn’t match either order. `
        : '';
      customerMessage =
        `${failed}I found ${orders.length} orders for ${product}: ${describeCandidates(
          evaluations.map((e) => ({
            productName: e.order.productName,
            deliveredOn: e.order.deliveredOn[0] ?? null,
            eligibility: e.status,
            deadline: e.status === 'undetermined' ? null : resultDeadline(e.representative?.result),
          })),
        )}. To start the return for the right pair, please tell me the serial number.` +
        (location ? ` It’s printed ${location}.` : '');
      speech = `${failed ? 'That serial didn’t match. ' : ''}You have ${orders.length} orders for these. What’s the serial number on the pair you have?`;
    } else if (need.id === 'return_reason') {
      customerMessage = `Is something wrong with the ${product}, or would you rather not keep them? Faulty items and unwanted items follow different return rules.`;
      speech = 'Is something wrong with them, or would you just rather not keep them?';
    } else {
      customerMessage =
        'I couldn’t find a matching order on your account. What’s the order number?';
      speech = 'I couldn’t find that order. What’s the order number?';
    }
  } else if (eligibility.status === 'not_eligible') {
    kind = 'explain_ineligible';
    nextCaseState = 'not_eligible';
    rationale = eligibility.explanation;
    const warranty = candidates.find(
      (c) => c.actionType === 'manufacturer_warranty_referral' && c.status === 'eligible',
    );
    customerMessage =
      (eligibility.code === 'window_closed' && eligibility.deadline
        ? `The return window for your ${product} closed on ${date(eligibility.deadline)}, so I can’t start a return.`
        : `The retailer’s return policy doesn’t cover this item, so I can’t start a return.`) +
      (warranty
        ? ' Because they’re faulty, the manufacturer’s warranty is the right next step. I can’t file that for you, but your case keeps the order details you’ll need.'
        : '');
    speech =
      'That return window has closed, so I can’t start a return.' +
      (warranty ? ' The manufacturer’s warranty is the next step.' : '');
  } else if (draft && params) {
    const terms = `a return for a full refund of ${money(params.refundAmountCents, params.currency)}, ${params.returnShipping === 'prepaid_label' ? 'with a prepaid shipping label' : 'with return shipping paid by you'}`;
    const policyLine = `Under the return policy that applied when you ordered (version ${params.policyVersion}), your ${params.productName} can be returned until ${date(params.returnBy)}`;
    const failedBefore = matching ? opForProposal(matching.id) : null;
    if (matching?.status === 'approved') {
      proposalId = matching.id;
      if (
        failedBefore &&
        failedBefore.status === 'failed' &&
        failedBefore.attempts >= MAX_SUBMISSION_ATTEMPTS
      ) {
        kind = 'escalate_for_review';
        nextCaseState = 'needs_review';
        operationId = failedBefore.id;
        proposalId = null;
        blockers.push({
          code: 'retry_limit_reached',
          title: 'The retailer could not be reached',
          customerExplanation: `The retailer didn’t process the request after ${failedBefore.attempts} attempts.`,
          resolvesWith: 'Try again later or contact retailer support.',
        });
        rationale = 'Repeated definite failures; further automatic retries are not justified.';
        customerMessage = `The retailer’s system didn’t process your return after ${failedBefore.attempts} tries, and nothing was created. I’ve stopped retrying and flagged your case for review.`;
        speech =
          'The retailer couldn’t process it after several tries. I’ve flagged it for review.';
      } else {
        kind = 'submit_approved_action';
        nextCaseState = 'ready_to_submit';
        operationId = failedBefore?.id ?? null;
        rationale = failedBefore
          ? 'The previous attempt definitely did not execute; the approval still covers this exact request.'
          : 'The customer approved this exact proposal; it can be submitted.';
        customerMessage = failedBefore
          ? 'The retailer’s system didn’t process the last attempt, and nothing was created. Your approval still covers this exact return, so I can safely try again.'
          : 'You approved the return. I’m sending it to the retailer now.';
        speech = failedBefore
          ? 'That attempt didn’t go through. I can safely try again.'
          : 'Sending your return now.';
      }
    } else if (matching?.status === 'prepared') {
      kind = 'await_approval';
      nextCaseState = 'awaiting_approval';
      proposalId = matching.id;
      rationale =
        'A valid proposal exists. Consequential actions need the customer’s explicit approval of this exact proposal.';
      customerMessage = `${policyLine}. Here’s what I’d submit: ${terms}. I won’t send anything until you approve it.`;
      speech = `You can return them until ${date(params.returnBy)}. Should I submit the return for a ${money(params.refundAmountCents, params.currency)} refund?`;
    } else {
      kind = 'propose_action';
      nextCaseState = 'awaiting_approval';
      rationale =
        'Every precondition for a return is met. Prepare the proposal and ask for approval.';
      customerMessage = `${policyLine}. Here’s what I’d submit: ${terms}. I won’t send anything until you approve it.`;
      speech = `You can return them until ${date(params.returnBy)}. Should I submit the return for a ${money(params.refundAmountCents, params.currency)} refund?`;
    }
  } else {
    // Eligible but some non-information precondition fails (for example the goal is not a return).
    kind = 'escalate_for_review';
    nextCaseState = 'needs_review';
    rationale = returnAction?.reason ?? 'No eligible action.';
    blockers.push({
      code: 'nothing_to_return',
      title: 'No action fits the request',
      customerExplanation: 'I can’t find a safe action that matches what you asked for.',
      resolvesWith: 'Retailer support reviews the request.',
    });
    customerMessage =
      'I can’t find a safe action that matches what you asked for, so I’ve flagged your case for review. Nothing has been submitted.';
    speech = 'I can’t find a safe action for that, so I’ve flagged it for review.';
  }

  const headline = headlineFor(kind, product, eligibility);
  trace.push({ stage: 'decision', outcome: kind, detail: rationale });

  const assessment: Assessment = {
    caseId: caseRecord.id,
    caseVersion: caseRecord.version,
    fromState: caseRecord.state,
    compilerVersion: COMPILER_VERSION,
    asOf,
    headline,
    facts: [...facts.entries()].map(([key, f]) => ({
      key,
      label: factLabel(f.subject, f.attribute),
      value: f.value,
      status: f.status,
      evidenceIds: f.supporting,
      explanation: f.explanation,
    })),
    derived,
    conflicts,
    missing,
    subject: {
      status: subjectStatus,
      orderId: chosen?.order.orderId ?? null,
      lineId: chosen?.order.lineId ?? null,
      basis: subjectBasis,
      candidates: evaluations.map(toCandidateOrder),
    },
    policy: {
      status: policyStatus,
      governingVersion: governing?.version ?? null,
      governingTitle: governing?.title ?? null,
      reference: governing?.reference ?? null,
      rule: GOVERNING_VERSION_RULE,
      considered: considered.map((c) => ({
        version: c.version,
        effectiveFrom: c.effectiveFrom,
        effectiveTo: c.effectiveTo,
        used: c.used,
        reason: c.reason,
      })),
    },
    eligibility,
    candidates,
    blockers,
    proposal: kind === 'escalate_for_review' ? null : draft,
    supersedeProposalIds: supersede,
    nextStep: {
      kind,
      rationale,
      customerMessage,
      speech,
      requiresApproval: kind === 'propose_action' || kind === 'await_approval',
      proposalId,
      operationId,
    },
    nextCaseState,
    uncertainty,
    trace,
  };

  return validateAssessment(assessment);
}

function headlineFor(
  kind: NextStepKind,
  product: string,
  eligibility: Assessment['eligibility'],
): string {
  switch (kind) {
    case 'gather_evidence':
      return 'Looking up your order';
    case 'request_information':
      return 'One detail needed before anything can happen';
    case 'escalate_for_review':
      return 'Paused for review. Nothing submitted';
    case 'explain_ineligible':
      return `${product} can’t be returned`;
    case 'propose_action':
    case 'await_approval':
      return `Return ready for your approval${eligibility.deadline ? ` (until ${date(eligibility.deadline)})` : ''}`;
    case 'submit_approved_action':
      return 'Approved. Ready to submit';
    case 'verify_outcome':
      return 'Submitted. Checking the result';
    case 'reconcile_operation':
      return 'Outcome unknown. Checking before retrying';
    case 'close_resolved':
      return 'Return confirmed';
  }
}

export function validateAssessment(candidate: Assessment): Assessment {
  const parsed = AssessmentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new DomainError('invalid_assessment', 'Assessment failed schema validation.', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const violations = checkAssessmentInvariants(parsed.data);
  if (violations.length > 0) {
    throw new DomainError('invalid_assessment', 'Assessment is internally inconsistent.', {
      violations,
    });
  }
  return parsed.data;
}
