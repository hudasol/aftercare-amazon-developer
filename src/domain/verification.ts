/**
 * Postcondition verification: compare what the retailer's record says now
 * with what the customer approved. A submission returning without an error is
 * never treated as proof; only this check can confirm an outcome.
 */
import type { Proposal } from './actions.js';

export interface ObservedReturn {
  rmaId: string;
  orderId: string;
  lineId: string;
  status: 'processing' | 'authorized' | 'refused';
  refundAmountCents: number;
  currency: string;
  returnShipping: 'prepaid_label' | 'customer_paid';
  labelUrl: string | null;
  refusalReason: string | null;
}

export interface VerificationCheck {
  id: string;
  description: string;
  passed: boolean;
  observed: string;
}

export type VerificationOutcome =
  | { result: 'confirmed'; checks: VerificationCheck[] }
  | { result: 'pending'; checks: VerificationCheck[] }
  | { result: 'refused'; checks: VerificationCheck[]; reason: string }
  | { result: 'mismatch'; checks: VerificationCheck[] };

export function verifyReturnPostconditions(
  proposal: Proposal,
  observed: ObservedReturn,
): VerificationOutcome {
  const p = proposal.parameters;
  const checks: VerificationCheck[] = [
    {
      id: 'rma_exists',
      description: `A return exists for order ${p.orderId}, line ${p.lineId}`,
      passed: observed.orderId === p.orderId && observed.lineId === p.lineId,
      observed: `${observed.rmaId} on ${observed.orderId}/${observed.lineId}`,
    },
    {
      id: 'refund_amount',
      description: 'Refund amount matches the approval',
      passed:
        observed.refundAmountCents === p.refundAmountCents && observed.currency === p.currency,
      observed: `${observed.refundAmountCents} ${observed.currency}`,
    },
    {
      id: 'shipping_terms',
      description: 'Return shipping terms match the approval',
      passed: observed.returnShipping === p.returnShipping,
      observed: observed.returnShipping,
    },
    {
      id: 'rma_authorized',
      description: 'The return is authorized',
      passed: observed.status === 'authorized',
      observed: observed.status,
    },
    {
      id: 'label_issued',
      description:
        p.returnShipping === 'prepaid_label'
          ? 'A prepaid label has been issued'
          : 'No label is required',
      passed: p.returnShipping !== 'prepaid_label' || observed.labelUrl !== null,
      observed: observed.labelUrl ?? 'none yet',
    },
  ];

  const identityOk = checks.filter((c) =>
    ['rma_exists', 'refund_amount', 'shipping_terms'].includes(c.id),
  );
  if (identityOk.some((c) => !c.passed)) return { result: 'mismatch', checks };
  if (observed.status === 'refused') {
    return {
      result: 'refused',
      checks,
      reason: observed.refusalReason ?? 'Refused by the retailer.',
    };
  }
  if (checks.every((c) => c.passed)) return { result: 'confirmed', checks };
  return { result: 'pending', checks };
}
