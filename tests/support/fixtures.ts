import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Operation, Proposal } from '../../src/domain/actions.js';
import type { CaseRecord, CaseState } from '../../src/domain/case.js';
import type { Evidence } from '../../src/domain/evidence.js';
import { PolicyDocumentSchema, type PolicyDocument } from '../../src/domain/policy.js';
import {
  carrierScanEvidence,
  customerStatementEvidence,
  orderEvidence,
  orderSearchEvidence,
  policyEvidence,
  serialEvidence,
  thirdPartyClaimEvidence,
} from '../../src/application/evidence-factory.js';
import type { Interpretation, RetailerOrder } from '../../src/application/ports.js';

interface SeedOrder extends Omit<RetailerOrder, 'openReturn'> {
  openReturn?: string | null;
}

const seed = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../data/seed/retailer.json', import.meta.url)), 'utf8'),
) as { orders: SeedOrder[]; policies: unknown[]; caseDate: string };

export const CASE_DATE = seed.caseDate;
export const POLICIES: PolicyDocument[] = seed.policies.map((p) => PolicyDocumentSchema.parse(p));
export const ORDERS: RetailerOrder[] = seed.orders.map((o) => ({
  ...o,
  openReturn: o.openReturn ?? null,
}));
export const OLD_PAIR = ORDERS.find((o) => o.orderId === 'KG-1140-2207') as RetailerOrder;
export const NEW_PAIR = ORDERS.find((o) => o.orderId === 'KG-1162-5821') as RetailerOrder;

let counter = 0;
let clock = Date.parse('2026-10-17T10:00:00Z');
export function meta(caseId = 'case_test') {
  counter += 1;
  clock += 1000;
  return { id: `ev_${counter}`, caseId, observedAt: new Date(clock).toISOString() };
}

export function caseRecord(overrides: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: 'case_test',
    customerRef: 'cus_demo_maya',
    state: 'open' as CaseState,
    goal: { type: 'return', productQuery: 'wireless headphones' },
    asOf: CASE_DATE,
    title: 'Return headphones',
    version: 1,
    createdAt: '2026-10-17T10:00:00Z',
    updatedAt: '2026-10-17T10:00:00Z',
    ...overrides,
  };
}

export function interpretation(overrides: Partial<Interpretation> = {}): Interpretation {
  return {
    goal: null,
    productQuery: null,
    reason: null,
    issueDescription: null,
    purchaseTimeHint: null,
    serialNumber: null,
    orderNumber: null,
    soundsLikeApproval: false,
    wantsToCancel: false,
    ...overrides,
  };
}

export const ev = {
  statement: (i: Partial<Interpretation>, text = 'customer message') =>
    customerStatementEvidence(meta(), text, interpretation(i), 'test') as Evidence,
  search: (orders: RetailerOrder[], query = 'wireless headphones') =>
    orderSearchEvidence(
      meta(),
      query,
      orders.map((o) => o.orderId),
      'Kestrel Goods',
      true,
    ),
  order: (o: RetailerOrder) => orderEvidence(meta(), o, 'Kestrel Goods', true),
  policies: (ps: PolicyDocument[] = POLICIES) => ps.map((p) => policyEvidence(meta(), p, true)),
  serial: (serial: string, match: RetailerOrder | null) =>
    serialEvidence(meta(), serial, match, 'Kestrel Goods'),
  carrier: (orderId: string, deliveredOn: string) =>
    carrierScanEvidence(
      meta(),
      { orderId, carrier: 'Swiftline Parcel', trackingRef: 'SL-TEST', deliveredOn },
      true,
    ),
  thirdParty: (windowDays = 90) =>
    thirdPartyClaimEvidence(meta(), {
      sourceName: 'DealDigest blog',
      url: 'demo://dealdigest/kestrel-returns',
      policyId: 'kestrel-returns',
      windowDays,
      excerpt: `Kestrel Goods gives you ${windowDays} days to return anything.`,
    }),
};

/** The flagship case after the first customer message and system lookups. */
export function flagshipEvidence(): Evidence[] {
  return [
    ev.statement({
      goal: 'return',
      reason: 'defective',
      issueDescription: 'My wireless headphones keep disconnecting.',
      purchaseTimeHint: 'recently',
      productQuery: 'wireless headphones',
    }),
    ev.search([OLD_PAIR, NEW_PAIR]),
    ev.order(OLD_PAIR),
    ev.order(NEW_PAIR),
    ...ev.policies(),
  ];
}

export function proposal(
  overrides: Partial<Proposal> & Pick<Proposal, 'parameters' | 'digest'>,
): Proposal {
  return {
    id: 'prop_1',
    caseId: 'case_test',
    actionType: 'create_return_authorization',
    preconditions: [],
    postconditions: [],
    verification: [],
    requiresApproval: true,
    status: 'prepared',
    assessmentId: 'asm_1',
    createdAt: '2026-10-17T10:05:00Z',
    updatedAt: '2026-10-17T10:05:00Z',
    ...overrides,
  };
}

export function operation(overrides: Partial<Operation>): Operation {
  return {
    id: 'op_1',
    caseId: 'case_test',
    proposalId: 'prop_1',
    idempotencyKey: 'aftercare-prop_1',
    status: 'submitting',
    attempts: 1,
    externalRef: null,
    lastError: null,
    observed: null,
    createdAt: '2026-10-17T10:06:00Z',
    updatedAt: '2026-10-17T10:06:00Z',
    ...overrides,
  };
}
