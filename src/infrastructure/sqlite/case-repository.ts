import type { SQLInputValue } from 'node:sqlite';
import {
  ApprovalSchema,
  OperationSchema,
  ProposalSchema,
  type Approval,
  type Operation,
  type Proposal,
} from '../../domain/actions.js';
import { AssessmentSchema } from '../../domain/assessment.js';
import { CaseRecordSchema, type CaseRecord } from '../../domain/case.js';
import { DomainError } from '../../domain/errors.js';
import { EvidenceSchema, type Evidence } from '../../domain/evidence.js';
import type {
  AssessmentRecord,
  AttemptRecord,
  CaseRepository,
  CaseUpdate,
  EventRecord,
  MessageRecord,
  NewEvent,
} from '../../application/repository.js';
import type { Database } from './database.js';

type Row = Record<string, SQLInputValue>;

const json = (value: unknown): string => JSON.stringify(value);
const parse = <T>(value: SQLInputValue): T => JSON.parse(String(value)) as T;
const nullable = (value: SQLInputValue): string | null => (value === null ? null : String(value));

export class SqliteCaseRepository implements CaseRepository {
  constructor(private readonly db: Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.sql.prepare(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.sql.prepare(sql).get(...params) as Row | undefined;
  }

  private exec(sql: string, ...params: SQLInputValue[]) {
    return this.db.sql.prepare(sql).run(...params);
  }

  // ---- cases ---------------------------------------------------------------
  insertCase(c: CaseRecord): void {
    this.exec(
      `INSERT INTO cases (id, customer_ref, state, goal_type, product_query, as_of, title, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.id,
      c.customerRef,
      c.state,
      c.goal.type,
      c.goal.productQuery,
      c.asOf,
      c.title,
      c.version,
      c.createdAt,
      c.updatedAt,
    );
  }

  private toCase(row: Row): CaseRecord {
    return CaseRecordSchema.parse({
      id: row['id'],
      customerRef: row['customer_ref'],
      state: row['state'],
      goal: { type: row['goal_type'], productQuery: nullable(row['product_query'] ?? null) },
      asOf: row['as_of'],
      title: row['title'],
      version: Number(row['version']),
      createdAt: row['created_at'],
      updatedAt: row['updated_at'],
    });
  }

  getCase(id: string): CaseRecord | null {
    const row = this.get('SELECT * FROM cases WHERE id = ?', id);
    return row ? this.toCase(row) : null;
  }

  listCases(customerRef: string): CaseRecord[] {
    return this.all(
      'SELECT * FROM cases WHERE customer_ref = ? ORDER BY updated_at DESC',
      customerRef,
    ).map((r) => this.toCase(r));
  }

  listCaseIdsInState(state: CaseRecord['state']): string[] {
    return this.all('SELECT id FROM cases WHERE state = ?', state).map((r) => String(r['id']));
  }

  updateCase(id: string, expectedVersion: number, update: CaseUpdate, at: string): CaseRecord {
    const current = this.getCase(id);
    if (!current) throw new DomainError('not_found', `Case ${id} does not exist.`);
    const next: CaseRecord = {
      ...current,
      ...(update.state ? { state: update.state } : {}),
      ...(update.title ? { title: update.title } : {}),
      ...(update.goal ? { goal: update.goal } : {}),
      version: expectedVersion + 1,
      updatedAt: at,
    };
    const result = this.exec(
      `UPDATE cases SET state = ?, title = ?, goal_type = ?, product_query = ?, version = ?, updated_at = ?
       WHERE id = ? AND version = ?`,
      next.state,
      next.title,
      next.goal.type,
      next.goal.productQuery,
      next.version,
      at,
      id,
      expectedVersion,
    );
    if (Number(result.changes) !== 1) {
      throw new DomainError(
        'conflict',
        `Case ${id} changed since it was read (expected version ${expectedVersion}).`,
      );
    }
    return next;
  }

  // ---- messages ------------------------------------------------------------
  insertMessage(m: MessageRecord): void {
    this.exec(
      `INSERT INTO messages (id, case_id, role, text, channel, interpretation_json, assessment_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      m.id,
      m.caseId,
      m.role,
      m.text,
      m.channel,
      m.interpretation ? json(m.interpretation) : null,
      m.assessmentId,
      m.createdAt,
    );
  }

  listMessages(caseId: string): MessageRecord[] {
    return this.all(
      'SELECT * FROM messages WHERE case_id = ? ORDER BY created_at, rowid',
      caseId,
    ).map((r) => ({
      id: String(r['id']),
      caseId: String(r['case_id']),
      role: r['role'] as MessageRecord['role'],
      text: String(r['text']),
      channel: r['channel'] as MessageRecord['channel'],
      interpretation: r['interpretation_json'] ? parse(r['interpretation_json']) : null,
      assessmentId: nullable(r['assessment_id'] ?? null),
      createdAt: String(r['created_at']),
    }));
  }

  // ---- evidence ------------------------------------------------------------
  insertEvidence(e: Evidence): void {
    const seq = Number(
      this.get(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM evidence WHERE case_id = ?',
        e.caseId,
      )?.['next'] ?? 1,
    );
    this.exec(
      `INSERT INTO evidence (id, case_id, seq, kind, title, source_type, source_name, source_reference, simulated,
         observed_at, verification, status, facts_json, policy_json, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.id,
      e.caseId,
      seq,
      e.kind,
      e.title,
      e.source.type,
      e.source.name,
      e.source.reference,
      e.simulated ? 1 : 0,
      e.observedAt,
      e.verification,
      e.status,
      json(e.facts),
      e.policy ? json(e.policy) : null,
      e.note,
    );
  }

  listEvidence(caseId: string): Evidence[] {
    return this.all('SELECT * FROM evidence WHERE case_id = ? ORDER BY seq', caseId).map((r) =>
      EvidenceSchema.parse({
        id: r['id'],
        caseId: r['case_id'],
        kind: r['kind'],
        title: r['title'],
        source: {
          type: r['source_type'],
          name: r['source_name'],
          reference: nullable(r['source_reference'] ?? null),
        },
        simulated: Number(r['simulated']) === 1,
        observedAt: r['observed_at'],
        verification: r['verification'],
        status: r['status'],
        facts: parse(r['facts_json'] ?? '[]'),
        policy: r['policy_json'] ? parse(r['policy_json']) : null,
        note: nullable(r['note'] ?? null),
      }),
    );
  }

  // ---- assessments ---------------------------------------------------------
  insertAssessment(a: AssessmentRecord): void {
    this.exec(
      `INSERT INTO assessments (id, case_id, case_version, compiler_version, next_step, next_state, body_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id,
      a.caseId,
      a.body.caseVersion,
      a.body.compilerVersion,
      a.body.nextStep.kind,
      a.body.nextCaseState,
      json(a.body),
      a.createdAt,
    );
  }

  private toAssessment(r: Row): AssessmentRecord {
    return {
      id: String(r['id']),
      caseId: String(r['case_id']),
      createdAt: String(r['created_at']),
      body: AssessmentSchema.parse(parse(r['body_json'] ?? '{}')),
    };
  }

  latestAssessment(caseId: string): AssessmentRecord | null {
    const row = this.get(
      'SELECT * FROM assessments WHERE case_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      caseId,
    );
    return row ? this.toAssessment(row) : null;
  }

  listAssessments(caseId: string): AssessmentRecord[] {
    return this.all(
      'SELECT * FROM assessments WHERE case_id = ? ORDER BY created_at, rowid',
      caseId,
    ).map((r) => this.toAssessment(r));
  }

  // ---- proposals and approvals --------------------------------------------
  insertProposal(p: Proposal): void {
    this.exec(
      `INSERT INTO proposals (id, case_id, assessment_id, action_type, parameters_json, digest, preconditions_json,
         postconditions_json, verification_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id,
      p.caseId,
      p.assessmentId,
      p.actionType,
      json(p.parameters),
      p.digest,
      json(p.preconditions),
      json(p.postconditions),
      json(p.verification),
      p.status,
      p.createdAt,
      p.updatedAt,
    );
  }

  updateProposalStatus(id: string, status: Proposal['status'], at: string): void {
    this.exec('UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?', status, at, id);
  }

  listProposals(caseId: string): Proposal[] {
    return this.all(
      'SELECT * FROM proposals WHERE case_id = ? ORDER BY created_at, rowid',
      caseId,
    ).map((r) =>
      ProposalSchema.parse({
        id: r['id'],
        caseId: r['case_id'],
        actionType: r['action_type'],
        parameters: parse(r['parameters_json'] ?? '{}'),
        digest: r['digest'],
        preconditions: parse(r['preconditions_json'] ?? '[]'),
        postconditions: parse(r['postconditions_json'] ?? '[]'),
        verification: parse(r['verification_json'] ?? '[]'),
        requiresApproval: true,
        status: r['status'],
        assessmentId: r['assessment_id'],
        createdAt: r['created_at'],
        updatedAt: r['updated_at'],
      }),
    );
  }

  insertApproval(a: Approval): void {
    this.exec(
      `INSERT INTO approvals (id, proposal_id, case_id, digest, approved_by, channel, statement, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id,
      a.proposalId,
      a.caseId,
      a.digest,
      a.approvedBy,
      a.channel,
      a.statement,
      a.approvedAt,
    );
  }

  listApprovals(caseId: string): Approval[] {
    return this.all(
      'SELECT * FROM approvals WHERE case_id = ? ORDER BY approved_at, rowid',
      caseId,
    ).map((r) =>
      ApprovalSchema.parse({
        id: r['id'],
        proposalId: r['proposal_id'],
        caseId: r['case_id'],
        digest: r['digest'],
        approvedBy: r['approved_by'],
        channel: r['channel'],
        statement: r['statement'],
        approvedAt: r['approved_at'],
      }),
    );
  }

  // ---- operations ----------------------------------------------------------
  insertOperation(o: Operation): void {
    this.exec(
      `INSERT INTO operations (id, case_id, proposal_id, idempotency_key, status, attempts, external_ref, last_error,
         observed_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      o.id,
      o.caseId,
      o.proposalId,
      o.idempotencyKey,
      o.status,
      o.attempts,
      o.externalRef,
      o.lastError,
      o.observed ? json(o.observed) : null,
      o.createdAt,
      o.updatedAt,
    );
  }

  updateOperation(o: Operation): void {
    this.exec(
      `UPDATE operations SET status = ?, attempts = ?, external_ref = ?, last_error = ?, observed_json = ?, updated_at = ?
       WHERE id = ?`,
      o.status,
      o.attempts,
      o.externalRef,
      o.lastError,
      o.observed ? json(o.observed) : null,
      o.updatedAt,
      o.id,
    );
  }

  listOperations(caseId: string): Operation[] {
    return this.all(
      'SELECT * FROM operations WHERE case_id = ? ORDER BY created_at, rowid',
      caseId,
    ).map((r) =>
      OperationSchema.parse({
        id: r['id'],
        caseId: r['case_id'],
        proposalId: r['proposal_id'],
        idempotencyKey: r['idempotency_key'],
        status: r['status'],
        attempts: Number(r['attempts']),
        externalRef: nullable(r['external_ref'] ?? null),
        lastError: nullable(r['last_error'] ?? null),
        observed: r['observed_json'] ? parse(r['observed_json']) : null,
        createdAt: r['created_at'],
        updatedAt: r['updated_at'],
      }),
    );
  }

  insertAttempt(a: AttemptRecord): void {
    this.exec(
      `INSERT INTO operation_attempts (id, operation_id, kind, outcome, detail, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      a.id,
      a.operationId,
      a.kind,
      a.outcome,
      a.detail,
      a.startedAt,
      a.finishedAt,
    );
  }

  listAttempts(caseId: string): AttemptRecord[] {
    return this.all(
      `SELECT a.* FROM operation_attempts a JOIN operations o ON o.id = a.operation_id
       WHERE o.case_id = ? ORDER BY a.started_at, a.rowid`,
      caseId,
    ).map((r) => ({
      id: String(r['id']),
      operationId: String(r['operation_id']),
      kind: r['kind'] as AttemptRecord['kind'],
      outcome: String(r['outcome']),
      detail: nullable(r['detail'] ?? null),
      startedAt: String(r['started_at']),
      finishedAt: String(r['finished_at']),
    }));
  }

  // ---- events --------------------------------------------------------------
  appendEvent(e: NewEvent, at: string): EventRecord {
    const seq = Number(
      this.get(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE case_id = ?',
        e.caseId,
      )?.['next'] ?? 1,
    );
    const result = this.exec(
      'INSERT INTO events (case_id, seq, type, actor, summary, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      e.caseId,
      seq,
      e.type,
      e.actor,
      e.summary,
      e.data ? json(e.data) : null,
      at,
    );
    return { ...e, id: Number(result.lastInsertRowid), seq, data: e.data ?? null, createdAt: at };
  }

  listEvents(caseId: string): EventRecord[] {
    return this.all('SELECT * FROM events WHERE case_id = ? ORDER BY seq', caseId).map((r) => ({
      id: Number(r['id']),
      caseId: String(r['case_id']),
      seq: Number(r['seq']),
      type: String(r['type']),
      actor: r['actor'] as EventRecord['actor'],
      summary: String(r['summary']),
      data: r['data_json'] ? parse(r['data_json']) : null,
      createdAt: String(r['created_at']),
    }));
  }

  deleteCasesForCustomer(customerRef: string): number {
    const ids = this.all('SELECT id FROM cases WHERE customer_ref = ?', customerRef).map((r) =>
      String(r['id']),
    );
    for (const id of ids) {
      // Children without ON DELETE CASCADE from cases are removed explicitly, in dependency order.
      this.exec(
        'DELETE FROM operation_attempts WHERE operation_id IN (SELECT id FROM operations WHERE case_id = ?)',
        id,
      );
      this.exec('DELETE FROM operations WHERE case_id = ?', id);
      this.exec('DELETE FROM approvals WHERE case_id = ?', id);
      this.exec('DELETE FROM proposals WHERE case_id = ?', id);
      this.exec('DELETE FROM cases WHERE id = ?', id);
    }
    return ids.length;
  }
}
