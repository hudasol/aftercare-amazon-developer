/**
 * Ports: the interfaces the application layer depends on. Infrastructure
 * provides the implementations (SQLite store, retailer sandbox, interpreter).
 */
import type { PolicyDocument, ReturnReason } from '../domain/policy.js';

/** An order line as the retailer's order system reports it. */
export interface RetailerOrder {
  orderId: string;
  customerRef: string;
  lineId: string;
  productName: string;
  category: string;
  priceCents: number;
  currency: string;
  seller: string;
  orderedOn: string;
  deliveredOn: string;
  serialNumbers: string[];
  serialLocation: string | null;
  /** Reference of a return already on file at the retailer for this line, if any. */
  openReturn: string | null;
}

export interface CarrierScan {
  orderId: string;
  carrier: string;
  trackingRef: string;
  deliveredOn: string;
}

export type ReturnStatus = 'processing' | 'authorized' | 'refused';

export interface RetailerReturn {
  rmaId: string;
  orderId: string;
  lineId: string;
  reason: ReturnReason;
  status: ReturnStatus;
  refundAmountCents: number;
  currency: string;
  returnShipping: 'prepaid_label' | 'customer_paid';
  labelUrl: string | null;
  idempotencyKey: string;
  createdAt: string;
  refusalReason: string | null;
}

export interface ReturnRequest {
  idempotencyKey: string;
  customerRef: string;
  orderId: string;
  lineId: string;
  reason: ReturnReason;
  refundAmountCents: number;
  currency: string;
  returnShipping: 'prepaid_label' | 'customer_paid';
}

/**
 * Result of a submission as reported by the retailer. A timeout is not a
 * result: the gateway throws GatewayTimeoutError and the caller must treat
 * the outcome as unknown.
 */
export type SubmissionResult =
  | { kind: 'accepted'; rma: RetailerReturn }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unavailable'; message: string };

export class GatewayTimeoutError extends Error {
  constructor(operation: string) {
    super(`The retailer did not answer ${operation} in time.`);
    this.name = 'GatewayTimeoutError';
  }
}

export interface RetailerGateway {
  readonly name: string;
  readonly simulated: boolean;
  searchOrders(customerRef: string, productQuery: string | null): Promise<RetailerOrder[]>;
  getOrder(customerRef: string, orderId: string): Promise<RetailerOrder | null>;
  findOrderBySerial(customerRef: string, serial: string): Promise<RetailerOrder | null>;
  getCarrierScans(orderIds: string[]): Promise<CarrierScan[]>;
  listPolicyVersions(): Promise<PolicyDocument[]>;
  createReturn(request: ReturnRequest): Promise<SubmissionResult>;
  getReturn(rmaId: string): Promise<RetailerReturn | null>;
  findReturnByIdempotencyKey(key: string): Promise<RetailerReturn | null>;
}

export interface Interpretation {
  goal: 'return' | 'exchange' | null;
  productQuery: string | null;
  reason: ReturnReason | null;
  issueDescription: string | null;
  purchaseTimeHint: string | null;
  serialNumber: string | null;
  orderNumber: string | null;
  /** The message sounds like agreement. Recorded, but never treated as approval. */
  soundsLikeApproval: boolean;
  wantsToCancel: boolean;
}

export interface Interpreter {
  /** Identifies the implementation in events, e.g. "rules@1". */
  readonly id: string;
  interpret(utterance: string): Promise<Interpretation>;
}

export interface Clock {
  /** Wall-clock instant for event timestamps. */
  now(): string;
}

export type IdGenerator = (prefix: string) => string;

/**
 * Demo-only controls of a simulated retailer. A real retailer integration
 * would not implement this; the Lab and the evaluation harness use it to
 * script outcomes and to show what the retailer actually recorded.
 */
export interface SandboxControls {
  queueOutcome(operation: 'create_return' | 'lookup', outcome: string, note: string | null): void;
  clearQueue(): void;
  listQueue(): { operation: string; outcome: string; note: string | null }[];
  requestLog(): {
    at: string;
    operation: string;
    requestKey: string | null;
    outcome: string;
    detail: string | null;
  }[];
  listReturns(): RetailerReturn[];
  addCarrierScan(scan: CarrierScan): void;
}
