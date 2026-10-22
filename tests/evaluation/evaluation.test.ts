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

  it('leaves the original 14 results exactly as first published', async () => {
    const original = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../data/evaluation/results-original-14.json', import.meta.url)),
        'utf8',
      ),
    ) as {
      totals: { aftercare: unknown; baseline: unknown };
      scenarios: Record<string, unknown>[];
    };
    const results = JSON.parse(JSON.stringify(await runEvaluation())) as typeof original & {
      sets: { label: string; totals: { aftercare: unknown; baseline: unknown } }[];
    };
    const keep = (s: Record<string, unknown>) => ({
      id: s['id'],
      title: s['title'],
      category: s['category'],
      expected: s['expected'],
      aftercare: s['aftercare'],
      baseline: s['baseline'],
    });
    expect(original.scenarios).toHaveLength(14);
    expect(results.scenarios.slice(0, 14).map(keep)).toEqual(original.scenarios.map(keep));
    const first = results.sets.find((s) => s.label === 'Original scenarios');
    expect(first?.totals.aftercare).toEqual(original.totals.aftercare);
    expect(first?.totals.baseline).toEqual(original.totals.baseline);
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
