/**
 * Converts what the application observed (retailer records, customer words)
 * into evidence items with explicit provenance.
 */
import type { Evidence, Fact } from '../domain/evidence.js';
import type { PolicyDocument } from '../domain/policy.js';
import type { CarrierScan, Interpretation, RetailerOrder } from './ports.js';

export interface EvidenceMeta {
  id: string;
  caseId: string;
  observedAt: string;
}

const base = (meta: EvidenceMeta) => ({
  id: meta.id,
  caseId: meta.caseId,
  observedAt: meta.observedAt,
  status: 'active' as const,
  policy: null,
  note: null,
});

export function orderEvidence(
  meta: EvidenceMeta,
  order: RetailerOrder,
  retailerName: string,
  simulated: boolean,
): Evidence {
  const subject = `order:${order.orderId}`;
  const fact = (attribute: string, value: Fact['value']): Fact => ({ subject, attribute, value });
  return {
    ...base(meta),
    kind: 'order_record',
    title: `Order ${order.orderId} · ${order.productName}`,
    source: {
      type: 'retailer_record',
      name: `${retailerName} order system`,
      reference: order.orderId,
    },
    simulated,
    verification: 'verified',
    facts: [
      fact('lineId', order.lineId),
      fact('productName', order.productName),
      fact('category', order.category),
      fact('priceCents', order.priceCents),
      fact('currency', order.currency),
      fact('seller', order.seller),
      fact('orderedOn', order.orderedOn),
      fact('deliveredOn', order.deliveredOn),
      fact('serialNumbers', order.serialNumbers),
      fact('serialLocation', order.serialLocation),
      fact('openReturn', order.openReturn),
    ],
  };
}

export function orderSearchEvidence(
  meta: EvidenceMeta,
  query: string | null,
  orderIds: string[],
  retailerName: string,
  simulated: boolean,
): Evidence {
  return {
    ...base(meta),
    kind: 'order_search',
    title: `Order search: “${query ?? 'all recent orders'}”`,
    source: { type: 'retailer_record', name: `${retailerName} order system`, reference: null },
    simulated,
    verification: 'verified',
    facts: [
      { subject: 'lookup:orders', attribute: 'query', value: query },
      { subject: 'lookup:orders', attribute: 'resultCount', value: orderIds.length },
    ],
  };
}

export function carrierScanEvidence(
  meta: EvidenceMeta,
  scan: CarrierScan,
  simulated: boolean,
): Evidence {
  return {
    ...base(meta),
    kind: 'carrier_scan',
    title: `${scan.carrier} delivery scan · ${scan.trackingRef}`,
    source: {
      type: 'carrier_record',
      name: `${scan.carrier} tracking`,
      reference: scan.trackingRef,
    },
    simulated,
    verification: 'verified',
    facts: [
      { subject: `order:${scan.orderId}`, attribute: 'deliveredOn', value: scan.deliveredOn },
    ],
  };
}

export function policyEvidence(
  meta: EvidenceMeta,
  policy: PolicyDocument,
  simulated: boolean,
): Evidence {
  return {
    ...base(meta),
    kind: 'policy_document',
    title: `${policy.title} v${policy.version}`,
    source: {
      type: 'policy_document',
      name: `${policy.publisher} policy repository`,
      reference: policy.reference,
    },
    simulated,
    verification: 'verified',
    facts: [],
    policy,
    note: `Effective ${policy.effectiveFrom} to ${policy.effectiveTo ?? 'present'}.`,
  };
}

/** Facts the customer asserted in one message. Returns null if the message asserted none. */
export function customerStatementEvidence(
  meta: EvidenceMeta,
  utterance: string,
  interpretation: Interpretation,
  interpreterId: string,
): Evidence | null {
  const facts: Fact[] = [];
  const add = (attribute: string, value: string | null) => {
    if (value !== null) facts.push({ subject: 'case', attribute, value });
  };
  add('goal', interpretation.goal);
  add('reason', interpretation.reason);
  add('issueDescription', interpretation.issueDescription);
  add('purchaseTimeHint', interpretation.purchaseTimeHint);
  add('productQuery', interpretation.productQuery);
  if (facts.length === 0) return null;
  return {
    ...base(meta),
    kind: 'customer_statement',
    title: `Customer said: “${truncate(utterance, 90)}”`,
    source: { type: 'customer_statement', name: 'Customer', reference: null },
    simulated: false,
    verification: 'unverified',
    facts,
    note: `Interpreted by ${interpreterId}.`,
  };
}

export function serialEvidence(
  meta: EvidenceMeta,
  serial: string,
  match: RetailerOrder | null,
  retailerName: string,
): Evidence {
  return {
    ...base(meta),
    kind: 'item_serial',
    title: `Serial number from customer: ${serial}`,
    source: { type: 'customer_identifier', name: 'Customer (serial on the item)', reference: null },
    simulated: false,
    verification: match ? 'verified' : 'failed',
    // Kept as the customer gave it (upper-cased); matching normalizes separately.
    facts: [{ subject: 'item', attribute: 'serialNumber', value: serial.trim().toUpperCase() }],
    note: match
      ? `Matches a unit shipped on order ${match.orderId} (checked against ${retailerName} shipment records).`
      : `Does not match any unit shipped to this customer (checked against ${retailerName} shipment records).`,
  };
}

export function thirdPartyClaimEvidence(
  meta: EvidenceMeta,
  claim: { sourceName: string; url: string; policyId: string; windowDays: number; excerpt: string },
): Evidence {
  return {
    ...base(meta),
    kind: 'third_party_claim',
    title: `${claim.sourceName}: “${truncate(claim.excerpt, 80)}”`,
    source: { type: 'third_party', name: claim.sourceName, reference: claim.url },
    simulated: true,
    verification: 'unverified',
    facts: [
      { subject: `policy:${claim.policyId}`, attribute: 'windowDays', value: claim.windowDays },
    ],
  };
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
