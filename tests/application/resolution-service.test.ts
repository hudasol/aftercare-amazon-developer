import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainer, type Container } from '../../src/container.js';
import type { CaseView } from '../../src/application/views.js';

const CUSTOMER = 'cus_demo_maya';
const FLAGSHIP =
  'My wireless headphones keep disconnecting. I bought them recently. Can you help me return them?';
const ctx = { customerRef: CUSTOMER, channel: 'assistant_surface' as const };

let dir: string;
let dbPath: string;
let app: Container;

function open(): Container {
  return createContainer({ databasePath: dbPath, demoCustomer: CUSTOMER });
}

function liveProposal(view: CaseView) {
  const p = view.proposals.find((x) => x.status === 'prepared' || x.status === 'approved');
  if (!p) throw new Error('expected a live proposal');
  return p;
}

async function toApproval(): Promise<CaseView> {
  const opened = await app.service.openCase({ ...ctx, utterance: FLAGSHIP });
  return app.service.provideSerial({ ...ctx, caseId: opened.case.id, serialNumber: 'HA-7Q2-4471' });
}

async function approved(): Promise<CaseView> {
  const view = await toApproval();
  const p = liveProposal(view);
  return app.service.approve({
    ...ctx,
    caseId: view.case.id,
    proposalId: p.id,
    digest: p.digest,
    statement: 'Approve return',
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aftercare-test-'));
  dbPath = join(dir, 'test.db');
  app = open();
});

afterEach(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Return Rescue, end to end through the application layer', () => {
  it('runs the flagship journey: block, resolve, approve, ambiguous timeout, reconcile, verify, resume', async () => {
    const opened = await app.service.openCase({ ...ctx, utterance: FLAGSHIP });
    const caseId = opened.case.id;
    expect(opened.case.state).toBe('needs_information');
    expect(opened.assessment?.subject.candidates).toHaveLength(2);
    expect(opened.evidence.filter((e) => e.kind === 'policy_document')).toHaveLength(2);
    expect(opened.messages.at(-1)?.text).toMatch(/serial number/);
    expect(opened.lifecycle.stage).toBe('blocked');

    const wrong = await app.service.provideSerial({ ...ctx, caseId, serialNumber: 'HA-0X0-0000' });
    expect(wrong.case.state).toBe('needs_information');
    expect(wrong.evidence.find((e) => e.kind === 'item_serial')?.verification).toBe('failed');
    expect(wrong.messages.at(-1)?.text).toMatch(/doesn’t match either order/);

    const ready = await app.service.provideSerial({ ...ctx, caseId, serialNumber: 'ha-7q2-4471' });
    expect(ready.case.state).toBe('awaiting_approval');
    expect(ready.lifecycle.stage).toBe('prepared');
    const proposal = liveProposal(ready);
    expect(proposal.parameters).toMatchObject({
      orderId: 'KG-1162-5821',
      policyVersion: '2026.1',
      returnBy: '2026-10-30',
    });

    const chatty = await app.service.sendMessage({ ...ctx, caseId, utterance: 'Yes, go ahead!' });
    expect(chatty.case.state).toBe('awaiting_approval');
    expect(chatty.approvals).toHaveLength(0);
    expect(chatty.events.some((e) => e.type === 'approval.not_inferred')).toBe(true);

    await expect(
      app.service.execute({ ...ctx, caseId, proposalId: proposal.id }),
    ).rejects.toMatchObject({ code: 'approval_required' });
    await expect(
      app.service.approve({
        ...ctx,
        caseId,
        proposalId: proposal.id,
        digest: 'f'.repeat(64),
        statement: 'ok',
      }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });

    const approvedView = await app.service.approve({
      ...ctx,
      caseId,
      proposalId: proposal.id,
      digest: proposal.digest,
      statement: 'Approve return',
    });
    expect(approvedView.case.state).toBe('ready_to_submit');
    expect(approvedView.lifecycle.stage).toBe('approved');

    // Seeded script: the first submission is created at the retailer but the response is lost.
    const unknown = await app.service.execute({ ...ctx, caseId, proposalId: proposal.id });
    expect(unknown.case.state).toBe('needs_reconciliation');
    expect(unknown.operations[0]?.status).toBe('outcome_unknown');
    expect(unknown.lifecycle.stage).toBe('outcome_unknown');
    expect(app.sandbox.listReturns()).toHaveLength(1);

    await expect(
      app.service.execute({ ...ctx, caseId, proposalId: proposal.id }),
    ).rejects.toMatchObject({ code: 'reconciliation_required' });
    expect(app.sandbox.listReturns()).toHaveLength(1);

    const reconciled = await app.service.checkOutcome({ ...ctx, caseId });
    expect(reconciled.case.state).toBe('awaiting_verification');
    expect(reconciled.operations[0]).toMatchObject({
      status: 'accepted',
      externalRef: 'KG-RMA-30417',
    });
    expect(reconciled.lifecycle.stage).toBe('submitted');

    const confirmed = await app.service.checkOutcome({ ...ctx, caseId });
    expect(confirmed.case.state).toBe('resolved');
    expect(confirmed.lifecycle.stage).toBe('confirmed');
    expect(confirmed.messages.at(-1)?.text).toMatch(/Your return is confirmed/);
    expect(app.sandbox.listReturns()).toHaveLength(1);

    // Restart: a new process over the same database file sees the same case.
    app.close();
    app = open();
    const resumed = app.service.getCase(caseId, CUSTOMER);
    expect(resumed.case.state).toBe('resolved');
    expect(resumed.events.map((e) => e.type)).toEqual(confirmed.events.map((e) => e.type));
    expect(resumed.approvals).toHaveLength(1);
    expect(resumed.attempts.map((a) => a.kind)).toEqual(['submit', 'reconcile', 'verify']);
    expect(app.service.listCases(CUSTOMER)[0]).toMatchObject({ id: caseId, state: 'resolved' });
  });

  it('explains ineligibility for the older pair and never prepares an action', async () => {
    const opened = await app.service.openCase({ ...ctx, utterance: FLAGSHIP });
    const view = await app.service.provideSerial({
      ...ctx,
      caseId: opened.case.id,
      serialNumber: 'HA-7Q2-0193',
    });
    expect(view.case.state).toBe('not_eligible');
    expect(view.proposals).toHaveLength(0);
    expect(view.messages.at(-1)?.text).toMatch(/closed on August 30/);
  });

  it('extracts a serial number typed in conversation', async () => {
    const opened = await app.service.openCase({ ...ctx, utterance: FLAGSHIP });
    const view = await app.service.sendMessage({
      ...ctx,
      caseId: opened.case.id,
      utterance: 'The serial is HA-7Q2-4471',
    });
    expect(view.case.state).toBe('awaiting_approval');
  });
});

describe('execution safety', () => {
  it('retries a definite failure under the same idempotency key and creates one return', async () => {
    const view = await approved();
    app.demo.scriptNextSubmission('unavailable', view.case.id);
    const p = liveProposal(view);
    const failed = await app.service.execute({ ...ctx, caseId: view.case.id, proposalId: p.id });
    expect(failed.case.state).toBe('ready_to_submit');
    expect(failed.operations[0]?.status).toBe('failed');
    expect(app.sandbox.listReturns()).toHaveLength(0);

    const retried = await app.service.execute({ ...ctx, caseId: view.case.id, proposalId: p.id });
    expect(retried.operations[0]).toMatchObject({ status: 'accepted', attempts: 2 });
    expect(
      new Set(
        app.sandbox
          .requestLog()
          .filter((r) => r.operation === 'create_return')
          .map((r) => r.requestKey),
      ).size,
    ).toBe(1);
    expect(app.sandbox.listReturns()).toHaveLength(1);
  });

  it('reconciles a request lost before processing as not executed, then retries safely', async () => {
    const view = await approved();
    app.demo.scriptNextSubmission('timeout_before_commit', view.case.id);
    const p = liveProposal(view);
    await app.service.execute({ ...ctx, caseId: view.case.id, proposalId: p.id });
    const reconciled = await app.service.checkOutcome({ ...ctx, caseId: view.case.id });
    expect(reconciled.operations[0]?.status).toBe('failed');
    expect(reconciled.case.state).toBe('ready_to_submit');
    await app.service.execute({ ...ctx, caseId: view.case.id, proposalId: p.id });
    await app.service.checkOutcome({ ...ctx, caseId: view.case.id });
    const done = await app.service.checkOutcome({ ...ctx, caseId: view.case.id });
    expect(done.case.state).toBe('resolved');
    expect(app.sandbox.listReturns()).toHaveLength(1);
  });

  it('escalates a retailer refusal instead of retrying', async () => {
    const view = await approved();
    app.demo.scriptNextSubmission('reject', view.case.id);
    const p = liveProposal(view);
    const refused = await app.service.execute({ ...ctx, caseId: view.case.id, proposalId: p.id });
    expect(refused.case.state).toBe('needs_review');
    expect(refused.lifecycle.stage).toBe('refused');
    const requests = app.sandbox.requestLog().length;
    await expect(
      app.service.execute({ ...ctx, caseId: view.case.id, proposalId: p.id }),
    ).rejects.toMatchObject({ code: 'proposal_not_current' });
    expect(app.sandbox.requestLog()).toHaveLength(requests);
    expect(app.sandbox.listReturns()).toHaveLength(0);
  });

  it('blocks a second submission once one was accepted', async () => {
    const view = await approved();
    app.demo.scriptNextSubmission('accept', view.case.id);
    const p = liveProposal(view);
    await app.service.execute({ ...ctx, caseId: view.case.id, proposalId: p.id });
    await expect(
      app.service.execute({ ...ctx, caseId: view.case.id, proposalId: p.id }),
    ).rejects.toMatchObject({ code: 'duplicate_operation' });
    expect(app.sandbox.listReturns()).toHaveLength(1);
  });

  it('moves a submission interrupted by a restart to reconciliation', async () => {
    const view = await approved();
    const p = liveProposal(view);
    // Simulate a crash after the write-ahead record and before the retailer answered.
    app.repo.transaction(() => {
      const c = app.repo.getCase(view.case.id);
      if (!c) throw new Error('missing case');
      app.repo.insertOperation({
        id: 'op_crash',
        caseId: c.id,
        proposalId: p.id,
        idempotencyKey: `aftercare:${c.id}:${p.id}`,
        status: 'submitting',
        attempts: 1,
        externalRef: null,
        lastError: null,
        observed: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      app.repo.updateCase(c.id, c.version, { state: 'executing' }, new Date().toISOString());
    });
    app.close();
    app = open();
    expect(await app.recoverInterrupted()).toEqual([view.case.id]);
    const recovered = app.service.getCase(view.case.id, CUSTOMER);
    expect(recovered.case.state).toBe('needs_reconciliation');
    const reconciled = await app.service.checkOutcome({ ...ctx, caseId: view.case.id });
    expect(reconciled.operations[0]?.status).toBe('failed');
    expect(reconciled.case.state).toBe('ready_to_submit');
  });

  it('invalidates an approval when the evidence behind it changes', async () => {
    const view = await approved();
    const old = liveProposal(view);
    const changed = await app.service.sendMessage({
      ...ctx,
      caseId: view.case.id,
      utterance: 'Actually nothing is wrong with them, I changed my mind.',
    });
    expect(changed.proposals.find((p) => p.id === old.id)?.status).toBe('superseded');
    expect(changed.case.state).toBe('awaiting_approval');
    const requests = app.sandbox.requestLog().length;
    await expect(
      app.service.execute({ ...ctx, caseId: view.case.id, proposalId: old.id }),
    ).rejects.toMatchObject({ code: 'proposal_not_current' });
    await expect(
      app.service.approve({
        ...ctx,
        caseId: view.case.id,
        proposalId: old.id,
        digest: old.digest,
        statement: 'ok',
      }),
    ).rejects.toMatchObject({ code: 'proposal_not_current' });
    expect(app.sandbox.requestLog()).toHaveLength(requests);
    expect(liveProposal(changed).parameters.returnShipping).toBe('customer_paid');
  });
});

describe('access, conflicts and reset', () => {
  it('does not reveal another customer’s case', async () => {
    const opened = await app.service.openCase({ ...ctx, utterance: FLAGSHIP });
    expect(() => app.service.getCase(opened.case.id, 'cus_someone_else')).toThrow(/No such case/);
    await expect(
      app.service.sendMessage({
        customerRef: 'cus_someone_else',
        channel: 'assistant_surface',
        caseId: opened.case.id,
        utterance: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('records an immaterial carrier conflict and a third-party claim without changing the decision', async () => {
    const view = await toApproval();
    const conflicted = await app.demo.injectCarrierConflict(view.case.id);
    expect(conflicted.assessment?.conflicts.some((c) => c.kind === 'immaterial')).toBe(true);
    expect(conflicted.case.state).toBe('awaiting_approval');
    const claimed = await app.demo.injectThirdPartyClaim(view.case.id);
    expect(claimed.assessment?.conflicts.some((c) => c.kind === 'inadmissible')).toBe(true);
    expect(liveProposal(claimed).parameters.returnBy).toBe('2026-10-30');
  });

  it('reset removes demo cases and reseeds the retailer, leaving other customers alone', async () => {
    await approved();
    app.repo.transaction(() =>
      app.repo.insertCase({
        id: 'case_other',
        customerRef: 'cus_other',
        state: 'open',
        goal: { type: 'return', productQuery: null },
        asOf: '2026-10-17',
        title: 'Other',
        version: 0,
        createdAt: '2026-10-17T00:00:00Z',
        updatedAt: '2026-10-17T00:00:00Z',
      }),
    );
    const { removedCases } = app.demo.reset();
    expect(removedCases).toBe(1);
    expect(app.service.listCases(CUSTOMER)).toHaveLength(0);
    expect(app.repo.getCase('case_other')).not.toBeNull();
    expect(app.sandbox.listReturns()).toHaveLength(0);
    expect(app.sandbox.listQueue()).toEqual([
      { operation: 'create_return', outcome: 'timeout_after_commit', note: expect.any(String) },
    ]);
  });
});

describe('outcomes that are neither success nor refusal', () => {
  it('reports a return on different terms as a mismatch, never as refused or confirmed', async () => {
    const view = await approved();
    app.demo.scriptNextSubmission('accept_with_fee', view.case.id);
    const p = liveProposal(view);
    const submitted = await app.service.execute({ ...ctx, caseId: view.case.id, proposalId: p.id });
    expect(submitted.lifecycle.stage).toBe('submitted');
    const checked = await app.service.checkOutcome({ ...ctx, caseId: view.case.id });
    expect(checked.operations[0]?.status).toBe('mismatch');
    expect(checked.lifecycle.stage).toBe('mismatch');
    expect(checked.case.state).toBe('needs_review');
    expect(checked.assessment?.blockers.map((b) => b.code)).toContain('outcome_mismatch');
    expect(checked.messages.at(-1)?.text).toMatch(/doesn’t match what you approved/);
    expect(checked.messages.at(-1)?.text).not.toMatch(/declined/);
    await expect(
      app.service.execute({ ...ctx, caseId: view.case.id, proposalId: p.id }),
    ).rejects.toMatchObject({ code: 'duplicate_operation' });
    expect(app.sandbox.listReturns()).toHaveLength(1);
  });

  it('keeps an outcome unknown when the lookup itself times out', async () => {
    const view = await approved();
    const p = liveProposal(view);
    await app.service.execute({ ...ctx, caseId: view.case.id, proposalId: p.id }); // seeded: timeout after commit
    app.sandbox.queueOutcome('lookup', 'timeout', null);
    const inconclusive = await app.service.checkOutcome({ ...ctx, caseId: view.case.id });
    expect(inconclusive.operations[0]?.status).toBe('outcome_unknown');
    expect(inconclusive.case.state).toBe('needs_reconciliation');
    expect(inconclusive.events.some((e) => e.type === 'reconciliation.inconclusive')).toBe(true);
    await expect(
      app.service.execute({ ...ctx, caseId: view.case.id, proposalId: p.id }),
    ).rejects.toMatchObject({ code: 'reconciliation_required' });
  });

  it('serializes concurrent submissions so only one reaches the retailer', async () => {
    const view = await approved();
    app.demo.scriptNextSubmission('accept', view.case.id);
    const p = liveProposal(view);
    const results = await Promise.allSettled([
      app.service.execute({ ...ctx, caseId: view.case.id, proposalId: p.id }),
      app.service.execute({ ...ctx, caseId: view.case.id, proposalId: p.id }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'duplicate_operation' },
    });
    expect(app.sandbox.requestLog().filter((r) => r.operation === 'create_return')).toHaveLength(1);
  });
});

describe('declining and cancelling', () => {
  it('closes the case when the customer declines, and nothing is submitted', async () => {
    const view = await toApproval();
    const p = liveProposal(view);
    const declined = await app.service.decline({ ...ctx, caseId: view.case.id, proposalId: p.id });
    expect(declined.case.state).toBe('closed');
    expect(declined.proposals[0]?.status).toBe('declined');
    expect(app.sandbox.requestLog().some((r) => r.operation === 'create_return')).toBe(false);
  });

  it('closes on an explicit request, but not when the customer describes a fault', async () => {
    const view = await toApproval();
    const fault = await app.service.sendMessage({
      ...ctx,
      caseId: view.case.id,
      utterance: 'They just stop working after a few minutes.',
    });
    expect(fault.case.state).toBe('awaiting_approval');
    const closed = await app.service.sendMessage({
      ...ctx,
      caseId: view.case.id,
      utterance: 'Never mind, please cancel my return.',
    });
    expect(closed.case.state).toBe('closed');
  });
});
