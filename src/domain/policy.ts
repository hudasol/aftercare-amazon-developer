/**
 * Versioned return policies and deterministic eligibility evaluation.
 *
 * Policy documents are data (see data/seed/policies.json). This module decides
 * which version governs an order and what that version allows. No model output
 * can change these results.
 */
import { z } from 'zod';
import { addDays, compareDates, daysBetween, isIsoDate, isWithin, type IsoDate } from './dates.js';

const IsoDateSchema = z.string().refine(isIsoDate, 'expected an ISO calendar date (YYYY-MM-DD)');

export const ReturnReasonSchema = z.enum(['defective', 'changed_mind']);
export type ReturnReason = z.infer<typeof ReturnReasonSchema>;

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  categories: z.array(z.string().min(1)).min(1),
  reasons: z.array(ReturnReasonSchema).min(1),
  windowDays: z.number().int().positive(),
  windowStartsOn: z.literal('delivery'),
  resolution: z.enum(['refund']),
  returnShipping: z.enum(['prepaid_label', 'customer_paid']),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyDocumentSchema = z.object({
  policyId: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1),
  publisher: z.string().min(1),
  effectiveFrom: IsoDateSchema,
  effectiveTo: IsoDateSchema.nullable(),
  reference: z.string().min(1),
  rules: z.array(PolicyRuleSchema).min(1),
  /** Refunds without sending the item back are allowed only at or below this price. */
  returnlessRefundMaxCents: z.number().int().nonnegative(),
  /** What the policy points customers to once a defective item is outside every return window. */
  afterWindowDefectRemedy: z.enum(['manufacturer_warranty', 'none']),
  /**
   * Which orders this version governs, as stated in the policy itself. Only
   * order-date scoping is supported: a version governs orders placed while it
   * is in effect.
   */
  appliesTo: z.object({ basis: z.literal('order_date'), text: z.string().min(1) }),
});
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;

/**
 * How the governing version is chosen. This is not an assumption in code: each
 * policy document states its scope in `appliesTo`, and the schema accepts only
 * order-date scoping, so the version in effect on the order date governs.
 */
export const GOVERNING_VERSION_RULE =
  'Each policy version says it applies to orders placed while it is in effect, so the version in effect on the order date governs.';

export type PolicySelection =
  | {
      status: 'selected';
      governing: PolicyDocument;
      considered: ConsideredPolicy[];
    }
  | { status: 'none_in_effect'; considered: ConsideredPolicy[] }
  | { status: 'ambiguous'; overlapping: PolicyDocument[]; considered: ConsideredPolicy[] };

export interface ConsideredPolicy {
  policyId: string;
  version: string;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  used: boolean;
  reason: string;
}

export function selectGoverningPolicy(
  policies: readonly PolicyDocument[],
  orderedOn: IsoDate,
): PolicySelection {
  const inEffect = policies.filter((p) => isWithin(orderedOn, p.effectiveFrom, p.effectiveTo));
  const describe = (p: PolicyDocument, used: boolean): ConsideredPolicy => ({
    policyId: p.policyId,
    version: p.version,
    effectiveFrom: p.effectiveFrom,
    effectiveTo: p.effectiveTo,
    used,
    reason: used
      ? `In effect on the order date (${orderedOn}).`
      : compareDates(p.effectiveFrom, orderedOn) > 0
        ? `Took effect on ${p.effectiveFrom}, after the order was placed.`
        : `Expired on ${p.effectiveTo ?? 'n/a'}, before the order was placed.`,
  });

  const sorted = [...policies].sort((a, b) => compareDates(b.effectiveFrom, a.effectiveFrom));
  if (inEffect.length === 1) {
    const governing = inEffect[0] as PolicyDocument;
    return {
      status: 'selected',
      governing,
      considered: sorted.map((p) => describe(p, p === governing)),
    };
  }
  if (inEffect.length === 0) {
    return { status: 'none_in_effect', considered: sorted.map((p) => describe(p, false)) };
  }
  return {
    status: 'ambiguous',
    overlapping: inEffect,
    considered: sorted.map((p) => ({
      ...describe(p, false),
      reason: inEffect.includes(p)
        ? 'Overlaps another version on the order date; cannot tell which governs.'
        : describe(p, false).reason,
    })),
  };
}

export interface EligibilityInput {
  policy: PolicyDocument;
  category: string;
  reason: ReturnReason;
  deliveredOn: IsoDate;
  asOf: IsoDate;
}

export type EligibilityResult =
  | {
      status: 'eligible';
      rule: PolicyRule;
      deadline: IsoDate;
      daysSinceDelivery: number;
      daysRemaining: number;
    }
  | {
      status: 'not_eligible';
      code: 'window_closed' | 'not_covered';
      rule: PolicyRule | null;
      deadline: IsoDate | null;
      daysSinceDelivery: number;
      alternative: 'manufacturer_warranty' | null;
    };

/** Pure rule evaluation for one fully specified situation. */
export function evaluateReturnEligibility(input: EligibilityInput): EligibilityResult {
  const { policy, category, reason, deliveredOn, asOf } = input;
  const daysSinceDelivery = daysBetween(deliveredOn, asOf);
  const rule = policy.rules.find(
    (r) => r.categories.includes(category) && r.reasons.includes(reason),
  );
  const alternative =
    reason === 'defective' && policy.afterWindowDefectRemedy === 'manufacturer_warranty'
      ? 'manufacturer_warranty'
      : null;
  if (!rule) {
    return {
      status: 'not_eligible',
      code: 'not_covered',
      rule: null,
      deadline: null,
      daysSinceDelivery,
      alternative,
    };
  }
  const deadline = addDays(deliveredOn, rule.windowDays);
  if (compareDates(asOf, deadline) <= 0) {
    return {
      status: 'eligible',
      rule,
      deadline,
      daysSinceDelivery,
      daysRemaining: daysBetween(asOf, deadline),
    };
  }
  return {
    status: 'not_eligible',
    code: 'window_closed',
    rule,
    deadline,
    daysSinceDelivery,
    alternative,
  };
}

/** Two results lead to the same decision (same status, and the same rule when eligible). */
export function sameOutcome(a: EligibilityResult, b: EligibilityResult): boolean {
  if (a.status !== b.status) return false;
  if (a.status === 'eligible' && b.status === 'eligible') return a.rule.id === b.rule.id;
  return true;
}
