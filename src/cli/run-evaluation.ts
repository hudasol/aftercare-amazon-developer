/**
 * Runs the evaluation and writes data/evaluation/results.json and
 * docs/EVALUATION_RESULTS.md. Results are deterministic: rerunning on the same
 * commit produces identical files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, runEvaluation, type EvaluationResults } from '../evaluation/harness.js';

const jsonPath = fileURLToPath(new URL('../../data/evaluation/results.json', import.meta.url));
const mdPath = fileURLToPath(new URL('../../docs/EVALUATION_RESULTS.md', import.meta.url));

const results = await runEvaluation();
mkdirSync(fileURLToPath(new URL('../../data/evaluation', import.meta.url)), { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
writeFileSync(mdPath, renderMarkdown(results));

function print(label: string, n: number, totals: EvaluationResults['totals']): void {
  const { aftercare, baseline, careful } = totals;
  console.info(`${label}: ${n} scenarios`);
  console.info(
    `  Correct outcome          AFTERCARE ${aftercare.outcomeCorrect}  baseline ${baseline.outcomeCorrect}  careful baseline ${careful.outcomeCorrect}`,
  );
  for (const key of Object.keys(aftercare) as (keyof typeof aftercare)[]) {
    if (key === 'outcomeCorrect') continue;
    console.info(
      `  ${key.padEnd(24)} AFTERCARE ${aftercare[key]}  baseline ${baseline[key]}  careful baseline ${careful[key]}`,
    );
  }
}

for (const set of results.sets) print(set.label, set.scenarioIds.length, set.totals);
print('All', results.scenarioCount, results.totals);
console.info(`Wrote ${jsonPath} and ${mdPath}`);
