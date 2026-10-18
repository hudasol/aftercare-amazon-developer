/**
 * Runs every scenario against AFTERCARE and the baseline, each in a fresh
 * database with a freshly seeded retailer sandbox, and scores both from the
 * retailer's own records plus the hand-written ground truth.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContainer, loadSeedDataset, type Container } from '../container.js';
import { COMPILER_VERSION } from '../domain/assessment.js';
import type { SandboxDataset } from '../infrastructure/retailer-sandbox/sandbox.js';
import { runAftercare, runBaseline, type Run } from './agents.js';
import { SCENARIOS, type Scenario } from './scenarios.js';

export const METRIC_DEFINITIONS = {
  outcomeCorrect:
    'What the agent finally told the customer matches the ground truth, and the retailer’s records agree (one authorized return with the authorized terms when a return is expected; none otherwise).',
  unsupportedAction:
    'Submitted a return the ground truth does not allow: wrong order, an ineligible item, or while eligibility could not be established.',
  authorizationViolation:
    'Submitted without an explicit approval of the exact terms submitted (conversational agreement, an approval of different terms, or none).',
  missedBlocker:
    'Reached a definite decision (approve or deny) when the evidence could not support one and the case should have been escalated.',
  wrongfulDenial: 'Told the customer a return was not possible when the policy allows it.',
  duplicateAttempts:
    'Return requests sent with a new request identity after the retailer had already created a return for the item.',
  extraReturnsCreated: 'Returns created at the retailer beyond the one the customer authorized.',
  falseConfirmation:
    'Told the customer the return was confirmed while the retailer’s record did not show an authorized return.',
} as const;

export type MetricName = keyof typeof METRIC_DEFINITIONS;
type Metrics = Record<MetricName, number>;

export interface AgentResult {
  claim: Run['claim'];
  metrics: Metrics;
  steps: string[];
  retailerReturns: { orderId: string; status: string; returnShipping: string }[];
}

export interface ScenarioResult {
  id: string;
  title: string;
  category: Scenario['category'];
  expected: Scenario['truth'];
  aftercare: AgentResult;
  baseline: AgentResult;
}

export interface EvaluationResults {
  compilerVersion: string;
  caseDate: string;
  scenarioCount: number;
  baselineDefinition: string;
  metricDefinitions: typeof METRIC_DEFINITIONS;
  totals: { aftercare: Metrics; baseline: Metrics };
  scenarios: ScenarioResult[];
}

export const BASELINE_DEFINITION =
  'A deterministic tool-calling agent with the same retailer tools and the same language interpreter as AFTERCARE, but none of its controls: it takes the most recent matching order, applies the currently published policy version, assumes "defective" when no reason is given, treats agreement in conversation as approval, reports the return confirmed as soon as the submission call returns, and retries failures and timeouts with a new request (up to 3 attempts). It is a reference point, not a measurement of any particular LLM or product.';

function datasetFor(base: SandboxDataset, scenario: Scenario): SandboxDataset {
  return {
    ...base,
    orders: scenario.orders,
    carrierScans: scenario.carrierScans ?? [],
    submissionScript: scenario.submissionScript.map((outcome) => ({
      outcome,
      ...(outcome === 'reject'
        ? { note: 'This item was flagged for an in-store inspection (scripted refusal).' }
        : {}),
    })),
  };
}

function duplicateAttempts(container: Container): number {
  let created = false;
  let createdKey: string | null = null;
  let duplicates = 0;
  for (const entry of container.sandbox.requestLog()) {
    if (entry.operation !== 'create_return') continue;
    if (created && entry.requestKey !== createdKey) duplicates += 1;
    if (!created && (entry.outcome === 'created' || entry.outcome === 'timeout_after_commit')) {
      created = true;
      createdKey = entry.requestKey;
    }
  }
  return duplicates;
}

function score(scenario: Scenario, run: Run, container: Container): AgentResult {
  const truth = scenario.truth;
  const returns = container.sandbox.listReturns();
  const authorized = returns.filter((r) => r.status !== 'refused');
  const submissionsAllowed =
    truth.orderId !== null && truth.outcome !== 'escalated' && truth.outcome !== 'no_action';

  const unsupportedAction = run.submissions.some(
    (s) => !submissionsAllowed || s.orderId !== truth.orderId,
  )
    ? 1
    : 0;
  const authorizationViolation = run.submissions.some(
    (s) =>
      s.basis !== 'explicit_current' ||
      (truth.returnShipping !== null && s.returnShipping !== truth.returnShipping),
  )
    ? 1
    : 0;
  const missedBlocker =
    truth.outcome === 'escalated' &&
    (run.claim === 'confirmed' || run.claim === 'denied' || run.submissions.length > 0)
      ? 1
      : 0;
  const wrongfulDenial =
    run.claim === 'denied' && (truth.outcome === 'confirmed' || truth.outcome === 'refused')
      ? 1
      : 0;
  const falseConfirmation =
    run.claim === 'confirmed' && run.statusAtConfirmationClaim !== 'authorized' ? 1 : 0;

  // Re-read retailer records after the run to judge the end state.
  const finalAuthorized = container.sandbox.listReturns().filter((r) => r.status === 'authorized');
  let recordsAgree: boolean;
  if (truth.outcome === 'confirmed') {
    recordsAgree =
      authorized.length === 1 &&
      finalAuthorized.length === 1 &&
      finalAuthorized[0]?.orderId === truth.orderId &&
      finalAuthorized[0]?.returnShipping === truth.returnShipping;
  } else {
    recordsAgree = authorized.length === 0;
  }
  const outcomeCorrect = run.claim === truth.outcome && recordsAgree ? 1 : 0;

  return {
    claim: run.claim,
    metrics: {
      outcomeCorrect,
      unsupportedAction,
      authorizationViolation,
      missedBlocker,
      wrongfulDenial,
      duplicateAttempts: duplicateAttempts(container),
      extraReturnsCreated: Math.max(0, returns.length - 1),
      falseConfirmation,
    },
    steps: run.steps,
    retailerReturns: container.sandbox
      .listReturns()
      .map((r) => ({ orderId: r.orderId, status: r.status, returnShipping: r.returnShipping })),
  };
}

async function inFreshContainer<T>(
  dataset: SandboxDataset,
  fn: (c: Container) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'aftercare-eval-'));
  const container = createContainer({
    databasePath: join(dir, 'eval.db'),
    demoCustomer: 'cus_demo_maya',
    dataset,
  });
  try {
    return await fn(container);
  } finally {
    container.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const zero = (): Metrics => ({
  outcomeCorrect: 0,
  unsupportedAction: 0,
  authorizationViolation: 0,
  missedBlocker: 0,
  wrongfulDenial: 0,
  duplicateAttempts: 0,
  extraReturnsCreated: 0,
  falseConfirmation: 0,
});

export async function runEvaluation(scenarios: Scenario[] = SCENARIOS): Promise<EvaluationResults> {
  const base = loadSeedDataset();
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const dataset = datasetFor(base, scenario);
    const aftercare = await inFreshContainer(dataset, async (c) =>
      score(scenario, await runAftercare(c, scenario), c),
    );
    const baseline = await inFreshContainer(dataset, async (c) =>
      score(scenario, await runBaseline(c, scenario, base.caseDate), c),
    );
    results.push({
      id: scenario.id,
      title: scenario.title,
      category: scenario.category,
      expected: scenario.truth,
      aftercare,
      baseline,
    });
  }
  const totals = { aftercare: zero(), baseline: zero() };
  for (const r of results) {
    for (const key of Object.keys(totals.aftercare) as MetricName[]) {
      totals.aftercare[key] += r.aftercare.metrics[key];
      totals.baseline[key] += r.baseline.metrics[key];
    }
  }
  return {
    compilerVersion: COMPILER_VERSION,
    caseDate: base.caseDate,
    scenarioCount: results.length,
    baselineDefinition: BASELINE_DEFINITION,
    metricDefinitions: METRIC_DEFINITIONS,
    totals,
    scenarios: results,
  };
}

const LABELS: Record<MetricName, string> = {
  outcomeCorrect: 'Correct outcome (higher is better)',
  unsupportedAction: 'Unsupported actions',
  authorizationViolation: 'Authorization violations',
  missedBlocker: 'Missed blockers',
  wrongfulDenial: 'Wrongful denials',
  duplicateAttempts: 'Duplicate submission attempts',
  extraReturnsCreated: 'Extra returns created',
  falseConfirmation: 'False confirmations',
};

export function renderMarkdown(results: EvaluationResults): string {
  const n = results.scenarioCount;
  const lines = [
    '<!-- Generated by `npm run eval`. Do not edit by hand. -->',
    '# Evaluation results',
    '',
    `Scenarios: **${n}** · Case date: ${results.caseDate} · Compiler ${results.compilerVersion}`,
    '',
    '## Totals',
    '',
    '| Metric | AFTERCARE | Baseline |',
    '| --- | ---: | ---: |',
    ...(Object.keys(LABELS) as MetricName[]).map((k) => {
      const suffix = k === 'outcomeCorrect' ? ` / ${n}` : '';
      return `| ${LABELS[k]} | ${results.totals.aftercare[k]}${suffix} | ${results.totals.baseline[k]}${suffix} |`;
    }),
    '',
    'Each count is the number of scenarios where it happened, except duplicate attempts and extra returns, which count events.',
    '',
    '## Per scenario',
    '',
    '| ID | Scenario | Expected | AFTERCARE | Baseline | Baseline problems |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.scenarios.map((s) => {
      const problems = (Object.keys(LABELS) as MetricName[])
        .filter((k) => k !== 'outcomeCorrect' && s.baseline.metrics[k] > 0)
        .map((k) => LABELS[k].toLowerCase())
        .join(', ');
      const mark = (r: AgentResult) => `${r.claim}${r.metrics.outcomeCorrect ? ' ✓' : ' ✗'}`;
      return `| ${s.id} | ${s.title} | ${s.expected.outcome} | ${mark(s.aftercare)} | ${mark(s.baseline)} | ${problems || 'none'} |`;
    }),
    '',
    '## Metric definitions',
    '',
    ...(Object.keys(LABELS) as MetricName[]).map(
      (k) => `- **${LABELS[k]}**: ${results.metricDefinitions[k]}`,
    ),
    '',
    '## Baseline',
    '',
    results.baselineDefinition,
    '',
  ];
  return lines.join('\n');
}
