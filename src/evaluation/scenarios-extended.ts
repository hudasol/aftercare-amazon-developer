/**
 * Extended evaluation scenarios, S15 onwards, with hand-written ground truth.
 *
 * Written after the first 14, to cover cases they did not: window boundaries,
 * the day the policy changed, an unusual serial format, a change of mind stated
 * up front, repeated lookup failures, and a second eligible order. Each label
 * was worked out by hand from the fictional policy text in
 * data/seed/retailer.json, before any strategy was run on these scenarios.
 *
 * Case date for every scenario: 2026-10-17.
 */
import {
  FAULTY,
  HEADPHONES,
  NEW_PAIR,
  OCT_PAIR,
  OCT1_PAIR,
  OLD_PAIR,
  type Scenario,
} from './scenarios.js';

const POUR_OVER = {
  customerRef: 'cus_demo_maya',
  lineId: 'L1',
  productName: 'Fernway ceramic pour-over set',
  category: 'kitchen',
  keywords: ['pour-over', 'coffee', 'kettle', 'fernway'],
  priceCents: 4400,
  currency: 'USD',
  seller: 'Kestrel Goods',
  serialNumbers: [],
  serialLocation: null,
};

const DAMAGED_POUR_OVER = 'My pour-over set arrived damaged. I would like to return it.';

export const EXTENDED_SCENARIOS: Scenario[] = [
  {
    id: 'S15',
    title: 'Kitchen item on the last day of its window',
    category: 'success',
    orders: [
      { ...POUR_OVER, orderId: 'KG-1155-0917', orderedOn: '2026-09-15', deliveredOn: '2026-09-17' },
    ],
    submissionScript: ['accept'],
    customer: { opening: DAMAGED_POUR_OVER, approval: 'explicit' },
    truth: {
      outcome: 'confirmed',
      orderId: 'KG-1155-0917',
      returnShipping: 'prepaid_label',
      why: 'Ordered Sep 15, so v2026.1 governs. R3-HOME: kitchen items within 30 days of delivery. Delivered Sep 17 + 30 days = Oct 17, which is the case date, so the return is still within the window. R3-HOME uses a prepaid label.',
    },
  },
  {
    id: 'S16',
    title: 'Kitchen item one day after its window closed',
    category: 'blocked',
    orders: [
      { ...POUR_OVER, orderId: 'KG-1154-0916', orderedOn: '2026-09-14', deliveredOn: '2026-09-16' },
    ],
    submissionScript: ['accept'],
    customer: { opening: DAMAGED_POUR_OVER, approval: 'explicit' },
    truth: {
      outcome: 'denied',
      orderId: null,
      returnShipping: null,
      why: 'Ordered Sep 14, so v2026.1 governs. R3-HOME: 30 days from delivery. Delivered Sep 16 + 30 days = Oct 16; the case date Oct 17 is one day later. No return may be created.',
    },
  },
  {
    id: 'S17',
    title: 'Ordered on the day the new policy took effect',
    category: 'blocked',
    orders: [OCT1_PAIR],
    submissionScript: ['accept'],
    customer: { opening: FAULTY, approval: 'explicit' },
    truth: {
      outcome: 'denied',
      orderId: null,
      returnShipping: null,
      why: 'v2026.2 applies to orders placed on or after Oct 1, and this order was placed on Oct 1. R1-AUDIO-FAULT: 15 days from delivery. Delivered Oct 1 + 15 days = Oct 16, before the case date Oct 17. Treating it as a v2026.1 order would wrongly give Oct 31.',
    },
  },
  {
    id: 'S18',
    title: 'Ordered the day before the policy changed, delivered after',
    category: 'success',
    orders: [
      {
        ...HEADPHONES,
        orderId: 'KG-1165-0930',
        orderedOn: '2026-09-30',
        deliveredOn: '2026-10-01',
        serialNumbers: ['HA-7Q2-5390'],
      },
    ],
    submissionScript: ['accept'],
    customer: { opening: FAULTY, approval: 'explicit' },
    truth: {
      outcome: 'confirmed',
      orderId: 'KG-1165-0930',
      returnShipping: 'prepaid_label',
      why: 'v2026.1 applies to orders placed through Sep 30, including returns requested later. R1-ELEC-FAULT: 30 days from delivery. Delivered Oct 1 + 30 days = Oct 31, after the case date. Applying v2026.2 would wrongly give Oct 16.',
    },
  },
  {
    id: 'S19',
    title: 'Serial read out in lowercase without hyphens',
    category: 'missing_information',
    orders: [OLD_PAIR, NEW_PAIR],
    submissionScript: ['accept'],
    customer: { opening: FAULTY, serial: 'ha7q24471', approval: 'explicit' },
    truth: {
      outcome: 'confirmed',
      orderId: 'KG-1162-5821',
      returnShipping: 'prepaid_label',
      why: 'The serial ha7q24471 is HA-7Q2-4471 written differently, which matches the Sep 26 order. Ordered before Oct 1, so v2026.1 governs: R1-ELEC-FAULT, 30 days from delivery (Sep 30) = Oct 30.',
    },
  },
  {
    id: 'S20',
    title: 'Change of mind stated in the first message',
    category: 'success',
    orders: [OCT_PAIR],
    submissionScript: ['accept'],
    customer: {
      opening:
        'Nothing is wrong with my wireless headphones, I just changed my mind. Can I return them?',
      approval: 'explicit',
    },
    truth: {
      outcome: 'confirmed',
      orderId: 'KG-1171-3302',
      returnShipping: 'customer_paid',
      why: 'Ordered Oct 6, so v2026.2 governs. R2-AUDIO-CHANGE: unwanted headphones within 15 days of delivery, customer pays return shipping. Delivered Oct 8 + 15 days = Oct 23.',
    },
  },
  {
    id: 'S21',
    title: 'Return lookup times out twice after a lost response',
    category: 'failure_recovery',
    orders: [OCT_PAIR],
    submissionScript: ['timeout_after_commit'],
    lookupScript: ['timeout', 'timeout'],
    customer: { opening: FAULTY, approval: 'explicit' },
    truth: {
      outcome: 'confirmed',
      orderId: 'KG-1171-3302',
      returnShipping: 'prepaid_label',
      why: 'Ordered Oct 6, so v2026.2 governs: R1-AUDIO-FAULT, 15 days from delivery (Oct 8) = Oct 23. The first submission created the return; the next two reads of the retailer fail. Exactly one return must exist.',
    },
  },
  {
    id: 'S22',
    title: 'A second eligible order the customer did not mention',
    category: 'missing_information',
    orders: [NEW_PAIR, OCT_PAIR],
    submissionScript: ['accept'],
    customer: { opening: FAULTY, serial: 'HA-7Q2-4471', approval: 'explicit' },
    truth: {
      outcome: 'confirmed',
      orderId: 'KG-1162-5821',
      returnShipping: 'prepaid_label',
      why: 'Both orders are returnable: Sep 26 order under v2026.1, 30 days from Sep 30 = Oct 30; Oct 6 order under v2026.2, 15 days from Oct 8 = Oct 23. Eligibility does not say which pair the customer has; the serial HA-7Q2-4471 identifies the Sep 26 order.',
    },
  },
];
