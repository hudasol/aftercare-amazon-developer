/**
 * Evidence, provenance and the authority policy used to resolve conflicting facts.
 *
 * An evidence item is one observed record (an order record, a carrier scan, a
 * policy document, something the customer said). Each item asserts one or more
 * facts about a subject. Facts from different items are compared per
 * (subject, attribute); disagreements are resolved by an explicit authority
 * ranking, never by whichever value lets the case proceed.
 */
import { z } from 'zod';
import { PolicyDocumentSchema } from './policy.js';

export const SourceTypeSchema = z.enum([
  'retailer_record',
  'carrier_record',
  'policy_document',
  'customer_statement',
  'customer_identifier',
  'third_party',
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const EvidenceKindSchema = z.enum([
  'order_record',
  'order_search',
  'carrier_scan',
  'policy_document',
  'customer_statement',
  'item_serial',
  'third_party_claim',
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const VerificationSchema = z.enum(['verified', 'unverified', 'failed']);
export type Verification = z.infer<typeof VerificationSchema>;

export const FactValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);
export type FactValue = z.infer<typeof FactValueSchema>;

export const FactSchema = z.object({
  subject: z.string().min(1),
  attribute: z.string().min(1),
  value: FactValueSchema,
});
export type Fact = z.infer<typeof FactSchema>;

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1),
  kind: EvidenceKindSchema,
  title: z.string().min(1),
  source: z.object({
    type: SourceTypeSchema,
    name: z.string().min(1),
    reference: z.string().nullable(),
  }),
  /** True for records produced by the demo retailer sandbox or fictional policy repository. */
  simulated: z.boolean(),
  observedAt: z.string().min(1),
  verification: VerificationSchema,
  /** Inactive items are kept for the audit trail but no longer assert facts. */
  status: z.enum(['active', 'superseded', 'rejected']),
  facts: z.array(FactSchema),
  /** Present only on policy_document evidence. */
  policy: PolicyDocumentSchema.nullable(),
  note: z.string().nullable(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

interface AuthorityRule {
  /** Ranked tiers of source types allowed to decide the fact. Index 0 is highest. */
  tiers: SourceType[][];
  /**
   * How disagreement inside the top tier is settled. 'latest' is used only where
   * the source is one party correcting itself (a customer restating why they
   * want a return). Records of record never use it: their disagreements stay
   * unresolved and are tested for materiality by the compiler.
   */
  tieBreak: 'none' | 'latest';
}

/**
 * Authority policy, by subject family. Sources not listed for a family are
 * recorded and shown, but cannot decide its facts.
 */
export const AUTHORITY: Readonly<Record<string, AuthorityRule>> = {
  // Order facts: the retailer's order system and the carrier both keep records of record.
  order: {
    tiers: [['retailer_record', 'carrier_record'], ['customer_statement']],
    tieBreak: 'none',
  },
  // What the customer wants and what is wrong with the item: only the customer knows.
  case: { tiers: [['customer_statement']], tieBreak: 'latest' },
  // Which physical item the customer holds: a customer-supplied identifier checked against records.
  item: { tiers: [['customer_identifier']], tieBreak: 'latest' },
  // Policy terms: only the published policy document. Third-party pages never decide policy.
  policy: { tiers: [['policy_document']], tieBreak: 'none' },
  // Lookups the system itself performed, such as an order search.
  lookup: { tiers: [['retailer_record']], tieBreak: 'none' },
};

export const INADMISSIBLE_REASON =
  'Not an authoritative source for this kind of fact, so it cannot decide it.';

export function subjectFamily(subject: string): string {
  const colon = subject.indexOf(':');
  return colon === -1 ? subject : subject.slice(0, colon);
}

/** 0 is highest. Returns null when the source may not decide this fact. */
export function authorityRank(subject: string, source: SourceType): number | null {
  const rule = AUTHORITY[subjectFamily(subject)];
  if (!rule) return null;
  const index = rule.tiers.findIndex((tier) => tier.includes(source));
  return index === -1 ? null : index;
}

export interface Claim {
  evidenceId: string;
  sourceType: SourceType;
  sourceName: string;
  value: FactValue;
  rank: number | null;
  observedAt: string;
}

export type FactStatus = 'established' | 'resolved_by_authority' | 'unresolved_conflict';

export interface ResolvedFact {
  subject: string;
  attribute: string;
  status: FactStatus;
  /** The decided value. Null when the conflict is unresolved. */
  value: FactValue;
  /** Distinct values asserted by the deciding sources (more than one only when unresolved). */
  candidates: FactValue[];
  supporting: string[];
  /** Admissible claims that lost: lower authority, or an earlier statement the same party corrected. */
  overruled: Claim[];
  explanation: string;
}

export function factKey(subject: string, attribute: string): string {
  return `${subject}.${attribute}`;
}

export function sameValue(a: FactValue, b: FactValue): boolean {
  return JSON.stringify(normalizeValue(a)) === JSON.stringify(normalizeValue(b));
}

function normalizeValue(value: FactValue): FactValue {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return [...value].sort();
  return value;
}

/** Evidence that currently asserts facts. Failed verifications never assert facts. */
export function activeEvidence(evidence: readonly Evidence[]): Evidence[] {
  return evidence.filter((e) => e.status === 'active' && e.verification !== 'failed');
}

/**
 * Resolve every (subject, attribute) asserted by admissible, active evidence.
 * Deterministic: iteration order follows first appearance in the evidence list.
 */
export function resolveFacts(evidence: readonly Evidence[]): Map<string, ResolvedFact> {
  const groups = new Map<string, { subject: string; attribute: string; claims: Claim[] }>();
  for (const item of activeEvidence(evidence)) {
    for (const fact of item.facts) {
      const rank = authorityRank(fact.subject, item.source.type);
      if (rank === null) continue;
      const key = factKey(fact.subject, fact.attribute);
      let group = groups.get(key);
      if (!group) {
        group = { subject: fact.subject, attribute: fact.attribute, claims: [] };
        groups.set(key, group);
      }
      group.claims.push({
        evidenceId: item.id,
        sourceType: item.source.type,
        sourceName: item.source.name,
        value: fact.value,
        rank,
        observedAt: item.observedAt,
      });
    }
  }

  const resolved = new Map<string, ResolvedFact>();
  for (const [key, group] of groups) {
    resolved.set(key, resolveGroup(group.subject, group.attribute, group.claims));
  }
  return resolved;
}

function resolveGroup(subject: string, attribute: string, claims: Claim[]): ResolvedFact {
  const topRank = Math.min(...claims.map((c) => c.rank as number));
  let top = claims.filter((c) => c.rank === topRank);
  const lower = claims.filter((c) => c.rank !== topRank);

  const corrected: Claim[] = [];
  if (AUTHORITY[subjectFamily(subject)]?.tieBreak === 'latest' && top.length > 1) {
    const latest = top.reduce((a, b) => (b.observedAt >= a.observedAt ? b : a));
    corrected.push(...top.filter((c) => !sameValue(c.value, latest.value)));
    top = top.filter((c) => sameValue(c.value, latest.value));
  }

  const candidates: FactValue[] = [];
  for (const claim of top) {
    if (!candidates.some((v) => sameValue(v, claim.value))) candidates.push(claim.value);
  }

  if (candidates.length > 1) {
    return {
      subject,
      attribute,
      status: 'unresolved_conflict',
      value: null,
      candidates,
      supporting: top.map((c) => c.evidenceId),
      overruled: lower,
      explanation: `Equally authoritative sources disagree (${top
        .map((c) => `${c.sourceName}: ${formatValue(c.value)}`)
        .join('; ')}).`,
    };
  }

  const value = candidates[0] as FactValue;
  const overruled = [...corrected, ...lower.filter((c) => !sameValue(c.value, value))];
  const sources = [...new Set(top.map((c) => c.sourceName))].join(' and ');
  return {
    subject,
    attribute,
    status: overruled.length > 0 ? 'resolved_by_authority' : 'established',
    value,
    candidates,
    supporting: top.map((c) => c.evidenceId),
    overruled,
    explanation:
      overruled.length > 0
        ? `${sources} decides this; it outranks or replaces ${overruled
            .map((c) => `${c.sourceName} (${formatValue(c.value)})`)
            .join(', ')}.`
        : `Recorded by ${sources}.`,
  };
}

/** Claims that were recorded but are not allowed to decide their fact. */
export function inadmissibleClaims(evidence: readonly Evidence[]): Array<Claim & Fact> {
  const out: Array<Claim & Fact> = [];
  for (const item of activeEvidence(evidence)) {
    for (const fact of item.facts) {
      if (authorityRank(fact.subject, item.source.type) === null) {
        out.push({
          ...fact,
          evidenceId: item.id,
          sourceType: item.source.type,
          sourceName: item.source.name,
          rank: null,
          observedAt: item.observedAt,
        });
      }
    }
  }
  return out;
}

export function formatValue(value: FactValue): string {
  if (value === null) return 'none';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
