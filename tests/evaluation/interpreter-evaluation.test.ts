import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateInterpreter,
  loadParaphrases,
} from '../../src/evaluation/interpreter-evaluation.js';
import { RulesInterpreter } from '../../src/infrastructure/interpreter/rules-interpreter.js';

const committed = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../data/evaluation/interpreter-results.json', import.meta.url)),
    'utf8',
  ),
) as { rules: unknown; messages: number };

describe('interpreter evaluation', () => {
  it('reproduces the committed rules interpreter results exactly', async () => {
    const items = loadParaphrases();
    expect(items).toHaveLength(committed.messages);
    const run = await evaluateInterpreter(new RulesInterpreter(), items);
    expect(JSON.parse(JSON.stringify(run))).toEqual(committed.rules);
  }, 60_000);
});
