/**
 * Demo controls used by the Resolution Lab and the evaluation harness.
 *
 * These act only on the demo customer's cases and on the simulated retailer.
 * Each control is recorded as a "demo_control" event so the timeline never
 * hides that a judge or tester scripted something.
 */
import { addDays } from '../domain/dates.js';
import { DomainError } from '../domain/errors.js';
import type { CaseRepository } from './repository.js';
import type { ResolutionService } from './resolution-service.js';
import type { CaseView } from './views.js';
import type { Clock, SandboxControls } from './ports.js';

export const SUBMISSION_OUTCOMES = [
  'accept',
  'reject',
  'unavailable',
  'timeout_after_commit',
  'timeout_before_commit',
] as const;
export type ScriptedSubmission = (typeof SUBMISSION_OUTCOMES)[number];

export const OUTCOME_DESCRIPTIONS: Record<ScriptedSubmission, string> = {
  accept: 'Retailer accepts the request.',
  reject: 'Retailer refuses the request.',
  unavailable: 'Retailer reports it is unavailable; nothing is created.',
  timeout_after_commit: 'Retailer creates the return, but the response is lost (ambiguous).',
  timeout_before_commit: 'Request is lost before the retailer processes it (ambiguous).',
};

export interface DemoDeps {
  repo: CaseRepository;
  sandbox: SandboxControls & { seed(dataset: unknown): void };
  service: ResolutionService;
  clock: Clock;
  demoCustomer: string;
  dataset: unknown;
}

export class DemoService {
  constructor(private readonly deps: DemoDeps) {}

  /** Restore the known starting state: no demo cases, freshly seeded retailer. */
  reset(): { removedCases: number } {
    const removedCases = this.deps.repo.transaction(() => {
      const removed = this.deps.repo.deleteCasesForCustomer(this.deps.demoCustomer);
      this.deps.sandbox.seed(this.deps.dataset);
      return removed;
    });
    return { removedCases };
  }

  sandboxState() {
    return {
      queue: this.deps.sandbox.listQueue(),
      requestLog: this.deps.sandbox.requestLog(),
      returns: this.deps.sandbox.listReturns(),
      outcomes: SUBMISSION_OUTCOMES.map((o) => ({ id: o, description: OUTCOME_DESCRIPTIONS[o] })),
    };
  }

  /** Script what happens on the next submission (replaces anything already queued). */
  scriptNextSubmission(outcome: ScriptedSubmission, caseId: string | null): void {
    if (!SUBMISSION_OUTCOMES.includes(outcome))
      throw new DomainError('invalid_input', 'Unknown outcome.');
    this.deps.repo.transaction(() => {
      this.deps.sandbox.clearQueue();
      this.deps.sandbox.queueOutcome(
        'create_return',
        outcome,
        outcome === 'reject'
          ? 'This item was flagged for an in-store inspection (scripted refusal).'
          : null,
      );
      if (caseId && this.deps.repo.getCase(caseId)) {
        this.deps.repo.appendEvent(
          {
            caseId,
            type: 'demo.outcome_scripted',
            actor: 'demo_control',
            summary: `Demo control: next retailer submission will be "${outcome.replaceAll('_', ' ')}".`,
            data: { outcome },
          },
          this.deps.clock.now(),
        );
      }
    });
  }

  /** Introduce a carrier record that disagrees with the retailer's delivery date by two days. */
  async injectCarrierConflict(caseId: string): Promise<CaseView> {
    const view = this.deps.service.getCase(caseId, this.deps.demoCustomer);
    const orderId =
      view.assessment?.subject.orderId ??
      view.evidence.find((e) => e.kind === 'order_record')?.source.reference ??
      null;
    const delivered = view.evidence
      .find((e) => e.kind === 'order_record' && e.source.reference === orderId)
      ?.facts.find((f) => f.attribute === 'deliveredOn')?.value;
    if (!orderId || typeof delivered !== 'string') {
      throw new DomainError('conflict', 'The case has no order with a delivery date yet.');
    }
    this.deps.sandbox.addCarrierScan({
      orderId,
      carrier: 'Swiftline Parcel',
      trackingRef: `SL-${orderId.slice(-4)}-${Math.floor(Math.random() * 9000 + 1000)}`,
      deliveredOn: addDays(delivered, 2),
    });
    this.deps.repo.transaction(() =>
      this.deps.repo.appendEvent(
        {
          caseId,
          type: 'demo.conflict_injected',
          actor: 'demo_control',
          summary: `Demo control: carrier now reports delivery on ${addDays(delivered, 2)} for ${orderId}.`,
        },
        this.deps.clock.now(),
      ),
    );
    return this.deps.service.refreshCarrierRecords({
      caseId,
      customerRef: this.deps.demoCustomer,
      channel: 'lab',
    });
  }

  /** The customer shares a third-party page that claims a 90-day return window. */
  async injectThirdPartyClaim(caseId: string): Promise<CaseView> {
    return this.deps.service.addThirdPartyClaim({
      caseId,
      customerRef: this.deps.demoCustomer,
      channel: 'lab',
      sourceName: 'DealDigest blog (fictional)',
      url: 'demo://dealdigest/kestrel-goods-return-policy',
      windowDays: 90,
      excerpt: 'Kestrel Goods gives you 90 days to return anything, no questions asked.',
    });
  }
}
