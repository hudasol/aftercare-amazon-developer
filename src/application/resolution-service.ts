/**
 * Application orchestration. Every interface (HTTP API, MCP tools, the Lab,
 * the evaluation harness) goes through these use cases, so the rules applied
 * are always the same.
 *
 * The service coordinates; it does not decide. Decisions come from the
 * Resolution Compiler; this layer performs the retrievals and operations the
 * compiler calls for, records them with provenance, and moves the case only
 * through legal transitions.
 */
import {
  BLOCKING_OPERATION_STATUSES,
  MAX_SUBMISSION_ATTEMPTS,
  type Operation,
  type Proposal,
} from '../domain/actions.js';
import type { Assessment } from '../domain/assessment.js';
import { assertTransition, isTerminal, type CaseRecord, type CaseState } from '../domain/case.js';
import { compileCase } from '../domain/compiler.js';
import { DomainError } from '../domain/errors.js';
import type { Evidence } from '../domain/evidence.js';
import { verifyReturnPostconditions } from '../domain/verification.js';
import {
  carrierScanEvidence,
  customerStatementEvidence,
  orderEvidence,
  orderSearchEvidence,
  policyEvidence,
  serialEvidence,
  thirdPartyClaimEvidence,
} from './evidence-factory.js';
import {
  GatewayTimeoutError,
  type Clock,
  type IdGenerator,
  type Interpretation,
  type Interpreter,
  type RetailerGateway,
  type RetailerOrder,
} from './ports.js';
import type { CaseRepository, Channel, EventActor, MessageRecord } from './repository.js';
import {
  STATE_LABELS,
  deriveJourney,
  deriveLifecycle,
  type CaseSummary,
  type CaseView,
} from './views.js';

export interface ServiceDeps {
  repo: CaseRepository;
  gateway: RetailerGateway;
  interpreter: Interpreter;
  /** Used when the primary interpreter fails. */
  fallbackInterpreter: Interpreter;
  clock: Clock;
  ids: IdGenerator;
  /** Business date new cases are evaluated on (pinned for the demo). */
  caseDate: () => string;
}

interface Actor {
  customerRef: string;
  channel: Channel;
}

const MAX_GATHER_ROUNDS = 3;

const actorFor = (channel: Channel): EventActor =>
  channel === 'mcp_client' ? 'mcp_client' : channel === 'lab' ? 'demo_control' : 'customer';

export class ResolutionService {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ServiceDeps) {}

  private get repo() {
    return this.deps.repo;
  }

  private now(): string {
    return this.deps.clock.now();
  }

  /** Serialize work on one case so two requests cannot interleave their reads and writes. */
  private async withLock<T>(caseId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(caseId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(caseId, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(caseId) === tail) this.locks.delete(caseId);
    }
  }

  private loadOwned(caseId: string, customerRef: string): CaseRecord {
    const record = this.repo.getCase(caseId);
    // Same answer for "missing" and "not yours", so case IDs cannot be probed.
    if (!record || record.customerRef !== customerRef) {
      throw new DomainError('not_found', 'No such case for this customer.');
    }
    return record;
  }

  private compile(record: CaseRecord): Assessment {
    return compileCase({
      caseRecord: record,
      evidence: this.repo.listEvidence(record.id),
      proposals: this.repo.listProposals(record.id),
      operations: this.repo.listOperations(record.id),
    });
  }

  private event(
    caseId: string,
    type: string,
    actor: EventActor,
    summary: string,
    data?: Record<string, unknown>,
  ) {
    this.repo.appendEvent({ caseId, type, actor, summary, ...(data ? { data } : {}) }, this.now());
  }

  private addEvidence(evidence: Evidence, actor: EventActor): void {
    this.repo.insertEvidence(evidence);
    this.event(
      evidence.caseId,
      evidence.verification === 'failed' ? 'evidence.rejected' : 'evidence.added',
      actor,
      evidence.verification === 'failed'
        ? `Rejected: ${evidence.title}`
        : `Added: ${evidence.title}`,
      {
        evidenceId: evidence.id,
        kind: evidence.kind,
        source: evidence.source.type,
        verification: evidence.verification,
      },
    );
  }

  private meta(caseId: string) {
    return { id: this.deps.ids('ev'), caseId, observedAt: this.now() };
  }

  private async interpret(
    caseId: string | null,
    utterance: string,
  ): Promise<Interpretation & { interpreter: string }> {
    try {
      const result = await this.deps.interpreter.interpret(utterance);
      return { ...result, interpreter: this.deps.interpreter.id };
    } catch (error) {
      const result = await this.deps.fallbackInterpreter.interpret(utterance);
      if (caseId) {
        this.event(
          caseId,
          'interpreter.fallback',
          'aftercare',
          `${this.deps.interpreter.id} failed; used ${this.deps.fallbackInterpreter.id}.`,
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return { ...result, interpreter: this.deps.fallbackInterpreter.id };
    }
  }

  private say(caseId: string, text: string, assessmentId: string | null): void {
    const message: MessageRecord = {
      id: this.deps.ids('msg'),
      caseId,
      role: 'assistant',
      text,
      channel: 'system',
      interpretation: null,
      assessmentId,
      createdAt: this.now(),
    };
    this.repo.insertMessage(message);
  }

  // ---- evidence gathering ----------------------------------------------------

  private async gather(record: CaseRecord, assessment: Assessment): Promise<void> {
    const wanted = new Set(
      assessment.missing.filter((m) => m.obtainableFrom === 'system').map((m) => m.id),
    );
    const gateway = this.deps.gateway;
    const added: Evidence[] = [];
    if (wanted.has('order_lookup')) {
      const evidence = this.repo.listEvidence(record.id);
      const query =
        [...evidence]
          .reverse()
          .flatMap((e) => e.facts)
          .find((f) => f.subject === 'case' && f.attribute === 'productQuery')?.value ??
        record.goal.productQuery;
      const productQuery = typeof query === 'string' ? query : null;
      const orders = await gateway.searchOrders(record.customerRef, productQuery);
      added.push(
        orderSearchEvidence(
          this.meta(record.id),
          productQuery,
          orders.map((o) => o.orderId),
          gateway.name,
          gateway.simulated,
        ),
      );
      for (const order of orders)
        added.push(orderEvidence(this.meta(record.id), order, gateway.name, gateway.simulated));
      const scans = await gateway.getCarrierScans(orders.map((o) => o.orderId));
      for (const scan of scans)
        added.push(carrierScanEvidence(this.meta(record.id), scan, gateway.simulated));
    }
    if (wanted.has('policy_documents')) {
      for (const policy of await gateway.listPolicyVersions()) {
        added.push(policyEvidence(this.meta(record.id), policy, gateway.simulated));
      }
    }
    this.repo.transaction(() => {
      for (const e of added) this.addEvidence(e, 'retailer');
    });
  }

  private attachOrderIfMissing(record: CaseRecord, order: RetailerOrder): void {
    const present = this.repo
      .listEvidence(record.id)
      .some(
        (e) =>
          e.kind === 'order_record' &&
          e.source.reference === order.orderId &&
          e.status === 'active',
      );
    if (!present) {
      this.addEvidence(
        orderEvidence(
          this.meta(record.id),
          order,
          this.deps.gateway.name,
          this.deps.gateway.simulated,
        ),
        'retailer',
      );
    }
  }

  // ---- the core loop -------------------------------------------------------------

  /**
   * Compile the case, perform any system retrievals the compiler asks for,
   * then persist the assessment, proposal changes and state transition
   * atomically, and reply to the customer.
   */
  private async advance(
    caseId: string,
    opts: { reply?: boolean; prefix?: string } = {},
  ): Promise<Assessment> {
    let record = this.repo.getCase(caseId) as CaseRecord;
    let assessment = this.compile(record);
    for (
      let round = 0;
      round < MAX_GATHER_ROUNDS && assessment.nextStep.kind === 'gather_evidence';
      round++
    ) {
      await this.gather(record, assessment);
      record = this.repo.getCase(caseId) as CaseRecord;
      assessment = this.compile(record);
    }

    this.repo.transaction(() => {
      const current = this.repo.getCase(caseId) as CaseRecord;
      const at = this.now();
      const assessmentId = this.deps.ids('asm');
      this.repo.insertAssessment({ id: assessmentId, caseId, createdAt: at, body: assessment });
      this.event(
        caseId,
        'assessment.compiled',
        'aftercare',
        `Decision: ${assessment.nextStep.kind.replaceAll('_', ' ')}`,
        {
          assessmentId,
          nextStep: assessment.nextStep.kind,
          nextState: assessment.nextCaseState,
          rationale: assessment.nextStep.rationale,
        },
      );

      for (const id of assessment.supersedeProposalIds) {
        this.repo.updateProposalStatus(id, 'superseded', at);
        this.event(
          caseId,
          'proposal.superseded',
          'aftercare',
          'Withdrew a proposal that no longer matches the evidence. Any approval of it no longer applies.',
          { proposalId: id },
        );
      }

      if (assessment.nextStep.kind === 'propose_action' && assessment.proposal) {
        const draft = assessment.proposal;
        const proposal: Proposal = {
          id: this.deps.ids('prop'),
          caseId,
          actionType: draft.actionType,
          parameters: draft.parameters,
          digest: draft.digest,
          preconditions: draft.preconditions,
          postconditions: draft.postconditions,
          verification: draft.verification,
          requiresApproval: true,
          status: 'prepared',
          assessmentId,
          createdAt: at,
          updatedAt: at,
        };
        this.repo.insertProposal(proposal);
        this.event(
          caseId,
          'proposal.prepared',
          'aftercare',
          `Prepared: return ${draft.parameters.orderId} for a refund. Nothing authorized or submitted.`,
          {
            proposalId: proposal.id,
            digest: proposal.digest,
          },
        );
      }

      if (assessment.nextCaseState !== current.state) {
        assertTransition(current.state, assessment.nextCaseState);
        this.repo.updateCase(caseId, current.version, { state: assessment.nextCaseState }, at);
        this.event(
          caseId,
          'case.state_changed',
          'aftercare',
          `${STATE_LABELS[current.state]} → ${STATE_LABELS[assessment.nextCaseState]}`,
          {
            from: current.state,
            to: assessment.nextCaseState,
          },
        );
      }

      if (opts.reply !== false) {
        this.say(
          caseId,
          `${opts.prefix ? `${opts.prefix} ` : ''}${assessment.nextStep.customerMessage}`,
          assessmentId,
        );
      }
    });
    return assessment;
  }

  private moveTo(record: CaseRecord, to: CaseState, reason: string): CaseRecord {
    assertTransition(record.state, to);
    const next = this.repo.updateCase(record.id, record.version, { state: to }, this.now());
    this.event(
      record.id,
      'case.state_changed',
      'aftercare',
      `${STATE_LABELS[record.state]} → ${STATE_LABELS[to]}`,
      { from: record.state, to, reason },
    );
    return next;
  }

  // ---- use cases --------------------------------------------------------------------

  async openCase(input: Actor & { utterance: string }): Promise<CaseView> {
    const utterance = requireText(input.utterance, 'utterance');
    const interpretation = await this.interpret(null, utterance);
    const at = this.now();
    const product = interpretation.productQuery;
    const record: CaseRecord = {
      id: this.deps.ids('case'),
      customerRef: input.customerRef,
      state: 'open',
      goal: { type: interpretation.goal ?? 'unknown', productQuery: product },
      asOf: this.deps.caseDate(),
      title: product
        ? `${interpretation.goal === 'exchange' ? 'Replace' : 'Return'} ${product}`
        : 'Purchase problem',
      version: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.repo.transaction(() => {
      this.repo.insertCase(record);
      this.event(
        record.id,
        'case.opened',
        actorFor(input.channel),
        `Case opened via ${channelName(input.channel)}.`,
        {
          channel: input.channel,
          caseDate: record.asOf,
        },
      );
      this.recordCustomerMessage(record.id, utterance, interpretation, input.channel);
    });
    await this.withLock(record.id, () => this.advance(record.id));
    return this.getCase(record.id, input.customerRef);
  }

  private recordCustomerMessage(
    caseId: string,
    text: string,
    interpretation: Interpretation & { interpreter: string },
    channel: Channel,
  ): void {
    this.repo.insertMessage({
      id: this.deps.ids('msg'),
      caseId,
      role: 'customer',
      text,
      channel,
      interpretation,
      assessmentId: null,
      createdAt: this.now(),
    });
    this.event(
      caseId,
      'message.received',
      actorFor(channel),
      `Customer: “${text.length > 80 ? `${text.slice(0, 79)}…` : text}”`,
      {
        interpreter: interpretation.interpreter,
        extracted: Object.fromEntries(
          Object.entries(interpretation).filter(
            ([k, v]) => v !== null && v !== false && k !== 'interpreter',
          ),
        ),
      },
    );
    const statement = customerStatementEvidence(
      this.meta(caseId),
      text,
      interpretation,
      interpretation.interpreter,
    );
    if (statement) this.addEvidence(statement, 'customer');
  }

  async sendMessage(input: Actor & { caseId: string; utterance: string }): Promise<CaseView> {
    const utterance = requireText(input.utterance, 'utterance');
    return this.withLock(input.caseId, async () => {
      const record = this.loadOwned(input.caseId, input.customerRef);
      const interpretation = await this.interpret(record.id, utterance);
      this.repo.transaction(() =>
        this.recordCustomerMessage(record.id, utterance, interpretation, input.channel),
      );

      if (isTerminal(record.state)) {
        this.repo.transaction(() =>
          this.say(
            record.id,
            `This case is ${STATE_LABELS[record.state].toLowerCase()}. To start something new, open a new case.`,
            null,
          ),
        );
        return this.getCase(record.id, input.customerRef);
      }
      if (
        interpretation.wantsToCancel &&
        [
          'open',
          'needs_information',
          'needs_review',
          'awaiting_approval',
          'not_eligible',
          'ready_to_submit',
        ].includes(record.state)
      ) {
        this.repo.transaction(() => {
          this.declineLiveProposals(record.id, 'Customer closed the case.');
          this.moveTo(
            this.repo.getCase(record.id) as CaseRecord,
            'closed',
            'Customer asked to close the case.',
          );
          this.say(record.id, 'Okay, I’ve closed this case. Nothing was submitted.', null);
        });
        return this.getCase(record.id, input.customerRef);
      }

      let prefix: string | undefined;
      if (interpretation.serialNumber) {
        prefix = await this.recordSerial(record, interpretation.serialNumber, input.channel);
      }
      if (interpretation.orderNumber) {
        const order = await this.deps.gateway.getOrder(
          record.customerRef,
          interpretation.orderNumber,
        );
        this.repo.transaction(() => {
          if (order) this.attachOrderIfMissing(record, order);
          else
            this.event(
              record.id,
              'evidence.not_found',
              'retailer',
              `No order ${interpretation.orderNumber} on this account.`,
            );
        });
      }
      if (interpretation.soundsLikeApproval && record.state === 'awaiting_approval') {
        // Agreement in conversation is not approval. Approval must name the exact proposal.
        this.repo.transaction(() =>
          this.event(
            record.id,
            'approval.not_inferred',
            'aftercare',
            'Customer sounded agreeable in chat; treated as conversation, not approval.',
          ),
        );
        prefix =
          'To keep you in control, I only act on an explicit approval of the exact return shown. Use “Approve return” on the proposal.';
      }
      await this.advance(record.id, prefix ? { prefix } : {});
      return this.getCase(record.id, input.customerRef);
    });
  }

  /** Validates a serial against the retailer's shipment records and records the result. Returns a reply prefix. */
  private async recordSerial(
    record: CaseRecord,
    serial: string,
    channel: Channel,
  ): Promise<string | undefined> {
    const match = await this.deps.gateway.findOrderBySerial(record.customerRef, serial);
    this.repo.transaction(() => {
      this.addEvidence(
        serialEvidence(this.meta(record.id), serial, match, this.deps.gateway.name),
        actorFor(channel),
      );
      if (match) this.attachOrderIfMissing(record, match);
    });
    return match
      ? `Thanks. Serial ${serial.toUpperCase()} matches order ${match.orderId}.`
      : undefined;
  }

  async provideSerial(input: Actor & { caseId: string; serialNumber: string }): Promise<CaseView> {
    const serial = requireText(input.serialNumber, 'serialNumber');
    if (!/^[A-Za-z0-9-]{4,32}$/.test(serial)) {
      throw new DomainError('invalid_input', 'A serial number has 4–32 letters, digits or dashes.');
    }
    return this.withLock(input.caseId, async () => {
      const record = this.loadOwned(input.caseId, input.customerRef);
      if (isTerminal(record.state))
        throw new DomainError('illegal_transition', 'This case is closed.');
      this.repo.transaction(() =>
        this.repo.insertMessage({
          id: this.deps.ids('msg'),
          caseId: record.id,
          role: 'customer',
          text: `Serial number: ${serial}`,
          channel: input.channel,
          interpretation: null,
          assessmentId: null,
          createdAt: this.now(),
        }),
      );
      const prefix = await this.recordSerial(record, serial, input.channel);
      await this.advance(record.id, prefix ? { prefix } : {});
      return this.getCase(record.id, input.customerRef);
    });
  }

  /** A customer-shared third-party page (for example a blog post about the return policy). */
  async addThirdPartyClaim(
    input: Actor & {
      caseId: string;
      sourceName: string;
      url: string;
      windowDays: number;
      excerpt: string;
    },
  ): Promise<CaseView> {
    return this.withLock(input.caseId, async () => {
      const record = this.loadOwned(input.caseId, input.customerRef);
      if (isTerminal(record.state))
        throw new DomainError('illegal_transition', 'This case is closed.');
      this.repo.transaction(() =>
        this.addEvidence(
          thirdPartyClaimEvidence(this.meta(record.id), {
            sourceName: input.sourceName,
            url: input.url,
            policyId: 'kestrel-returns',
            windowDays: input.windowDays,
            excerpt: input.excerpt,
          }),
          actorFor(input.channel),
        ),
      );
      await this.advance(record.id);
      return this.getCase(record.id, input.customerRef);
    });
  }

  /** Re-read delivery records for the orders on the case (for example after a carrier correction). */
  async refreshCarrierRecords(input: Actor & { caseId: string }): Promise<CaseView> {
    return this.withLock(input.caseId, async () => {
      const record = this.loadOwned(input.caseId, input.customerRef);
      const evidence = this.repo.listEvidence(record.id);
      const orderIds = evidence
        .filter((e) => e.kind === 'order_record')
        .map((e) => e.source.reference ?? '');
      const known = new Set(
        evidence.filter((e) => e.kind === 'carrier_scan').map((e) => e.source.reference),
      );
      const scans = await this.deps.gateway.getCarrierScans(orderIds);
      this.repo.transaction(() => {
        for (const scan of scans) {
          if (!known.has(scan.trackingRef)) {
            this.addEvidence(
              carrierScanEvidence(this.meta(record.id), scan, this.deps.gateway.simulated),
              'retailer',
            );
          }
        }
      });
      if (!isTerminal(record.state)) await this.advance(record.id);
      return this.getCase(record.id, input.customerRef);
    });
  }

  async approve(
    input: Actor & { caseId: string; proposalId: string; digest: string; statement: string },
  ): Promise<CaseView> {
    const statement = requireText(input.statement, 'statement');
    return this.withLock(input.caseId, async () => {
      const record = this.loadOwned(input.caseId, input.customerRef);
      const proposal = this.repo.listProposals(record.id).find((p) => p.id === input.proposalId);
      const refuse = (
        code: 'approval_mismatch' | 'proposal_not_current' | 'not_found',
        message: string,
      ) => {
        this.repo.transaction(() =>
          this.event(record.id, 'approval.refused', actorFor(input.channel), message, {
            proposalId: input.proposalId,
            code,
          }),
        );
        return new DomainError(code, message);
      };
      if (!proposal) throw refuse('not_found', 'No such proposal on this case.');
      if (proposal.digest !== input.digest) {
        throw refuse(
          'approval_mismatch',
          'The approval does not match the exact proposal on record.',
        );
      }
      // The proposal must still be the one the evidence supports right now.
      const current = this.compile(record);
      if (
        proposal.status !== 'prepared' ||
        current.nextStep.kind !== 'await_approval' ||
        current.nextStep.proposalId !== proposal.id
      ) {
        throw refuse(
          'proposal_not_current',
          'This proposal is no longer current; review the latest one before approving.',
        );
      }
      this.repo.transaction(() => {
        const at = this.now();
        this.repo.insertApproval({
          id: this.deps.ids('apr'),
          proposalId: proposal.id,
          caseId: record.id,
          digest: proposal.digest,
          approvedBy: input.customerRef,
          channel: input.channel === 'mcp_client' ? 'mcp_client' : 'assistant_surface',
          statement,
          approvedAt: at,
        });
        this.repo.updateProposalStatus(proposal.id, 'approved', at);
        this.event(
          record.id,
          'approval.recorded',
          actorFor(input.channel),
          `Customer approved exactly this return (digest ${proposal.digest.slice(0, 12)}…).`,
          {
            proposalId: proposal.id,
            digest: proposal.digest,
            statement,
          },
        );
      });
      await this.advance(record.id);
      return this.getCase(record.id, input.customerRef);
    });
  }

  private declineLiveProposals(caseId: string, reason: string): void {
    for (const p of this.repo.listProposals(caseId)) {
      if (p.status === 'prepared' || p.status === 'approved') {
        this.repo.updateProposalStatus(p.id, 'declined', this.now());
        this.event(caseId, 'proposal.declined', 'customer', reason, { proposalId: p.id });
      }
    }
  }

  async decline(input: Actor & { caseId: string; proposalId: string }): Promise<CaseView> {
    return this.withLock(input.caseId, async () => {
      const record = this.loadOwned(input.caseId, input.customerRef);
      const proposal = this.repo.listProposals(record.id).find((p) => p.id === input.proposalId);
      if (!proposal || proposal.status !== 'prepared') {
        throw new DomainError(
          'proposal_not_current',
          'Only a proposal waiting for approval can be declined.',
        );
      }
      this.repo.transaction(() => {
        this.declineLiveProposals(record.id, 'Customer declined the proposed return.');
        this.moveTo(record, 'closed', 'Customer declined the proposal.');
        this.say(
          record.id,
          'Understood. I haven’t submitted anything, and I’ve closed this case. You can start a new one any time.',
          null,
        );
      });
      return this.getCase(record.id, input.customerRef);
    });
  }

  async execute(input: Actor & { caseId: string; proposalId: string }): Promise<CaseView> {
    return this.withLock(input.caseId, async () => {
      const record = this.loadOwned(input.caseId, input.customerRef);
      const assessment = this.compile(record);
      const proposals = this.repo.listProposals(record.id);
      const proposal = proposals.find((p) => p.id === input.proposalId);
      if (!proposal) throw new DomainError('not_found', 'No such proposal on this case.');
      const ops = this.repo.listOperations(record.id);
      const existing = ops.find((o) => o.proposalId === proposal.id);

      if (assessment.nextStep.kind === 'reconcile_operation') {
        throw new DomainError(
          'reconciliation_required',
          'A previous submission has an unknown outcome. Check it before submitting again.',
        );
      }
      if (existing && BLOCKING_OPERATION_STATUSES.includes(existing.status)) {
        this.repo.transaction(() =>
          this.event(
            record.id,
            'operation.duplicate_blocked',
            actorFor(input.channel),
            'Blocked a second submission of an action already submitted.',
            { operationId: existing.id },
          ),
        );
        throw new DomainError('duplicate_operation', 'This return was already submitted.');
      }
      if (
        assessment.nextStep.kind !== 'submit_approved_action' ||
        assessment.nextStep.proposalId !== proposal.id
      ) {
        throw new DomainError(
          proposal.status === 'prepared' ? 'approval_required' : 'proposal_not_current',
          proposal.status === 'prepared'
            ? 'This return has not been approved.'
            : 'This proposal cannot be submitted in the case’s current state.',
        );
      }
      // Defence in depth: an approval for exactly this digest must be on record.
      const approval = this.repo
        .listApprovals(record.id)
        .find((a) => a.proposalId === proposal.id && a.digest === proposal.digest);
      if (!approval)
        throw new DomainError(
          'approval_required',
          'No approval on record for this exact proposal.',
        );
      if (existing && existing.attempts >= MAX_SUBMISSION_ATTEMPTS) {
        throw new DomainError(
          'retry_limit_reached',
          'The retry limit for this action has been reached.',
        );
      }

      const at = this.now();
      const operation: Operation = existing
        ? {
            ...existing,
            status: 'submitting',
            attempts: existing.attempts + 1,
            lastError: null,
            updatedAt: at,
          }
        : {
            id: this.deps.ids('op'),
            caseId: record.id,
            proposalId: proposal.id,
            // Stable across retries, so the retailer can recognize a repeat of the same request.
            idempotencyKey: `aftercare:${record.id}:${proposal.id}`,
            status: 'submitting',
            attempts: 1,
            externalRef: null,
            lastError: null,
            observed: null,
            createdAt: at,
            updatedAt: at,
          };
      // Write-ahead: the operation is on record before the retailer is contacted.
      this.repo.transaction(() => {
        if (existing) this.repo.updateOperation(operation);
        else this.repo.insertOperation(operation);
        this.moveTo(
          this.repo.getCase(record.id) as CaseRecord,
          'executing',
          'Submitting the approved action.',
        );
        this.event(
          record.id,
          'operation.submitting',
          'aftercare',
          `Submitting return for ${proposal.parameters.orderId} (attempt ${operation.attempts}).`,
          {
            operationId: operation.id,
            idempotencyKey: operation.idempotencyKey,
            attempt: operation.attempts,
            simulated: this.deps.gateway.simulated,
          },
        );
      });

      const started = this.now();
      const p = proposal.parameters;
      let outcome: {
        status: Operation['status'];
        externalRef?: string | null;
        lastError?: string | null;
        observed?: Record<string, unknown> | null;
        summary: string;
        type: string;
      };
      try {
        const result = await this.deps.gateway.createReturn({
          idempotencyKey: operation.idempotencyKey,
          customerRef: record.customerRef,
          orderId: p.orderId,
          lineId: p.lineId,
          reason: p.reason,
          refundAmountCents: p.refundAmountCents,
          currency: p.currency,
          returnShipping: p.returnShipping,
        });
        if (result.kind === 'accepted') {
          outcome = {
            status: 'accepted',
            externalRef: result.rma.rmaId,
            observed: { ...result.rma },
            type: 'operation.accepted',
            summary: `Retailer acknowledged the request (${result.rma.rmaId}, status ${result.rma.status}). Not yet verified.`,
          };
        } else if (result.kind === 'rejected') {
          outcome = {
            status: 'rejected',
            lastError: result.reason,
            type: 'operation.rejected',
            summary: `Retailer refused: ${result.reason}`,
          };
        } else {
          outcome = {
            status: 'failed',
            lastError: result.message,
            type: 'operation.failed',
            summary: `Not executed: ${result.message}`,
          };
        }
      } catch (error) {
        const message =
          error instanceof GatewayTimeoutError
            ? error.message
            : `Unexpected error after sending: ${error instanceof Error ? error.message : String(error)}`;
        outcome = {
          status: 'outcome_unknown',
          lastError: message,
          type: 'operation.outcome_unknown',
          summary: `${message} The return may or may not exist. No retry until reconciled.`,
        };
      }

      this.repo.transaction(() => {
        const updated: Operation = {
          ...operation,
          status: outcome.status,
          externalRef: outcome.externalRef ?? operation.externalRef,
          lastError: outcome.lastError ?? null,
          observed: outcome.observed ?? operation.observed,
          updatedAt: this.now(),
        };
        this.repo.updateOperation(updated);
        this.repo.insertAttempt({
          id: this.deps.ids('att'),
          operationId: operation.id,
          kind: 'submit',
          outcome: outcome.status,
          detail: outcome.lastError ?? outcome.externalRef ?? null,
          startedAt: started,
          finishedAt: this.now(),
        });
        this.event(record.id, outcome.type, 'retailer', outcome.summary, {
          operationId: operation.id,
          status: outcome.status,
          simulated: this.deps.gateway.simulated,
        });
      });
      await this.advance(record.id);
      return this.getCase(record.id, input.customerRef);
    });
  }

  /** Verify an accepted operation, or reconcile one whose outcome is unknown. Never resubmits. */
  async checkOutcome(input: Actor & { caseId: string }): Promise<CaseView> {
    return this.withLock(input.caseId, async () => {
      const record = this.loadOwned(input.caseId, input.customerRef);
      const assessment = this.compile(record);
      const kind = assessment.nextStep.kind;
      if (kind !== 'reconcile_operation' && kind !== 'verify_outcome') {
        throw new DomainError(
          'conflict',
          'There is no submitted action whose outcome needs checking.',
        );
      }
      const operation = this.repo
        .listOperations(record.id)
        .find((o) => o.id === assessment.nextStep.operationId) as Operation;
      const proposal = this.repo
        .listProposals(record.id)
        .find((p) => p.id === operation.proposalId) as Proposal;
      const started = this.now();
      const gateway = this.deps.gateway;
      let update: Partial<Operation> = {};
      let type: string;
      let summary: string;

      if (kind === 'reconcile_operation') {
        try {
          const found = await gateway.findReturnByIdempotencyKey(operation.idempotencyKey);
          if (found && found.status !== 'refused') {
            update = {
              status: 'accepted',
              externalRef: found.rmaId,
              observed: { ...found },
              lastError: null,
            };
            type = 'reconciliation.found';
            summary = `Reconciled: the retailer has ${found.rmaId} for this request. It was created; no resubmission needed.`;
          } else if (found) {
            update = {
              status: 'rejected',
              externalRef: found.rmaId,
              lastError: found.refusalReason ?? 'Refused by retailer.',
            };
            type = 'reconciliation.refused';
            summary = `Reconciled: the retailer refused ${found.rmaId}.`;
          } else {
            update = {
              status: 'failed',
              lastError: 'Reconciled: the retailer has no record of this request.',
            };
            type = 'reconciliation.not_found';
            summary =
              'Reconciled: the retailer has no record of the request, so it was not executed. A retry with the same idempotency key is safe.';
          }
        } catch (error) {
          type = 'reconciliation.inconclusive';
          summary = `Could not reach the retailer to reconcile (${error instanceof Error ? error.message : String(error)}). Outcome still unknown.`;
        }
      } else {
        try {
          const rma = operation.externalRef ? await gateway.getReturn(operation.externalRef) : null;
          if (!rma) {
            update = {
              status: 'outcome_unknown',
              lastError: 'Acknowledged return not found on re-read.',
            };
            type = 'verification.missing';
            summary =
              'The retailer acknowledged a return that it now cannot find. Treating the outcome as unknown.';
          } else {
            const verdict = verifyReturnPostconditions(proposal, rma);
            const observed = { ...rma, checks: verdict.checks };
            if (verdict.result === 'confirmed') {
              update = { status: 'confirmed', observed };
              type = 'verification.confirmed';
              summary = `Verified against the retailer’s record: ${rma.rmaId} authorized, all ${verdict.checks.length} checks passed.`;
            } else if (verdict.result === 'pending') {
              update = { observed };
              type = 'verification.pending';
              summary = `${rma.rmaId} is still ${rma.status}; ${verdict.checks.filter((c) => !c.passed).length} check(s) not yet satisfied.`;
            } else if (verdict.result === 'refused') {
              update = { status: 'rejected', observed, lastError: verdict.reason };
              type = 'verification.refused';
              summary = `The retailer refused ${rma.rmaId}: ${verdict.reason}`;
            } else {
              const differences = verdict.checks
                .filter(
                  (c) =>
                    !c.passed && ['rma_exists', 'refund_amount', 'shipping_terms'].includes(c.id),
                )
                .map((c) => `${c.description} (found ${c.observed})`);
              update = {
                status: 'mismatch',
                observed,
                lastError: `The retailer’s return does not match the approval: ${differences.join('; ')}.`,
              };
              type = 'verification.mismatch';
              summary = `${rma.rmaId} exists but does not match the approved return: ${differences.join('; ')}.`;
            }
          }
        } catch (error) {
          type = 'verification.inconclusive';
          summary = `Could not reach the retailer to verify (${error instanceof Error ? error.message : String(error)}).`;
        }
      }

      this.repo.transaction(() => {
        const updated: Operation = { ...operation, ...update, updatedAt: this.now() };
        this.repo.updateOperation(updated);
        this.repo.insertAttempt({
          id: this.deps.ids('att'),
          operationId: operation.id,
          kind: kind === 'reconcile_operation' ? 'reconcile' : 'verify',
          outcome: type,
          detail: summary,
          startedAt: started,
          finishedAt: this.now(),
        });
        this.event(record.id, type, 'retailer', summary, {
          operationId: operation.id,
          simulated: gateway.simulated,
        });
      });
      await this.advance(record.id);
      return this.getCase(record.id, input.customerRef);
    });
  }

  // ---- reads ------------------------------------------------------------------------

  getCase(caseId: string, customerRef: string): CaseView {
    const record = this.loadOwned(caseId, customerRef);
    const latest = this.repo.latestAssessment(caseId);
    const proposals = this.repo.listProposals(caseId);
    const operations = this.repo.listOperations(caseId);
    const lifecycle = deriveLifecycle(latest?.body ?? null, proposals, operations);
    const evidence = this.repo.listEvidence(caseId);
    return {
      case: { ...record, stateLabel: STATE_LABELS[record.state] },
      assessmentId: latest?.id ?? null,
      assessment: latest?.body ?? null,
      lifecycle,
      journey: deriveJourney(record, latest?.body ?? null, evidence, lifecycle),
      messages: this.repo.listMessages(caseId),
      evidence,
      proposals,
      approvals: this.repo.listApprovals(caseId),
      operations,
      attempts: this.repo.listAttempts(caseId),
      events: this.repo.listEvents(caseId),
    };
  }

  listCases(customerRef: string): CaseSummary[] {
    return this.repo.listCases(customerRef).map((c) => ({
      id: c.id,
      title: c.title,
      state: c.state,
      stateLabel: STATE_LABELS[c.state],
      headline: this.repo.latestAssessment(c.id)?.body.headline ?? null,
      updatedAt: c.updatedAt,
    }));
  }

  /**
   * Re-evaluate a case on read after a restart. If a submission was in
   * flight when the process stopped, the compiler now routes it to
   * reconciliation instead of leaving it in "executing".
   */
  async recover(caseId: string): Promise<void> {
    await this.withLock(caseId, async () => {
      const record = this.repo.getCase(caseId);
      if (record && record.state === 'executing') {
        const ops = this.repo.listOperations(caseId).filter((o) => o.status === 'submitting');
        this.repo.transaction(() => {
          for (const op of ops) {
            this.repo.updateOperation({
              ...op,
              status: 'outcome_unknown',
              lastError: 'Process stopped during submission.',
              updatedAt: this.now(),
            });
            this.event(
              caseId,
              'operation.outcome_unknown',
              'aftercare',
              'Found a submission interrupted by a restart; its outcome is unknown until reconciled.',
              { operationId: op.id },
            );
          }
        });
        await this.advance(caseId);
      }
    });
  }
}

function requireText(value: string, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new DomainError('invalid_input', `${field} must not be empty.`);
  if (text.length > 2000)
    throw new DomainError('invalid_input', `${field} is too long (2000 characters max).`);
  return text;
}

function channelName(channel: Channel): string {
  return {
    assistant_surface: 'the assistant surface',
    mcp_client: 'an MCP client',
    lab: 'the Resolution Lab',
    system: 'the system',
  }[channel];
}
