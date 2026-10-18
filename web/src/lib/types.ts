// Type-only re-exports: the web app renders server read models and never
// re-implements their rules.
export type {
  CaseView,
  CaseSummary,
  JourneyStage,
  JourneyStatus,
  ActionLifecycle,
  LifecycleStage,
} from '../../../src/application/views.js';
export type { EventRecord, MessageRecord } from '../../../src/application/repository.js';
export type { Assessment } from '../../../src/domain/assessment.js';
export type { Evidence } from '../../../src/domain/evidence.js';
export type { Proposal, Operation } from '../../../src/domain/actions.js';
export type { EvaluationResults, ScenarioResult } from '../../../src/evaluation/harness.js';

export interface Session {
  customerRef: string;
  customerName: string;
  caseDate: string;
  retailer: { name: string; simulated: boolean };
  mcp: { endpoint: string; protocolVersion: string; transport: string };
  interpreter: string;
}

export interface SandboxState {
  queue: { operation: string; outcome: string; note: string | null }[];
  requestLog: {
    at: string;
    operation: string;
    requestKey: string | null;
    outcome: string;
    detail: string | null;
  }[];
  returns: {
    rmaId: string;
    orderId: string;
    status: string;
    returnShipping: string;
    idempotencyKey: string;
    createdAt: string;
  }[];
  outcomes: { id: string; description: string }[];
}

/** Structured result returned by AFTERCARE's MCP case tools. */
export interface ToolCaseResult {
  caseId: string;
  state: string;
  stateLabel: string;
  headline: string;
  speech: string;
  message: string;
  nextStep: { kind: string; requiresApproval: boolean; rationale: string };
  lifecycle: { stage: string; label: string; detail: string };
}
