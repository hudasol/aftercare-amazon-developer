/**
 * Field level comparison of interpreters on hand labelled customer messages
 * (data/evaluation/interpreter-paraphrases.json).
 *
 * Fields scored: goal, reason, product (does the extracted product query find
 * exactly the labelled order in the sandbox), and timeHint (whether a purchase
 * time was picked up). Serial and order numbers are not scored: they always
 * come from the rules interpreter.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Interpretation, Interpreter } from '../application/ports.js';
import { createContainer } from '../container.js';

const PARAPHRASES = fileURLToPath(
  new URL('../../data/evaluation/interpreter-paraphrases.json', import.meta.url),
);
const CUSTOMER = 'cus_demo_maya';

/** Which sandbox product names a labelled product must find, and nothing else. */
const PRODUCT_NAMES: Record<string, string> = {
  headphones: 'Halden Aria wireless headphones',
  'pour-over set': 'Fernway ceramic pour-over set',
};

const ParaphraseSetSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      utterance: z.string(),
      expected: z.object({
        goal: z.enum(['return', 'exchange']).nullable(),
        reason: z.enum(['defective', 'changed_mind']).nullable(),
        product: z.enum(['headphones', 'pour-over set']).nullable(),
        timeHint: z.boolean(),
      }),
    }),
  ),
});
export type Paraphrase = z.infer<typeof ParaphraseSetSchema>['items'][number];

export const FIELDS = ['goal', 'reason', 'product', 'timeHint'] as const;
export type Field = (typeof FIELDS)[number];

export interface ItemResult {
  id: string;
  /** Fields the interpreter got wrong. */
  missed: Field[];
  /** Set when the model failed and the rules interpreter was used instead. */
  fallback: string | null;
  productQuery: string | null;
}

export interface InterpreterRun {
  interpreter: string;
  correct: Record<Field, number>;
  allFieldsCorrect: number;
  fallbacks: number;
  items: ItemResult[];
}

export function loadParaphrases(path = PARAPHRASES): Paraphrase[] {
  return ParaphraseSetSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).items;
}

/**
 * Runs one interpreter over the set. When `fallback` is given, a failure of
 * `interpreter` is scored with the fallback's reading, as the service would.
 */
export async function evaluateInterpreter(
  interpreter: Interpreter,
  items: Paraphrase[],
  fallback?: Interpreter,
): Promise<InterpreterRun> {
  const dir = mkdtempSync(join(tmpdir(), 'aftercare-interp-'));
  const container = createContainer({
    databasePath: join(dir, 'interp.db'),
    demoCustomer: CUSTOMER,
  });
  try {
    const results: ItemResult[] = [];
    for (const item of items) {
      let reading: Interpretation;
      let fellBack: string | null = null;
      try {
        reading = await interpreter.interpret(item.utterance);
      } catch (error) {
        if (!fallback) throw error;
        fellBack = error instanceof Error ? error.message : String(error);
        reading = await fallback.interpret(item.utterance);
      }
      const found = reading.productQuery
        ? [
            ...new Set(
              (await container.sandbox.searchOrders(CUSTOMER, reading.productQuery)).map(
                (o) => o.productName,
              ),
            ),
          ]
        : [];
      const expectedName = item.expected.product ? PRODUCT_NAMES[item.expected.product] : null;
      const ok: Record<Field, boolean> = {
        goal: reading.goal === item.expected.goal,
        reason: reading.reason === item.expected.reason,
        product: expectedName
          ? found.length === 1 && found[0] === expectedName
          : reading.productQuery === null,
        timeHint: (reading.purchaseTimeHint !== null) === item.expected.timeHint,
      };
      results.push({
        id: item.id,
        missed: FIELDS.filter((f) => !ok[f]),
        fallback: fellBack,
        productQuery: reading.productQuery,
      });
    }
    const correct = Object.fromEntries(
      FIELDS.map((f) => [f, results.filter((r) => !r.missed.includes(f)).length]),
    ) as Record<Field, number>;
    return {
      interpreter: interpreter.id,
      correct,
      allFieldsCorrect: results.filter((r) => r.missed.length === 0).length,
      fallbacks: results.filter((r) => r.fallback !== null).length,
      items: results,
    };
  } finally {
    container.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
