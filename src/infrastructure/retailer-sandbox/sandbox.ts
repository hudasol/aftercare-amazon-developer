/**
 * Kestrel Goods retailer sandbox (fictional, simulated).
 *
 * Behaves like an external retailer behind a network boundary: it keeps its
 * own records, honours idempotency keys, refuses a second open return for the
 * same order line, and can be scripted to refuse, fail, or time out. A timeout
 * can happen after the return was created ("timeout_after_commit"), which is
 * exactly the ambiguous case AFTERCARE must reconcile rather than retry.
 *
 * Nothing here contacts a real retailer, carrier or payment system.
 */
import type { SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { normalizeSerial } from '../../domain/compiler.js';
import {
  PolicyDocumentSchema,
  type PolicyDocument,
  type ReturnReason,
} from '../../domain/policy.js';
import {
  GatewayTimeoutError,
  type CarrierScan,
  type Clock,
  type RetailerGateway,
  type RetailerOrder,
  type RetailerReturn,
  type ReturnRequest,
  type SubmissionResult,
} from '../../application/ports.js';
import type { Database } from '../sqlite/database.js';

export const SubmissionOutcomeSchema = z.enum([
  'accept',
  'reject',
  'unavailable',
  'timeout_after_commit',
  'timeout_before_commit',
]);
export type SubmissionOutcome = z.infer<typeof SubmissionOutcomeSchema>;

export const LookupOutcomeSchema = z.enum(['ok', 'timeout']);

export const SandboxDatasetSchema = z.object({
  retailer: z.object({ id: z.string(), name: z.string(), policyId: z.string() }),
  caseDate: z.string(),
  orders: z.array(
    z.object({
      orderId: z.string(),
      customerRef: z.string(),
      lineId: z.string(),
      productName: z.string(),
      category: z.string(),
      keywords: z.array(z.string()),
      priceCents: z.number().int().positive(),
      currency: z.string(),
      seller: z.string(),
      orderedOn: z.string(),
      deliveredOn: z.string(),
      serialNumbers: z.array(z.string()),
      serialLocation: z.string().nullable(),
      openReturn: z.string().nullable().optional(),
    }),
  ),
  carrierScans: z.array(
    z.object({
      orderId: z.string(),
      carrier: z.string(),
      trackingRef: z.string(),
      deliveredOn: z.string(),
    }),
  ),
  policies: z.array(PolicyDocumentSchema),
  submissionScript: z.array(
    z.object({ outcome: SubmissionOutcomeSchema, note: z.string().optional() }),
  ),
  readsBeforeAuthorized: z.number().int().nonnegative(),
});
export type SandboxDataset = z.infer<typeof SandboxDatasetSchema>;

export interface SandboxOptions {
  clock: Clock;
  /** Simulated network latency for every call. */
  latencyMs?: number;
  /** How long a timed-out call waits before giving up. */
  timeoutMs?: number;
}

type Row = Record<string, SQLInputValue>;

const STOPWORDS = new Set([
  'my',
  'the',
  'a',
  'an',
  'pair',
  'of',
  'new',
  'some',
  'these',
  'those',
  'them',
]);

function stem(word: string): string {
  return word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map(stem);
}

export class RetailerSandbox implements RetailerGateway {
  readonly name = 'Kestrel Goods';
  readonly simulated = true;
  private readonly latencyMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly db: Database,
    private readonly options: SandboxOptions,
  ) {
    this.latencyMs = options.latencyMs ?? 0;
    this.timeoutMs = options.timeoutMs ?? 0;
  }

  // ---- seeding and demo controls ------------------------------------------
  /** Replace all sandbox records with the dataset. Touches sim_* tables only. */
  seed(dataset: SandboxDataset): void {
    const data = SandboxDatasetSchema.parse(dataset);
    this.db.transaction(() => {
      for (const table of [
        'sim_request_log',
        'sim_outcome_queue',
        'sim_returns',
        'sim_carrier_scans',
        'sim_orders',
        'sim_policies',
        'sim_settings',
      ]) {
        this.db.sql.exec(`DELETE FROM ${table}`);
      }
      const insertOrder = this.db.sql.prepare(
        `INSERT INTO sim_orders (order_id, customer_ref, line_id, product_name, category, keywords_json, price_cents,
           currency, seller, ordered_on, delivered_on, serial_numbers_json, serial_location, open_return)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const o of data.orders) {
        insertOrder.run(
          o.orderId,
          o.customerRef,
          o.lineId,
          o.productName,
          o.category,
          JSON.stringify(o.keywords),
          o.priceCents,
          o.currency,
          o.seller,
          o.orderedOn,
          o.deliveredOn,
          JSON.stringify(o.serialNumbers),
          o.serialLocation,
          o.openReturn ?? null,
        );
      }
      for (const s of data.carrierScans) this.addCarrierScan(s);
      const insertPolicy = this.db.sql.prepare(
        'INSERT INTO sim_policies (policy_id, version, body_json) VALUES (?, ?, ?)',
      );
      for (const p of data.policies) insertPolicy.run(p.policyId, p.version, JSON.stringify(p));
      for (const step of data.submissionScript)
        this.queueOutcome('create_return', step.outcome, step.note ?? null);
      this.setSetting('reads_before_authorized', String(data.readsBeforeAuthorized));
      this.setSetting('next_rma', '30417');
    });
  }

  addCarrierScan(scan: CarrierScan): void {
    this.db.sql
      .prepare(
        'INSERT INTO sim_carrier_scans (order_id, carrier, tracking_ref, delivered_on) VALUES (?, ?, ?, ?)',
      )
      .run(scan.orderId, scan.carrier, scan.trackingRef, scan.deliveredOn);
  }

  queueOutcome(operation: 'create_return' | 'lookup', outcome: string, note: string | null): void {
    this.db.sql
      .prepare('INSERT INTO sim_outcome_queue (operation, outcome, note) VALUES (?, ?, ?)')
      .run(operation, outcome, note);
  }

  clearQueue(): void {
    this.db.sql.exec('DELETE FROM sim_outcome_queue');
  }

  listQueue(): { operation: string; outcome: string; note: string | null }[] {
    return (
      this.db.sql
        .prepare('SELECT operation, outcome, note FROM sim_outcome_queue ORDER BY id')
        .all() as Row[]
    ).map((r) => ({
      operation: String(r['operation']),
      outcome: String(r['outcome']),
      note: r['note'] === null ? null : String(r['note']),
    }));
  }

  requestLog(): {
    at: string;
    operation: string;
    requestKey: string | null;
    outcome: string;
    detail: string | null;
  }[] {
    return (this.db.sql.prepare('SELECT * FROM sim_request_log ORDER BY id').all() as Row[]).map(
      (r) => ({
        at: String(r['at']),
        operation: String(r['operation']),
        requestKey: r['request_key'] === null ? null : String(r['request_key']),
        outcome: String(r['outcome']),
        detail: r['detail'] === null ? null : String(r['detail']),
      }),
    );
  }

  /** Every return the retailer holds (for the Lab's "retailer truth" view and for evaluation). */
  listReturns(): RetailerReturn[] {
    return (
      this.db.sql.prepare('SELECT * FROM sim_returns ORDER BY created_at, rowid').all() as Row[]
    ).map((r) => this.toReturn(r));
  }

  private setSetting(key: string, value: string): void {
    this.db.sql
      .prepare(
        'INSERT INTO sim_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  private setting(key: string, fallback: string): string {
    const row = this.db.sql.prepare('SELECT value FROM sim_settings WHERE key = ?').get(key) as
      Row | undefined;
    return row ? String(row['value']) : fallback;
  }

  private nextOutcome(
    operation: 'create_return' | 'lookup',
  ): { outcome: string; note: string | null } | null {
    const row = this.db.sql
      .prepare(
        'SELECT id, outcome, note FROM sim_outcome_queue WHERE operation = ? ORDER BY id LIMIT 1',
      )
      .get(operation) as Row | undefined;
    if (!row) return null;
    this.db.sql.prepare('DELETE FROM sim_outcome_queue WHERE id = ?').run(row['id'] as number);
    return {
      outcome: String(row['outcome']),
      note: row['note'] === null ? null : String(row['note']),
    };
  }

  private log(
    operation: string,
    requestKey: string | null,
    outcome: string,
    detail: string | null,
  ): void {
    this.db.sql
      .prepare(
        'INSERT INTO sim_request_log (at, operation, request_key, outcome, detail) VALUES (?, ?, ?, ?, ?)',
      )
      .run(this.options.clock.now(), operation, requestKey, outcome, detail);
  }

  private async wait(ms: number): Promise<void> {
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---- reads ----------------------------------------------------------------
  private toOrder(r: Row): RetailerOrder {
    return {
      orderId: String(r['order_id']),
      customerRef: String(r['customer_ref']),
      lineId: String(r['line_id']),
      productName: String(r['product_name']),
      category: String(r['category']),
      priceCents: Number(r['price_cents']),
      currency: String(r['currency']),
      seller: String(r['seller']),
      orderedOn: String(r['ordered_on']),
      deliveredOn: String(r['delivered_on']),
      serialNumbers: JSON.parse(String(r['serial_numbers_json'])) as string[],
      serialLocation: r['serial_location'] === null ? null : String(r['serial_location']),
      openReturn: r['open_return'] === null ? null : String(r['open_return']),
    };
  }

  private ordersFor(customerRef: string): Row[] {
    return this.db.sql
      .prepare('SELECT * FROM sim_orders WHERE customer_ref = ? ORDER BY ordered_on DESC')
      .all(customerRef) as Row[];
  }

  async searchOrders(customerRef: string, productQuery: string | null): Promise<RetailerOrder[]> {
    await this.wait(this.latencyMs);
    const rows = this.ordersFor(customerRef);
    const wanted = productQuery ? tokens(productQuery) : [];
    const matches = rows.filter((row) => {
      if (wanted.length === 0) return true;
      const haystack = new Set([
        ...tokens(String(row['product_name'])),
        ...(JSON.parse(String(row['keywords_json'])) as string[]).flatMap(tokens),
      ]);
      return wanted.some((t) => haystack.has(t));
    });
    this.log(
      'search_orders',
      null,
      'ok',
      `${matches.length} match(es) for "${productQuery ?? ''}"`,
    );
    return matches.map((r) => this.toOrder(r));
  }

  async getOrder(customerRef: string, orderId: string): Promise<RetailerOrder | null> {
    await this.wait(this.latencyMs);
    const row = this.db.sql
      .prepare('SELECT * FROM sim_orders WHERE customer_ref = ? AND upper(order_id) = upper(?)')
      .get(customerRef, orderId) as Row | undefined;
    return row ? this.toOrder(row) : null;
  }

  async findOrderBySerial(customerRef: string, serial: string): Promise<RetailerOrder | null> {
    await this.wait(this.latencyMs);
    const wanted = normalizeSerial(serial);
    const match = this.ordersFor(customerRef).find((row) =>
      (JSON.parse(String(row['serial_numbers_json'])) as string[]).some(
        (s) => normalizeSerial(s) === wanted,
      ),
    );
    this.log('find_order_by_serial', null, match ? 'match' : 'no_match', serial);
    return match ? this.toOrder(match) : null;
  }

  async getCarrierScans(orderIds: string[]): Promise<CarrierScan[]> {
    await this.wait(this.latencyMs);
    if (orderIds.length === 0) return [];
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM sim_carrier_scans WHERE order_id IN (${orderIds.map(() => '?').join(',')}) ORDER BY id`,
      )
      .all(...orderIds) as Row[];
    return rows.map((r) => ({
      orderId: String(r['order_id']),
      carrier: String(r['carrier']),
      trackingRef: String(r['tracking_ref']),
      deliveredOn: String(r['delivered_on']),
    }));
  }

  async listPolicyVersions(): Promise<PolicyDocument[]> {
    await this.wait(this.latencyMs);
    const rows = this.db.sql
      .prepare('SELECT body_json FROM sim_policies ORDER BY version')
      .all() as Row[];
    return rows.map((r) => PolicyDocumentSchema.parse(JSON.parse(String(r['body_json']))));
  }

  // ---- returns ----------------------------------------------------------------
  private toReturn(r: Row): RetailerReturn {
    return {
      rmaId: String(r['rma_id']),
      orderId: String(r['order_id']),
      lineId: String(r['line_id']),
      reason: String(r['reason']) as ReturnReason,
      status: String(r['status']) as RetailerReturn['status'],
      refundAmountCents: Number(r['refund_amount_cents']),
      currency: String(r['currency']),
      returnShipping: String(r['return_shipping']) as RetailerReturn['returnShipping'],
      labelUrl: r['label_url'] === null ? null : String(r['label_url']),
      idempotencyKey: String(r['idempotency_key']),
      createdAt: String(r['created_at']),
      refusalReason: r['refusal_reason'] === null ? null : String(r['refusal_reason']),
    };
  }

  private returnByKey(key: string): Row | undefined {
    return this.db.sql.prepare('SELECT * FROM sim_returns WHERE idempotency_key = ?').get(key) as
      Row | undefined;
  }

  private commitReturn(
    request: ReturnRequest,
  ): { rma: RetailerReturn; created: boolean } | { refusal: string } {
    return this.db.transaction(() => {
      const existing = this.returnByKey(request.idempotencyKey);
      if (existing) return { rma: this.toReturn(existing), created: false };
      const order = this.db.sql
        .prepare('SELECT * FROM sim_orders WHERE order_id = ? AND customer_ref = ?')
        .get(request.orderId, request.customerRef) as Row | undefined;
      if (!order) return { refusal: 'No such order for this customer.' };
      if (order['open_return'] !== null)
        return { refusal: `A return is already on file (${String(order['open_return'])}).` };
      const open = this.db.sql
        .prepare(
          `SELECT rma_id FROM sim_returns WHERE order_id = ? AND line_id = ? AND status != 'refused'`,
        )
        .get(request.orderId, request.lineId) as Row | undefined;
      if (open)
        return { refusal: `A return is already open for this item (${String(open['rma_id'])}).` };
      if (request.refundAmountCents > Number(order['price_cents'])) {
        return { refusal: 'Refund amount exceeds the price paid.' };
      }
      const next = Number(this.setting('next_rma', '30417'));
      this.setSetting('next_rma', String(next + 1));
      const rmaId = `KG-RMA-${next}`;
      this.db.sql
        .prepare(
          `INSERT INTO sim_returns (rma_id, idempotency_key, customer_ref, order_id, line_id, reason, status,
             refund_amount_cents, currency, return_shipping, label_url, refusal_reason, reads, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, NULL, NULL, 0, ?)`,
        )
        .run(
          rmaId,
          request.idempotencyKey,
          request.customerRef,
          request.orderId,
          request.lineId,
          request.reason,
          request.refundAmountCents,
          request.currency,
          request.returnShipping,
          this.options.clock.now(),
        );
      return { rma: this.toReturn(this.returnByKey(request.idempotencyKey) as Row), created: true };
    });
  }

  async createReturn(request: ReturnRequest): Promise<SubmissionResult> {
    const scripted = this.nextOutcome('create_return');
    const outcome = (scripted?.outcome ?? 'accept') as SubmissionOutcome;
    await this.wait(this.latencyMs);

    if (outcome === 'unavailable') {
      this.log(
        'create_return',
        request.idempotencyKey,
        'unavailable',
        'Service unavailable; request not processed.',
      );
      return {
        kind: 'unavailable',
        message: 'Returns service temporarily unavailable. The request was not processed.',
      };
    }
    if (outcome === 'timeout_before_commit') {
      this.log(
        'create_return',
        request.idempotencyKey,
        'timeout_before_commit',
        'Request lost before processing.',
      );
      await this.wait(this.timeoutMs);
      throw new GatewayTimeoutError('create_return');
    }
    if (outcome === 'reject') {
      const reason = scripted?.note ?? 'Return refused by retailer.';
      this.log('create_return', request.idempotencyKey, 'rejected', reason);
      return { kind: 'rejected', reason };
    }

    const committed = this.commitReturn(request);
    if ('refusal' in committed) {
      this.log('create_return', request.idempotencyKey, 'rejected', committed.refusal);
      return { kind: 'rejected', reason: committed.refusal };
    }
    if (outcome === 'timeout_after_commit') {
      this.log(
        'create_return',
        request.idempotencyKey,
        'timeout_after_commit',
        `Created ${committed.rma.rmaId}; response lost.`,
      );
      await this.wait(this.timeoutMs);
      throw new GatewayTimeoutError('create_return');
    }
    this.log(
      'create_return',
      request.idempotencyKey,
      committed.created ? 'created' : 'replayed',
      committed.rma.rmaId,
    );
    return { kind: 'accepted', rma: committed.rma };
  }

  /** Reading a processing return advances it to authorized after the configured number of reads. */
  private read(row: Row | undefined, key: string): RetailerReturn | null {
    if (!row) return null;
    const threshold = Number(this.setting('reads_before_authorized', '1'));
    const rmaId = String(row['rma_id']);
    this.db.transaction(() => {
      if (row['status'] === 'processing' && Number(row['reads']) >= threshold) {
        const label =
          row['return_shipping'] === 'prepaid_label'
            ? `demo://kestrel-goods/labels/${rmaId}.pdf`
            : null;
        this.db.sql
          .prepare(`UPDATE sim_returns SET status = 'authorized', label_url = ? WHERE rma_id = ?`)
          .run(label, rmaId);
      }
      this.db.sql.prepare('UPDATE sim_returns SET reads = reads + 1 WHERE rma_id = ?').run(rmaId);
    });
    const fresh = this.db.sql
      .prepare('SELECT * FROM sim_returns WHERE rma_id = ?')
      .get(rmaId) as Row;
    this.log('read_return', key, String(fresh['status']), rmaId);
    return this.toReturn(fresh);
  }

  private async lookupGuard(operation: string, key: string): Promise<void> {
    const scripted = this.nextOutcome('lookup');
    await this.wait(this.latencyMs);
    if (scripted?.outcome === 'timeout') {
      this.log(operation, key, 'timeout', null);
      await this.wait(this.timeoutMs);
      throw new GatewayTimeoutError(operation);
    }
  }

  async getReturn(rmaId: string): Promise<RetailerReturn | null> {
    await this.lookupGuard('get_return', rmaId);
    const row = this.db.sql.prepare('SELECT * FROM sim_returns WHERE rma_id = ?').get(rmaId) as
      Row | undefined;
    return this.read(row, rmaId);
  }

  async findReturnByIdempotencyKey(key: string): Promise<RetailerReturn | null> {
    await this.lookupGuard('find_return_by_key', key);
    const row = this.returnByKey(key);
    if (!row) this.log('find_return_by_key', key, 'not_found', null);
    return this.read(row, key);
  }
}
