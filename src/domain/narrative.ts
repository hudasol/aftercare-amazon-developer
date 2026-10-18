/**
 * Customer-facing wording, generated deterministically from compiler results.
 *
 * Kept separate from the decision logic so wording can change without touching
 * rules. Nothing here decides anything; it only describes decisions already made.
 */
import { formatLongDate, type IsoDate } from './dates.js';

export function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export function date(d: IsoDate | null): string {
  return d ? formatLongDate(d).replace(/, \d{4}$/, '') : 'an unknown date';
}

export interface CandidateSummary {
  productName: string;
  deliveredOn: IsoDate | null;
  eligibility: 'eligible' | 'not_eligible' | 'undetermined';
  deadline: IsoDate | null;
}

export function describeCandidates(candidates: CandidateSummary[]): string {
  const parts = candidates.map((c) => {
    const delivered = `delivered ${date(c.deliveredOn)}`;
    if (c.eligibility === 'eligible')
      return `one ${delivered}, returnable until ${date(c.deadline)}`;
    if (c.eligibility === 'not_eligible' && c.deadline) {
      return `one ${delivered}, whose return window closed on ${date(c.deadline)}`;
    }
    return `one ${delivered}`;
  });
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join('; ')}; and ${parts.at(-1)}`;
}
