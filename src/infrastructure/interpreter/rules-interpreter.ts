/**
 * Deterministic language interpreter.
 *
 * Extracts structured hints from what the customer says: what they want, what
 * is wrong, which product, serial and order numbers. It is the default
 * interpreter and the fallback for any model-based one. Its output is only
 * ever a claim by the customer. It cannot approve, decide eligibility, or
 * trigger an action.
 */
import type { Interpretation, Interpreter } from '../../application/ports.js';

const RETURN = /\b(return|send (it|them|these|this) back|refund|money back|take (it|them) back)\b/i;
const EXCHANGE = /\b(exchange|replace|replacement|swap)\b/i;

const DEFECT = [
  /\bdisconnect\w*/i,
  /\b(keeps?|kept) (cutting|dropping|turning) (out|off)\b/i,
  /\bbroken\b/i,
  /\bfaulty\b/i,
  /\bdefective\b/i,
  /\bdamaged\b/i,
  /\b(stopped|stop) working\b/i,
  /\b(doesn'?t|does not|don'?t|do not|won'?t|will not) (work|charge|pair|connect|turn on)\b/i,
  /\bnot (working|charging|pairing|connecting)\b/i,
  /\bcrackl\w*/i,
  /\bdead\b/i,
  /\bmalfunction\w*/i,
];
const CHANGED_MIND = [
  /\bchanged my mind\b/i,
  /\b(don'?t|do not) (like|want|need) (it|them)\b/i,
  /\bno longer (need|want)\b/i,
  /\bnot (what i|for me)\b/i,
  /\buncomfortable\b/i,
  /\b(just )?(rather not|prefer not to) keep\b/i,
  /\bnothing(?:'s| is) wrong\b/i,
];

const PRODUCTS: { pattern: RegExp; query: (m: RegExpMatchArray) => string }[] = [
  {
    pattern:
      /\b((?:wireless|bluetooth|noise[- ]cancell?ing|over[- ]ear|on[- ]ear)\s+)?(headphones?|earbuds?|headset|earphones?)\b/i,
    query: (m) => `${m[1] ?? ''}${m[2] ?? ''}`.trim().toLowerCase(),
  },
  {
    pattern: /\b(pour[- ]over(?: set)?|coffee (?:set|maker)|kettle)\b/i,
    query: (m) => (m[1] ?? '').toLowerCase(),
  },
  {
    pattern: /\b(speaker|charger|keyboard|mouse|lamp|blender)s?\b/i,
    query: (m) => (m[1] ?? '').toLowerCase(),
  },
];

const TIME_HINT =
  /\b(recently|just (?:bought|got)|last (?:week|month)|a (?:few )?(?:days|weeks?|months?) ago|in (?:january|february|march|april|may|june|july|august|september|october|november|december))\b/i;

const SERIAL = /\b([A-Z]{2}-?[A-Z0-9]{3}-?\d{4})\b/i;
const ORDER = /\b(KG-\d{4}-\d{4})\b/i;
const AGREE =
  /^\s*(yes|yeah|yep|sure|ok(ay)?|go ahead|do it|please do|sounds good|approve[d]?|confirm(ed)?)\b/i;
// Only explicit requests count. Words like "stop" also describe faults ("they stop working").
const CANCEL =
  /\b(cancel (the|my|this) (case|return|request)|never ?mind|forget (it|about it)|close (the|my|this) case)\b/i;

function sentenceContaining(text: string, pattern: RegExp): string | null {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const hit = sentences.find((s) => pattern.test(s));
  return hit ? hit.trim() : null;
}

export class RulesInterpreter implements Interpreter {
  readonly id = 'rules@1';

  async interpret(utterance: string): Promise<Interpretation> {
    const text = utterance.trim();
    const defect = DEFECT.find((p) => p.test(text));
    const changed = CHANGED_MIND.find((p) => p.test(text));
    let productQuery: string | null = null;
    for (const product of PRODUCTS) {
      const match = text.match(product.pattern);
      if (match) {
        productQuery = product.query(match);
        break;
      }
    }
    const serial = text.match(SERIAL)?.[1] ?? null;
    const order = text.match(ORDER)?.[1] ?? null;
    return {
      goal: EXCHANGE.test(text) ? 'exchange' : RETURN.test(text) ? 'return' : null,
      productQuery,
      // A described defect outweighs a vague "I don't want them": the customer reported a fault.
      reason: defect ? 'defective' : changed ? 'changed_mind' : null,
      issueDescription: defect ? sentenceContaining(text, defect) : null,
      purchaseTimeHint: text.match(TIME_HINT)?.[1]?.toLowerCase() ?? null,
      serialNumber: serial && !ORDER.test(serial) ? serial.toUpperCase() : null,
      orderNumber: order ? order.toUpperCase() : null,
      soundsLikeApproval: AGREE.test(text),
      // A message that describes a fault is never read as a request to give up.
      wantsToCancel: CANCEL.test(text) && !defect && !RETURN.test(text),
    };
  }
}
