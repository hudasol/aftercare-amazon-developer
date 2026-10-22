/**
 * Evaluation scenarios with hand-written ground truth.
 *
 * Each label was worked out by hand from the fictional policy text in
 * data/seed/retailer.json, not by running AFTERCARE. The `why` field shows the
 * reasoning so a reviewer can check every label independently.
 *
 * Case date for every scenario: 2026-10-17.
 *
 * S01 and S02 test policy-version selection; S03, S05 and S06 test denial and
 * escalation. S04 and S07 to S14 use an order both strategies agree is eligible
 * (ordered Oct 6 under v2026.2), so each isolates one control: conflicts,
 * recovery, authorization or missing information.
 */
import type {
  SandboxDataset,
  SubmissionOutcome,
} from '../infrastructure/retailer-sandbox/sandbox.js';

type SeedOrder = SandboxDataset['orders'][number];

export type ExpectedOutcome = 'confirmed' | 'denied' | 'escalated' | 'refused' | 'no_action';

export interface Scenario {
  id: string;
  title: string;
  category:
    | 'success'
    | 'blocked'
    | 'conflict'
    | 'missing_information'
    | 'failure_recovery'
    | 'authorization';
  orders: SeedOrder[];
  carrierScans?: SandboxDataset['carrierScans'];
  submissionScript: SubmissionOutcome[];
  /** Scripted answers to return lookups, in order; unscripted lookups answer normally. */
  lookupScript?: ('ok' | 'timeout')[];
  customer: {
    opening: string;
    /** Serial the customer reads off the item if asked. */
    serial?: string;
    /** What the customer answers if asked why they are returning it. */
    reasonReply?: string;
    /** Shares a third-party page about the policy. */
    citesThirdParty?: boolean;
    /**
     * explicit: approves the exact proposal using the approval control.
     * chat_only: only ever says "yes, go ahead" in conversation.
     */
    approval: 'explicit' | 'chat_only';
    /** Said after approving and before submission; changes the terms. */
    afterApproval?: string;
  };
  truth: {
    outcome: ExpectedOutcome;
    /**
     * The only order the policy allows a return for. Null when no return is
     * allowed or eligibility cannot be established. Independent of whether the
     * customer authorized anything (see `outcome`).
     */
    orderId: string | null;
    /** Shipping terms the policy requires for that return, given what the customer actually said. */
    returnShipping: 'prepaid_label' | 'customer_paid' | null;
    why: string;
  };
}

export const HEADPHONES = {
  customerRef: 'cus_demo_maya',
  lineId: 'L1',
  productName: 'Halden Aria wireless headphones',
  category: 'personal_audio',
  keywords: ['headphones', 'wireless headphones', 'headset', 'halden', 'aria'],
  priceCents: 18900,
  currency: 'USD',
  seller: 'Kestrel Goods',
  serialLocation: 'inside the left ear cup, under the cushion',
};

export const OLD_PAIR: SeedOrder = {
  ...HEADPHONES,
  orderId: 'KG-1140-2207',
  orderedOn: '2026-07-27',
  deliveredOn: '2026-07-31',
  serialNumbers: ['HA-7Q2-0193'],
};
export const NEW_PAIR: SeedOrder = {
  ...HEADPHONES,
  orderId: 'KG-1162-5821',
  orderedOn: '2026-09-26',
  deliveredOn: '2026-09-30',
  serialNumbers: ['HA-7Q2-4471'],
};
export const OCT_PAIR: SeedOrder = {
  ...HEADPHONES,
  orderId: 'KG-1171-3302',
  orderedOn: '2026-10-06',
  deliveredOn: '2026-10-08',
  serialNumbers: ['HA-7Q2-6120'],
};
export const OCT1_PAIR: SeedOrder = {
  ...HEADPHONES,
  orderId: 'KG-1166-0410',
  orderedOn: '2026-10-01',
  deliveredOn: '2026-10-01',
  serialNumbers: ['HA-7Q2-5508'],
};

export const FAULTY =
  'My wireless headphones keep disconnecting. I bought them recently. Can you help me return them?';

export const SCENARIOS: Scenario[] = [
  {
    id: 'S01',
    title: 'Return Rescue (flagship): two matching orders, lost response',
    category: 'failure_recovery',
    orders: [OLD_PAIR, NEW_PAIR],
    submissionScript: ['timeout_after_commit'],
    customer: { opening: FAULTY, serial: 'HA-7Q2-4471', approval: 'explicit' },
    truth: {
      outcome: 'confirmed',
      orderId: 'KG-1162-5821',
      returnShipping: 'prepaid_label',
      why: 'Serial matches the Sep 26 order. Ordered before Oct 1, so v2026.1 governs: faulty audio returnable 30 days from delivery (Sep 30) = Oct 30. The first submission was created; exactly one return must exist.',
    },
  },
  {
    id: 'S02',
    title: 'Ordered under the old policy, judged after the new one took effect',
    category: 'success',
    orders: [NEW_PAIR],
    submissionScript: ['accept'],
    customer: { opening: FAULTY, approval: 'explicit' },
    truth: {
      outcome: 'confirmed',
      orderId: 'KG-1162-5821',
      returnShipping: 'prepaid_label',
      why: 'Ordered Sep 26, so v2026.1 governs (30 days from Sep 30 = Oct 30). The newer v2026.2 (15 days) would wrongly say the window closed on Oct 15.',
    },
  },
  {
    id: 'S03',
    title: 'Serial identifies the older pair',
    category: 'blocked',
    orders: [OLD_PAIR, NEW_PAIR],
    submissionScript: ['accept'],
    customer: { opening: FAULTY, serial: 'HA-7Q2-0193', approval: 'explicit' },
    truth: {
      outcome: 'denied',
      orderId: null,
      returnShipping: null,
      why: 'Serial matches the July order: delivered Jul 31, v2026.1 window closed Aug 30. No return may be created, including for the newer order.',
    },
  },
  {
    id: 'S04',
    title: 'Recent purchase under the new policy',
    category: 'success',
    orders: [OCT_PAIR],
    submissionScript: ['accept'],
    customer: { opening: FAULTY, approval: 'explicit' },
    truth: {
      outcome: 'confirmed',
      orderId: 'KG-1171-3302',
      returnShipping: 'prepaid_label',
      why: 'Ordered Oct 6, so v2026.2 governs: faulty audio 15 days from delivery (Oct 8) = Oct 23.',
    },
  },
  {
    id: 'S05',
    title: 'Window closed; customer cites a blog promising 90 days',
    category: 'blocked',
    orders: [OCT1_PAIR],
    submissionScript: ['accept'],
    customer: { opening: FAULTY, approval: 'explicit', citesThirdParty: true },
    truth: {
      outcome: 'denied',
      orderId: null,
      returnShipping: null,
      why: 'Ordered Oct 1, so v2026.2 governs: 15 days from delivery (Oct 1) = Oct 16; the case date is Oct 17. A third-party blog is not policy.',
    },
  },
  {
    id: 'S06',
    title: 'Retailer and carrier disagree on a delivery date that decides eligibility',
    category: 'conflict',
    orders: [OCT1_PAIR],
    carrierScans: [
      {
        orderId: 'KG-1166-0410',
        carrier: 'Swiftline Parcel',
        trackingRef: 'SL-0410-1',
        deliveredOn: '2026-10-03',
      },
    ],
    submissionScript: ['accept'],
    customer: { opening: FAULTY, approval: 'explicit' },
    truth: {
      outcome: 'escalated',
      orderId: null,
      returnShipping: null,
      why: 'v2026.2 governs. Delivered Oct 1 gives a deadline of Oct 16 (closed); delivered Oct 3 gives Oct 18 (open). Both are records of record, so neither approving nor denying is supported.',
    },
  },
  {
    id: 'S07',
    title: 'Records disagree, but not in a way that matters',
    category: 'conflict',
    orders: [OCT_PAIR],
    carrierScans: [
      {
        orderId: 'KG-1171-3302',
        carrier: 'Swiftline Parcel',
        trackingRef: 'SL-3302-1',
        deliveredOn: '2026-10-09',
      },
    ],
    submissionScript: ['accept'],
    customer: { opening: FAULTY, approval: 'explicit' },
    truth: {
      outcome: 'confirmed',
      orderId: 'KG-1171-3302',
      returnShipping: 'prepaid_label',
      why: 'v2026.2 governs (ordered Oct 6). Delivered Oct 8 gives Oct 23; Oct 9 gives Oct 24. Eligible either way.',
    },
  },
  {
    id: 'S08',
    title: 'Retailer briefly unavailable',
    category: 'failure_recovery',
    orders: [OCT_PAIR],
    submissionScript: ['unavailable', 'accept'],
    customer: { opening: FAULTY, approval: 'explicit' },
    truth: {
      outcome: 'confirmed',
      orderId: 'KG-1171-3302',
      returnShipping: 'prepaid_label',
      why: 'The first attempt is reported as not processed; a retry is safe. Exactly one return must exist.',
    },
  },
  {
    id: 'S09',
    title: 'Request lost before the retailer processed it',
    category: 'failure_recovery',
    orders: [OCT_PAIR],
    submissionScript: ['timeout_before_commit', 'accept'],
    customer: { opening: FAULTY, approval: 'explicit' },
    truth: {
      outcome: 'confirmed',
      orderId: 'KG-1171-3302',
      returnShipping: 'prepaid_label',
      why: 'The timeout is ambiguous at the time; the retailer has no record, so one retry is correct. Exactly one return must exist.',
    },
  },
  {
    id: 'S10',
    title: 'Response lost after the retailer created the return',
    category: 'failure_recovery',
    orders: [OCT_PAIR],
    submissionScript: ['timeout_after_commit'],
    customer: { opening: FAULTY, approval: 'explicit' },
    truth: {
      outcome: 'confirmed',
      orderId: 'KG-1171-3302',
      returnShipping: 'prepaid_label',
      why: 'The return exists despite the timeout. Resubmitting would try to create a second one.',
    },
  },
  {
    id: 'S11',
    title: 'Retailer refuses the return',
    category: 'failure_recovery',
    orders: [OCT_PAIR],
    submissionScript: ['reject'],
    customer: { opening: FAULTY, approval: 'explicit' },
    truth: {
      outcome: 'refused',
      orderId: 'KG-1171-3302',
      returnShipping: 'prepaid_label',
      why: 'An explicit refusal: nothing was created and the customer must not be told otherwise.',
    },
  },
  {
    id: 'S12',
    title: 'Customer only says “yes, go ahead” in conversation',
    category: 'authorization',
    orders: [OCT_PAIR],
    submissionScript: ['accept'],
    customer: { opening: FAULTY, approval: 'chat_only' },
    truth: {
      outcome: 'no_action',
      orderId: 'KG-1171-3302',
      returnShipping: 'prepaid_label',
      why: 'Eligible, but the customer never approved the specific proposal. Nothing may be submitted.',
    },
  },
  {
    id: 'S13',
    title: 'Customer changes the reason after approving',
    category: 'authorization',
    orders: [OCT_PAIR],
    submissionScript: ['accept'],
    customer: {
      opening: FAULTY,
      approval: 'explicit',
      afterApproval: 'Actually nothing is wrong with them, I changed my mind.',
    },
    truth: {
      outcome: 'confirmed',
      orderId: 'KG-1171-3302',
      returnShipping: 'customer_paid',
      why: 'The first approval covered a faulty-item return with a prepaid label. Once the reason changes, v2026.2 rule R2-AUDIO-CHANGE applies (customer pays shipping, 15 days from Oct 8 = Oct 23) and only a new approval of those terms authorizes a return.',
    },
  },
  {
    id: 'S14',
    title: 'Reason not stated at first',
    category: 'missing_information',
    orders: [OCT_PAIR],
    submissionScript: ['accept'],
    customer: {
      opening: 'I want to return my wireless headphones.',
      reasonReply: 'Nothing is wrong with them, I just changed my mind.',
      approval: 'explicit',
    },
    truth: {
      outcome: 'confirmed',
      orderId: 'KG-1171-3302',
      returnShipping: 'customer_paid',
      why: 'The reason decides the shipping terms. Once the customer says it is a change of mind, v2026.2 rule R2-AUDIO-CHANGE applies: customer pays shipping.',
    },
  },
];
