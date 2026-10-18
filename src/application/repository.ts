/**
 * Persistence contract for resolution cases. Methods are synchronous so a
 * use case can group several writes in one atomic `transaction` call.
 */
import type { Approval, Operation, Proposal } from '../domain/actions.js';
import type { Assessment } from '../domain/assessment.js';
import type { CaseRecord, CaseState, Goal } from '../domain/case.js';
import type { Evidence } from '../domain/evidence.js';
import type { Interpretation } from './ports.js';

export type Channel = 'assistant_surface' | 'mcp_client' | 'lab' | 'system';

export interface MessageRecord {
  id: string;
  caseId: string;
  role: 'customer' | 'assistant';
  text: string;
  channel: Channel;
  interpretation: (Interpretation & { interpreter: string }) | null;
  assessmentId: string | null;
  createdAt: string;
}

export interface AssessmentRecord {
  id: string;
  caseId: string;
  createdAt: string;
  body: Assessment;
}

export interface AttemptRecord {
  id: string;
  operationId: string;
  kind: 'submit' | 'reconcile' | 'verify';
  outcome: string;
  detail: string | null;
  startedAt: string;
  finishedAt: string;
}

export type EventActor = 'customer' | 'aftercare' | 'retailer' | 'demo_control' | 'mcp_client';

export interface NewEvent {
  caseId: string;
  type: string;
  actor: EventActor;
  summary: string;
  data?: Record<string, unknown>;
}

export interface EventRecord extends Omit<NewEvent, 'data'> {
  id: number;
  seq: number;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export interface CaseUpdate {
  state?: CaseState;
  title?: string;
  goal?: Goal;
}

export interface CaseRepository {
  transaction<T>(fn: () => T): T;

  insertCase(record: CaseRecord): void;
  getCase(id: string): CaseRecord | null;
  listCases(customerRef: string): CaseRecord[];
  /** IDs of cases in a given state, across customers (used for restart recovery). */
  listCaseIdsInState(state: CaseState): string[];
  /** Applies the update only if the stored version matches; bumps the version. */
  updateCase(id: string, expectedVersion: number, update: CaseUpdate, at: string): CaseRecord;

  insertMessage(message: MessageRecord): void;
  listMessages(caseId: string): MessageRecord[];

  insertEvidence(evidence: Evidence): void;
  listEvidence(caseId: string): Evidence[];

  insertAssessment(record: AssessmentRecord): void;
  latestAssessment(caseId: string): AssessmentRecord | null;
  listAssessments(caseId: string): AssessmentRecord[];

  insertProposal(proposal: Proposal): void;
  updateProposalStatus(id: string, status: Proposal['status'], at: string): void;
  listProposals(caseId: string): Proposal[];

  insertApproval(approval: Approval): void;
  listApprovals(caseId: string): Approval[];

  insertOperation(operation: Operation): void;
  updateOperation(operation: Operation): void;
  listOperations(caseId: string): Operation[];

  insertAttempt(attempt: AttemptRecord): void;
  listAttempts(caseId: string): AttemptRecord[];

  appendEvent(event: NewEvent, at: string): EventRecord;
  listEvents(caseId: string): EventRecord[];

  /** Removes every case owned by the customer (used by the demo reset only). */
  deleteCasesForCustomer(customerRef: string): number;
}
