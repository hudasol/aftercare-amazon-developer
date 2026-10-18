import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, isTerminal } from '../../src/domain/case.js';
import { factKey, inadmissibleClaims, resolveFacts } from '../../src/domain/evidence.js';
import {
  evaluateReturnEligibility,
  selectGoverningPolicy,
  type PolicyDocument,
} from '../../src/domain/policy.js';
import { NEW_PAIR, POLICIES, ev } from '../support/fixtures.js';

const [V1, V2] = POLICIES as [PolicyDocument, PolicyDocument];

describe('authority policy', () => {
  it('lets a retailer record outrank the customer on an order fact', () => {
    const customer = ev.statement({ goal: 'return' });
    customer.facts = [
      { subject: `order:${NEW_PAIR.orderId}`, attribute: 'deliveredOn', value: '2026-10-10' },
    ];
    const facts = resolveFacts([ev.order(NEW_PAIR), customer]);
    const delivered = facts.get(factKey(`order:${NEW_PAIR.orderId}`, 'deliveredOn'));
    expect(delivered?.status).toBe('resolved_by_authority');
    expect(delivered?.value).toBe('2026-09-30');
    expect(delivered?.overruled.map((c) => c.value)).toEqual(['2026-10-10']);
  });

  it('leaves a disagreement between equally authoritative records unresolved', () => {
    const facts = resolveFacts([ev.order(NEW_PAIR), ev.carrier(NEW_PAIR.orderId, '2026-10-03')]);
    const delivered = facts.get(factKey(`order:${NEW_PAIR.orderId}`, 'deliveredOn'));
    expect(delivered?.status).toBe('unresolved_conflict');
    expect(delivered?.value).toBeNull();
    expect(delivered?.candidates).toEqual(['2026-09-30', '2026-10-03']);
  });

  it('treats agreeing records as established', () => {
    const facts = resolveFacts([ev.order(NEW_PAIR), ev.carrier(NEW_PAIR.orderId, '2026-09-30')]);
    expect(facts.get(factKey(`order:${NEW_PAIR.orderId}`, 'deliveredOn'))?.status).toBe(
      'established',
    );
  });

  it('lets a customer correct their own earlier statement', () => {
    const first = ev.statement({ reason: 'defective' });
    const second = ev.statement({ reason: 'changed_mind' });
    const reason = resolveFacts([first, second]).get('case.reason');
    expect(reason?.value).toBe('changed_mind');
    expect(reason?.status).toBe('resolved_by_authority');
  });

  it('never lets a third-party page decide a policy fact', () => {
    const evidence = [ev.thirdParty(90)];
    expect(resolveFacts(evidence).size).toBe(0);
    expect(inadmissibleClaims(evidence)).toHaveLength(1);
  });

  it('ignores identifiers whose verification failed', () => {
    const facts = resolveFacts([ev.serial('HA-000-0000', null)]);
    expect(facts.has('item.serialNumber')).toBe(false);
  });
});

describe('governing policy selection', () => {
  it('uses the version in effect on the order date, not the newest one', () => {
    const selection = selectGoverningPolicy(POLICIES, '2026-09-26');
    expect(selection.status).toBe('selected');
    if (selection.status !== 'selected') return;
    expect(selection.governing.version).toBe('2026.1');
    expect(selection.considered.find((c) => c.version === '2026.2')?.used).toBe(false);
  });

  it('uses the new version for orders placed on or after its effective date', () => {
    const selection = selectGoverningPolicy(POLICIES, '2026-10-01');
    expect(selection.status === 'selected' && selection.governing.version).toBe('2026.2');
  });

  it('reports overlapping versions as ambiguous', () => {
    const overlap: PolicyDocument = { ...V2, version: '2026.2-draft', effectiveFrom: '2026-09-15' };
    expect(selectGoverningPolicy([V1, overlap], '2026-09-20').status).toBe('ambiguous');
  });

  it('reports a gap in coverage', () => {
    expect(selectGoverningPolicy([V2], '2026-09-20').status).toBe('none_in_effect');
  });
});

describe('return eligibility', () => {
  const base = {
    policy: V1,
    category: 'personal_audio',
    reason: 'defective' as const,
    deliveredOn: '2026-09-30',
  };

  it('includes the last day of the window', () => {
    const result = evaluateReturnEligibility({ ...base, asOf: '2026-10-30' });
    expect(result.status).toBe('eligible');
    expect(result.status === 'eligible' && result.daysRemaining).toBe(0);
  });

  it('closes the day after the deadline and offers the warranty for defects', () => {
    const result = evaluateReturnEligibility({ ...base, asOf: '2026-10-31' });
    expect(result).toMatchObject({
      status: 'not_eligible',
      code: 'window_closed',
      alternative: 'manufacturer_warranty',
    });
  });

  it('gives the same item a shorter window under the newer version', () => {
    const result = evaluateReturnEligibility({ ...base, policy: V2, asOf: '2026-10-17' });
    expect(result).toMatchObject({ status: 'not_eligible', deadline: '2026-10-15' });
  });

  it('reports categories the policy does not cover', () => {
    const result = evaluateReturnEligibility({
      ...base,
      category: 'gift_card',
      asOf: '2026-10-01',
    });
    expect(result).toMatchObject({ status: 'not_eligible', code: 'not_covered' });
  });
});

describe('case lifecycle', () => {
  it('allows the main path', () => {
    const path = [
      'open',
      'needs_information',
      'awaiting_approval',
      'ready_to_submit',
      'executing',
      'needs_reconciliation',
      'awaiting_verification',
      'resolved',
    ] as const;
    for (let i = 1; i < path.length; i++) {
      expect(
        canTransition(path[i - 1] as (typeof path)[number], path[i] as (typeof path)[number]),
      ).toBe(true);
    }
  });

  it('rejects skipping approval and leaving terminal states', () => {
    expect(() => assertTransition('needs_information', 'executing')).toThrow(/cannot move/);
    expect(() => assertTransition('awaiting_approval', 'executing')).toThrow();
    expect(() => assertTransition('resolved', 'open')).toThrow();
    expect(isTerminal('resolved')).toBe(true);
    expect(isTerminal('closed')).toBe(true);
  });

  it('does not let an unknown outcome jump straight back to submission without reconciliation states', () => {
    expect(canTransition('executing', 'executing')).toBe(false);
    expect(canTransition('needs_reconciliation', 'executing')).toBe(false);
  });
});
