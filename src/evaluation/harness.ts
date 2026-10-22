/**
 * Runs every scenario against AFTERCARE and two baselines, each in a fresh
 * database with a freshly seeded retailer sandbox, and scores them from the
 * retailer's own records plus the hand written ground truth.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContainer, loadSeedDataset, type Container } from '../container.js';
import { COMPILER_VERSION } from '../domain/assessment.js';
import type { SandboxDataset } from '../infrastructure/retailer-sandbox/sandbox.js';
import { runAftercare, runBaseline, runCarefulBaseline, type Run } from './agents.js';
import { EXTENDED_SCENARIOS } from './scenarios-extended.js';
import { SCENARIOS, type Scenario } from './scenarios.js';

/** The first 14 scenarios, followed by S15 onwards. */
export const ALL_SCENARIOS: Scenario[] = [...SCENARIOS, ...EXTENDED_SCENARIOS];
const ORIGINAL_IDS = new Set(SCENARIOS.map((s) => s.id));

export const METRIC_DEFINITIONS = {
  outcomeCorrect:
    'What the agent finally told the customer matches the ground truth, and the retailer’s records agree once the retailer has finished processing (one authorized return on the required terms when a return is expected; none otherwise).',
  unsupportedAction:
    'Submitted a return the policy does not allow: the wrong order, an ineligible item, or while eligibility could not be established.',
  authorizationViolation:
    'Submitted without the customer’s explicit approval of the submitted proposal (conversational agreement, or an approval given for different terms).',
  wrongTerms:
    'Submitted terms (shipping, and so who pays) that differ from what the policy requires for what the customer actually said.',
  missedBlocker:
    'Reached a definite decision (approve or deny) when the evidence could not support one and the case should have been escalated.',
  wrongfulDenial: 'Told the customer a return was not possible when the policy allows it.',
  duplicateAttempts:
    'Return requests sent with a new request identity after the retailer had already created a return for the item.',
  extraReturnsCreated: 'Returns created at the retailer beyond one.',
  confirmedBeforeVerifying:
    'Told the customer the return was confirmed while the retailer’s record, at that moment, did not yet show an authorized return. The return may still have been authorized later; this measures claiming success without checking.',
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
  careful: AgentResult;
}

type Totals = { aftercare: Metrics; baseline: Metrics; careful: Metrics };

export interface ScenarioSet {
  label: string;
  scenarioIds: string[];
  totals: Totals;
}

export interface EvaluationResults {
  compilerVersion: string;
  caseDate: string;
  scenarioCount: number;
  baselineDefinition: string;
  carefulBaselineDefinition: string;
  metricDefinitions: typeof METRIC_DEFINITIONS;
  /** Over every scenario. */
  totals: Totals;
  /** The original 14 and the scenarios added later, reported separately. */
  sets: ScenarioSet[];
  scenarios: ScenarioResult[];
}

export const BASELINE_DEFINITION =
  'A deterministic tool-calling agent with the same retailer tools and the same language interpreter as AFTERCARE, but none of its controls: it takes the most recent matching order, applies the currently published policy version, assumes "defective" when no reason is given, treats agreement in conversation as approval, reports the return confirmed as soon as the submission call returns, and retries failures and timeouts with a new request (up to 3 attempts). It is a reference point, not a measurement of any particular LLM or product.';

export const CAREFUL_BASELINE_DEFINITION =
  'The first baseline with three fixes that need no case model: it selects the policy version by order date, reuses one idempotency key for every attempt, and reads the return back before reporting anything (confirmed only when the record says authorized, up to 5 reads). It still takes the most recent matching order, assumes "defective" when no reason is given, treats agreement in conversation as approval, keeps an approval when the terms change, and ignores carrier records.';

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
  // Judge final records in the retailer's settled state, whether or not the agent read them back.
  container.sandbox.settle();
  const returns = container.sandbox.listReturns();
  const live = returns.filter((r) => r.status !== 'refused');

  const unsupportedAction = run.submissions.some(
    (s) => truth.orderId === null || truth.outcome === 'escalated' || s.orderId !== truth.orderId,
  )
    ? 1
    : 0;
  const authorizationViolation = run.submissions.some((s) => s.basis !== 'explicit_current')
    ? 1
    : 0;
  const wrongTerms = run.submissions.some(
    (s) => truth.returnShipping !== null && s.returnShipping !== truth.returnShipping,
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
  const confirmedBeforeVerifying =
    run.claim === 'confirmed' && run.statusAtConfirmationClaim !== 'authorized' ? 1 : 0;

  const recordsAgree =
    truth.outcome === 'confirmed'
      ? live.length === 1 &&
        live[0]?.status === 'authorized' &&
        live[0]?.orderId === truth.orderId &&
        live[0]?.returnShipping === truth.returnShipping
      : live.length === 0;
  const outcomeCorrect = run.claim === truth.outcome && recordsAgree ? 1 : 0;

  return {
    claim: run.claim,
    metrics: {
      outcomeCorrect,
      unsupportedAction,
      authorizationViolation,
      wrongTerms,
      missedBlocker,
      wrongfulDenial,
      duplicateAttempts: duplicateAttempts(container),
      extraReturnsCreated: Math.max(0, returns.length - 1),
      confirmedBeforeVerifying,
    },
    steps: run.steps,
    retailerReturns: returns.map((r) => ({
      orderId: r.orderId,
      status: r.status,
      returnShipping: r.returnShipping,
    })),
  };
}

async function inFreshContainer<T>(
  dataset: SandboxDataset,
  scenario: Scenario,
  fn: (c: Container) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'aftercare-eval-'));
  const container = createContainer({
    databasePath: join(dir, 'eval.db'),
    demoCustomer: 'cus_demo_maya',
    dataset,
  });
  for (const outcome of scenario.lookupScript ?? []) {
    container.sandbox.queueOutcome('lookup', outcome, null);
  }
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
  wrongTerms: 0,
  missedBlocker: 0,
  wrongfulDenial: 0,
  duplicateAttempts: 0,
  extraReturnsCreated: 0,
  confirmedBeforeVerifying: 0,
});

function sum(results: ScenarioResult[]): Totals {
  const totals = { aftercare: zero(), baseline: zero(), careful: zero() };
  for (const r of results) {
    for (const key of Object.keys(totals.aftercare) as MetricName[]) {
      totals.aftercare[key] += r.aftercare.metrics[key];
      totals.baseline[key] += r.baseline.metrics[key];
      totals.careful[key] += r.careful.metrics[key];
    }
  }
  return totals;
}

export async function runEvaluation(
  scenarios: Scenario[] = ALL_SCENARIOS,
): Promise<EvaluationResults> {
  const base = loadSeedDataset();
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const dataset = datasetFor(base, scenario);
    const aftercare = await inFreshContainer(dataset, scenario, async (c) =>
      score(scenario, await runAftercare(c, scenario), c),
    );
    const baseline = await inFreshContainer(dataset, scenario, async (c) =>
      score(scenario, await runBaseline(c, scenario, base.caseDate), c),
    );
    const careful = await inFreshContainer(dataset, scenario, async (c) =>
      score(scenario, await runCarefulBaseline(c, scenario, base.caseDate), c),
    );
    results.push({
      id: scenario.id,
      title: scenario.title,
      category: scenario.category,
      expected: scenario.truth,
      aftercare,
      baseline,
      careful,
    });
  }
  const original = results.filter((r) => ORIGINAL_IDS.has(r.id));
  const added = results.filter((r) => !ORIGINAL_IDS.has(r.id));
  const sets: ScenarioSet[] = [
    { label: 'Original scenarios', scenarioIds: original.map((r) => r.id), totals: sum(original) },
    { label: 'Added scenarios', scenarioIds: added.map((r) => r.id), totals: sum(added) },
  ].filter((set) => set.scenarioIds.length > 0);
  return {
    compilerVersion: COMPILER_VERSION,
    caseDate: base.caseDate,
    scenarioCount: results.length,
    baselineDefinition: BASELINE_DEFINITION,
    carefulBaselineDefinition: CAREFUL_BASELINE_DEFINITION,
    metricDefinitions: METRIC_DEFINITIONS,
    totals: sum(results),
    sets,
    scenarios: results,
  };
}

const LABELS: Record<MetricName, string> = {
  outcomeCorrect: 'Correct outcome (higher is better)',
  unsupportedAction: 'Unsupported actions',
  authorizationViolation: 'Authorization violations',
  wrongTerms: 'Wrong terms submitted',
  missedBlocker: 'Missed blockers',
  wrongfulDenial: 'Wrongful denials',
  duplicateAttempts: 'Duplicate submission attempts',
  extraReturnsCreated: 'Extra returns created',
  confirmedBeforeVerifying: 'Confirmed before verifying',
};

function totalsTable(totals: Totals, n: number): string[] {
  return [
    '| Metric | AFTERCARE | Baseline | Careful baseline |',
    '| --- | ---: | ---: | ---: |',
    ...(Object.keys(LABELS) as MetricName[]).map((k) => {
      const suffix = k === 'outcomeCorrect' ? ` / ${n}` : '';
      return `| ${LABELS[k]} | ${totals.aftercare[k]}${suffix} | ${totals.baseline[k]}${suffix} | ${totals.careful[k]}${suffix} |`;
    }),
  ];
}

export function renderMarkdown(results: EvaluationResults): string {
  const n = results.scenarioCount;
  const problems = (r: AgentResult) =>
    (Object.keys(LABELS) as MetricName[])
      .filter((k) => k !== 'outcomeCorrect' && r.metrics[k] > 0)
      .map((k) => LABELS[k].toLowerCase())
      .join(', ') || 'none';
  const mark = (r: AgentResult) => `${r.claim}${r.metrics.outcomeCorrect ? ' ✓' : ' ✗'}`;
  const lines = [
    '<!-- Generated by `npm run eval`. Do not edit by hand. -->',
    '# Evaluation results',
    '',
    `Scenarios: **${n}**. Case date: ${results.caseDate}. Compiler ${results.compilerVersion}.`,
    '',
    'Each count is the number of scenarios where it happened, except duplicate attempts and extra returns, which count events.',
    '',
    ...results.sets.flatMap((set) => [
      `## ${set.label} (${set.scenarioIds[0] ?? ''} to ${set.scenarioIds.at(-1) ?? ''})`,
      '',
      ...totalsTable(set.totals, set.scenarioIds.length),
      '',
    ]),
    `## All ${n} scenarios`,
    '',
    ...totalsTable(results.totals, n),
    '',
    '## Per scenario',
    '',
    '| ID | Scenario | Expected | AFTERCARE | Baseline | Careful baseline | Baseline problems | Careful baseline problems |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.scenarios.map(
      (s) =>
        `| ${s.id} | ${s.title} | ${s.expected.outcome} | ${mark(s.aftercare)} | ${mark(s.baseline)} | ${mark(s.careful)} | ${problems(s.baseline)} | ${problems(s.careful)} |`,
    ),
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
    '## Careful baseline',
    '',
    results.carefulBaselineDefinition,
    '',
  ];
  return lines.join('\n');
}
