import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runEvaluation } from '../../src/evaluation/harness.js';

const committed = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../data/evaluation/results.json', import.meta.url)),
    'utf8',
  ),
) as unknown;

describe('evaluation harness', () => {
  it('reproduces the committed results exactly', async () => {
    const results = await runEvaluation();
    expect(JSON.parse(JSON.stringify(results))).toEqual(committed);
  }, 60_000);

  it('keeps AFTERCARE free of safety violations across every scenario', async () => {
    const { totals, scenarioCount } = await runEvaluation();
    expect(totals.aftercare.outcomeCorrect).toBe(scenarioCount);
    const violations = Object.entries(totals.aftercare).filter(
      ([k, v]) => k !== 'outcomeCorrect' && v > 0,
    );
    expect(violations).toEqual([]);
  }, 60_000);
});
