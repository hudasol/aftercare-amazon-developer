import { useCallback, useEffect, useMemo, useState } from 'react';
import { Journey, StatePill, Tick } from '../components/common';
import { api } from '../lib/api';
import { clock, longDate, sentence, shortDate } from '../lib/format';
import { callTool } from '../lib/mcp';
import { navigate } from '../lib/router';
import type {
  Assessment,
  CaseSummary,
  CaseView,
  EvaluationResults,
  EventRecord,
  Evidence,
  SandboxState,
  Session,
} from '../lib/types';

const FLAGSHIP =
  'My wireless headphones keep disconnecting. I bought them recently. Can you help me return them?';
const WRONG_SERIAL = 'HA-0X0-0000';
const RIGHT_SERIAL = 'HA-7Q2-4471';
const POLL_MS = 2500;

interface Step {
  label: string;
  run: () => Promise<{ caseId: string }>;
}

/** The scripted customer: the next thing the Return Rescue customer does, given the case as it is now. */
function nextStep(view: CaseView | null): Step | null {
  if (!view) {
    return {
      label: `Customer says: “${FLAGSHIP}”`,
      run: () => callTool('start_return_case', { customerRequest: FLAGSHIP }),
    };
  }
  const id = view.case.id;
  const state = view.case.state;
  const need = view.assessment?.missing.find(
    (m) => m.obtainableFrom === 'customer' && m.blocking,
  )?.id;
  const proposal = view.proposals.find((p) => p.status === 'prepared' || p.status === 'approved');
  if (state === 'needs_information' && need === 'item_serial') {
    const triedWrong = view.evidence.some(
      (e) => e.kind === 'item_serial' && e.verification === 'failed',
    );
    const serial = triedWrong ? RIGHT_SERIAL : WRONG_SERIAL;
    return {
      label: triedWrong
        ? `Customer reads the serial correctly: ${serial}`
        : `Customer misreads the serial: ${serial}`,
      run: () => callTool('provide_item_serial', { caseId: id, serialNumber: serial }),
    };
  }
  if (state === 'awaiting_approval' && proposal) {
    if (!view.events.some((e) => e.type === 'approval.not_inferred')) {
      return {
        label: 'Customer says “yes, go ahead” in chat (not an approval)',
        run: () => callTool('continue_case', { caseId: id, customerMessage: 'Yes, go ahead!' }),
      };
    }
    return {
      label: 'Customer approves the exact proposal',
      run: () =>
        callTool('approve_proposed_return', {
          caseId: id,
          proposalId: proposal.id,
          proposalDigest: proposal.digest,
          customerConfirmation: 'Approved in the Resolution Lab by the scripted customer.',
        }),
    };
  }
  if (state === 'ready_to_submit' && proposal) {
    return {
      label: 'Assistant submits the approved return',
      run: () => callTool('submit_approved_return', { caseId: id, proposalId: proposal.id }),
    };
  }
  if (state === 'needs_reconciliation' || state === 'awaiting_verification') {
    return {
      label:
        state === 'needs_reconciliation'
          ? 'Assistant reconciles the unknown outcome'
          : 'Assistant verifies the return',
      run: () => callTool('check_return_outcome', { caseId: id }),
    };
  }
  return null;
}

export function LabView({ caseId, session }: { caseId: string | null; session: Session | null }) {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [view, setView] = useState<CaseView | null>(null);
  const [sandbox, setSandbox] = useState<SandboxState | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationResults | null>(null);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string[]>([]);
  const [outcome, setOutcome] = useState('timeout_after_commit');

  const fetchAll = useCallback(
    () =>
      Promise.all([
        api.cases(),
        api.sandbox(),
        caseId ? api.getCase(caseId) : Promise.resolve(null),
      ]),
    [caseId],
  );
  const apply = useCallback(([list, box, next]: [CaseSummary[], SandboxState, CaseView | null]) => {
    setCases(list);
    setSandbox(box);
    setView(next);
  }, []);
  const refresh = useCallback(async () => apply(await fetchAll()), [apply, fetchAll]);

  useEffect(() => {
    fetchAll()
      .then(apply)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the Lab.'));
    api
      .evaluation()
      .then((r) => {
        setEvaluation(r.results ?? null);
        if (!r.available) setEvaluationError('No evaluation results yet. Run npm run eval.');
      })
      .catch((e: unknown) =>
        setEvaluationError(
          e instanceof Error ? e.message : 'Evaluation results could not be loaded.',
        ),
      );
  }, [fetchAll, apply]);

  // Follow changes made elsewhere (for example the assistant surface in another window).
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !busy) refresh().catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, busy]);

  const act = async (label: string, fn: () => Promise<{ caseId?: string } | unknown>) => {
    setBusy(label);
    setError(null);
    try {
      const result = (await fn()) as { caseId?: string; case?: { id: string } } | undefined;
      const id = result?.caseId ?? result?.case?.id;
      if (id && id !== caseId) navigate({ view: 'lab', caseId: id });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That control failed.');
      await refresh().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const step = nextStep(caseId ? view : null);
  const a = view?.assessment ?? null;

  return (
    <main className="lab" id="main">
      <header className="lab-head">
        <div>
          <h1>Resolution Lab</h1>
          <p>
            The same case the customer sees, opened up: the evidence, the rules applied, why the
            next step is justified, and everything that happened. Every control here goes through
            the same MCP tools and services as the assistant.
          </p>
        </div>
        {session && (
          <p className="fine">
            MCP {session.mcp.protocolVersion} over {session.mcp.transport}. Case date{' '}
            {longDate(session.caseDate)} (pinned for repeatable demos).
          </p>
        )}
      </header>

      <section className="panel controls" aria-label="Scenario controls">
        <div className="control-group">
          <label htmlFor="case-pick">Case</label>
          <div className="row">
            <select
              id="case-pick"
              value={caseId ?? ''}
              onChange={(e) => navigate({ view: 'lab', caseId: e.target.value || null })}
            >
              <option value="">No case selected</option>
              {cases.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title} ({c.stateLabel})
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() => void act('Reloading…', refresh)}
            >
              Reload from database
            </button>
          </div>
          <p className="driver-next">
            {step ? (
              <>
                <strong>Next scripted step:</strong> {step.label}
              </>
            ) : caseId ? (
              'The scripted customer has nothing more to do in this case.'
            ) : (
              ''
            )}
          </p>
          <div className="row">
            <button
              className="btn btn-primary"
              disabled={!step || busy !== null}
              onClick={() => step && void act('Running step…', step.run)}
            >
              {caseId ? 'Run next step' : 'Start Return Rescue'}
            </button>
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() => {
                if (window.confirm('Remove all demo cases and reseed the fictional retailer?')) {
                  void act('Resetting…', async () => {
                    await api.reset();
                    navigate({ view: 'lab', caseId: null });
                    return {};
                  });
                }
              }}
            >
              Reset demo
            </button>
          </div>
        </div>

        <div className="control-group">
          <label htmlFor="outcome">Retailer’s answer to the next submission</label>
          <div className="row">
            <select id="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              {(sandbox?.outcomes ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {sentence(o.id)}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() => void act('Scripting…', () => api.script(outcome, caseId))}
            >
              Set
            </button>
          </div>
          <p className="fine">
            {sandbox?.outcomes.find((o) => o.id === outcome)?.description} Queued now:{' '}
            {sandbox && sandbox.queue.length > 0
              ? sandbox.queue.map((q) => sentence(q.outcome)).join(', ')
              : 'nothing (accepts by default)'}
            .
          </p>
        </div>

        <div className="control-group">
          <label>Introduce evidence</label>
          <div className="row">
            <button
              className="btn"
              disabled={!caseId || busy !== null}
              onClick={() =>
                caseId && void act('Adding a carrier record…', () => api.carrierConflict(caseId))
              }
            >
              Carrier disagrees on delivery date
            </button>
            <button
              className="btn"
              disabled={!caseId || busy !== null}
              onClick={() =>
                caseId && void act('Adding a blog claim…', () => api.thirdPartyClaim(caseId))
              }
            >
              Customer cites a 90-day blog post
            </button>
          </div>
          <p className="fine">
            Shows how conflicts are settled: by authority, by whether they change the decision, or
            not at all.
          </p>
        </div>
      </section>

      {busy && (
        <p className="thinking" role="status">
          {busy}
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}

      {view ? (
        <>
          <section className="lab-journey" aria-label="Case journey">
            <div className="case-head" style={{ marginBottom: 20 }}>
              <div>
                <p className="case-title">{view.case.title}</p>
                <p className="case-id">
                  Case {view.case.id}, opened {clock(view.case.createdAt)}. Version{' '}
                  {view.case.version}.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <StatePill state={view.case.state} label={view.case.stateLabel} />
                <a
                  className="btn btn-small"
                  href={`/cases/${view.case.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate({ view: 'assistant', caseId: view.case.id });
                  }}
                >
                  Open as customer
                </a>
              </div>
            </div>
            <Journey stages={view.journey} label="Case journey" />
          </section>

          <div className="lab-grid">
            {a ? (
              <DecisionPanel a={a} onHighlight={setHighlight} />
            ) : (
              <div className="panel empty">No decision yet.</div>
            )}
            <EvidencePanel view={view} highlight={highlight} onHighlight={setHighlight} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <LifecyclePanel view={view} />
              <TimelinePanel events={view.events} />
            </div>
          </div>
          {sandbox && <RetailerTruth sandbox={sandbox} />}
        </>
      ) : (
        <section className="panel">
          <p className="empty">
            Start the Return Rescue scenario above, pick an existing case, or open the assistant and
            describe a problem. The Lab follows the case as it changes.
          </p>
        </section>
      )}

      {evaluation ? (
        <Comparison results={evaluation} />
      ) : (
        evaluationError && (
          <section className="panel" aria-label="Measured comparison">
            <p className="empty">{evaluationError}</p>
          </section>
        )
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------------------

const KIND_TEXT: Record<string, string> = {
  gather_evidence: 'Gather records',
  request_information: 'Ask the customer',
  escalate_for_review: 'Pause for review',
  explain_ineligible: 'Explain why not',
  propose_action: 'Propose an action',
  await_approval: 'Wait for approval',
  submit_approved_action: 'Submit approved action',
  verify_outcome: 'Verify the outcome',
  reconcile_operation: 'Reconcile unknown outcome',
  close_resolved: 'Close as resolved',
};

function DecisionPanel({
  a,
  onHighlight,
}: {
  a: Assessment;
  onHighlight: (ids: string[]) => void;
}) {
  return (
    <section className="panel" aria-label="Decision trace">
      <h2>Current decision</h2>
      <p className="decision-now">{a.headline}</p>
      <div className="decision-kind">
        <span className="pill">{KIND_TEXT[a.nextStep.kind] ?? a.nextStep.kind}</span>
        {a.nextStep.requiresApproval && (
          <span className="pill" data-tone="gate">
            Needs customer approval
          </span>
        )}
      </div>
      <p className="rationale">{a.nextStep.rationale}</p>

      {(a.blockers.length > 0 || a.missing.length > 0) && (
        <div className="section">
          <h4>What is stopping it</h4>
          <ul className="checklist">
            {a.blockers.map((b) => (
              <li key={b.code}>
                <Tick ok={false} />
                <span>
                  {b.title}
                  <span className="detail">Resolves when: {b.resolvesWith}</span>
                </span>
              </li>
            ))}
            {a.missing.map((m) => (
              <li key={m.id}>
                <Tick ok={false} />
                <span>
                  Missing: {m.label} (
                  {m.obtainableFrom === 'customer'
                    ? 'only the customer can provide this'
                    : 'the system fetches this'}
                  )<span className="detail">{m.why}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="section">
        <h4>Eligibility: {sentence(a.eligibility.status)}</h4>
        <p className="fine">{a.eligibility.explanation}</p>
        {a.derived.length > 0 && (
          <dl className="facts" style={{ marginTop: 8 }}>
            {a.derived.map((d) => (
              <FragmentRow key={d.key} label={d.label} value={String(d.value)} detail={d.basis} />
            ))}
          </dl>
        )}
      </div>

      {a.subject.candidates.length > 1 && (
        <div className="section">
          <h4>Which order is this about?</h4>
          <p className="fine">{a.subject.basis}</p>
          <table className="matrix" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Order</th>
                <th>Delivered</th>
                <th>Policy</th>
                <th>Returnable</th>
              </tr>
            </thead>
            <tbody>
              {a.subject.candidates.map((c) => (
                <tr key={c.orderId}>
                  <td>{c.orderId}</td>
                  <td>{shortDate(c.deliveredOn)}</td>
                  <td>{c.policyVersion ? `v${c.policyVersion}` : 'unknown'}</td>
                  <td>
                    {c.eligibility === 'eligible'
                      ? `until ${shortDate(c.deadline)}`
                      : c.eligibility === 'not_eligible'
                        ? `closed ${shortDate(c.deadline)}`
                        : 'undetermined'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {a.policy.considered.length > 0 && (
        <div className="section">
          <h4>Policy versions considered</h4>
          <p className="fine" style={{ marginBottom: 8 }}>
            Rule: {a.policy.rule}
          </p>
          <ul className="policy-versions">
            {a.policy.considered.map((p) => (
              <li key={p.version} data-used={p.used}>
                <strong>
                  v{p.version} {p.used ? '(governs this order)' : '(not used)'}
                </strong>
                <span className="why">{p.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="section">
        <h4>Actions considered</h4>
        {a.candidates.map((c) => (
          <details
            className="action-row"
            key={c.actionType}
            open={c.actionType === 'create_return_authorization'}
          >
            <summary>
              <span>{c.label}</span>
              <span className="pill" data-tone={c.status === 'eligible' ? 'good' : 'gate'}>
                {c.status === 'eligible' ? 'Allowed' : 'Blocked'}
              </span>
            </summary>
            <ul className="checklist" style={{ marginTop: 8 }}>
              {c.preconditions.map((p) => (
                <li key={p.id}>
                  <Tick ok={p.met} />
                  <span>
                    {p.description}
                    <span className="detail">{p.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>

      {a.uncertainty.length > 0 && (
        <div className="section">
          <h4>Remaining uncertainty</h4>
          <ul className="checklist">
            {a.uncertainty.map((u) => (
              <li key={u}>
                <span aria-hidden="true">?</span>
                <span>{u}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="more">
        <summary>Compiler stages</summary>
        <ol className="checklist" style={{ marginTop: 8 }}>
          {a.trace.map((t) => (
            <li key={t.stage} onMouseEnter={() => onHighlight([])}>
              <span aria-hidden="true">·</span>
              <span>
                <strong>{sentence(t.stage)}</strong>: {t.outcome}
                <span className="detail">{t.detail}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="fine" style={{ marginTop: 8 }}>
          Compiler {a.compilerVersion}. This is the recorded decision path (rules, evidence and
          checks), not a model’s private reasoning.
        </p>
      </details>
    </section>
  );
}

function FragmentRow({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {value}
        <span
          className="detail"
          style={{ display: 'block', fontWeight: 400, color: 'var(--ink-2)', fontSize: '0.8rem' }}
        >
          {detail}
        </span>
      </dd>
    </>
  );
}

const AUTHORITY: Record<string, { rank: string; text: string }> = {
  retailer_record: { rank: 'record', text: 'Record of record' },
  carrier_record: { rank: 'record', text: 'Record of record' },
  policy_document: { rank: 'policy', text: 'Published policy' },
  customer_statement: { rank: 'customer', text: 'Customer’s account' },
  customer_identifier: { rank: 'customer', text: 'Customer-supplied, checked' },
  third_party: { rank: 'none', text: 'Not authoritative' },
};

const CONFLICT_TEXT: Record<string, string> = {
  resolved_by_authority: 'Settled by authority',
  immaterial: 'Does not change the decision',
  material: 'Changes the decision',
  inadmissible: 'Set aside: not an authoritative source',
};

function EvidencePanel({
  view,
  highlight,
  onHighlight,
}: {
  view: CaseView;
  highlight: string[];
  onHighlight: (ids: string[]) => void;
}) {
  const conflicts = view.assessment?.conflicts ?? [];
  const usedIds = useMemo(
    () => new Set((view.assessment?.facts ?? []).flatMap((f) => f.evidenceIds)),
    [view.assessment],
  );
  return (
    <section className="panel" aria-label="Evidence inspector">
      <h2>Evidence ({view.evidence.length})</h2>
      {conflicts.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {conflicts.map((c, i) => (
            <div
              key={`${c.key}-${i}`}
              className="conflict"
              data-kind={c.kind}
              tabIndex={0}
              onMouseEnter={() => onHighlight(c.values.flatMap((v) => v.evidenceIds))}
              onMouseLeave={() => onHighlight([])}
              onFocus={() => onHighlight(c.values.flatMap((v) => v.evidenceIds))}
              onBlur={() => onHighlight([])}
            >
              <strong>
                {CONFLICT_TEXT[c.kind]}: {c.label}
              </strong>
              <div className="fine">{c.explanation}</div>
            </div>
          ))}
        </div>
      )}
      <ul className="evidence-list">
        {view.evidence.map((e) => (
          <EvidenceCard
            key={e.id}
            e={e}
            used={usedIds.has(e.id)}
            highlighted={highlight.includes(e.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function EvidenceCard({
  e,
  used,
  highlighted,
}: {
  e: Evidence;
  used: boolean;
  highlighted: boolean;
}) {
  const authority = AUTHORITY[e.source.type] ?? { rank: 'none', text: e.source.type };
  const shown = e.facts.filter((f) => f.value !== null && f.attribute !== 'serialLocation');
  return (
    <li
      className="evidence"
      data-highlight={highlighted}
      data-verification={e.verification}
      data-inadmissible={e.source.type === 'third_party'}
    >
      <div className="evidence-head">
        <span className="evidence-title">{e.title}</span>
        <span className="fine">{clock(e.observedAt)}</span>
      </div>
      <div className="source">
        <span className="authority" data-rank={authority.rank}>
          {authority.text}
        </span>
        <span>{e.source.name}</span>
        <span>
          {e.verification === 'verified'
            ? 'Verified'
            : e.verification === 'failed'
              ? 'Failed verification'
              : 'Unverified'}
        </span>
        {e.simulated && <span className="demo-tag">simulated</span>}
        {used && <span>Used in decision</span>}
      </div>
      {e.policy ? (
        <ul className="checklist" style={{ marginTop: 8 }}>
          {e.policy.rules.map((r) => (
            <li key={r.id}>
              <span aria-hidden="true">§</span>
              <span>
                {r.summary} <span className="detail">{r.id}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        shown.length > 0 && (
          <dl className="facts">
            {shown.slice(0, 8).map((f) => (
              <FactRow
                key={`${f.subject}.${f.attribute}`}
                attribute={f.attribute}
                value={f.value}
              />
            ))}
          </dl>
        )
      )}
      {e.note && (
        <p className="fine" style={{ marginTop: 6 }}>
          {e.note}
        </p>
      )}
    </li>
  );
}

const FACT_LABELS: Record<string, string> = {
  orderedOn: 'Ordered',
  deliveredOn: 'Delivered',
  productName: 'Product',
  category: 'Category',
  priceCents: 'Price',
  currency: 'Currency',
  lineId: 'Line',
  seller: 'Seller',
  serialNumbers: 'Serials shipped',
  openReturn: 'Return on file',
  goal: 'Wants',
  reason: 'Reason',
  issueDescription: 'Problem',
  purchaseTimeHint: 'Bought',
  productQuery: 'Item',
  serialNumber: 'Serial',
  windowDays: 'Claimed window',
  query: 'Query',
  resultCount: 'Results',
};

function FactRow({ attribute, value }: { attribute: string; value: unknown }) {
  const shown =
    attribute === 'priceCents' && typeof value === 'number'
      ? `$${(value / 100).toFixed(2)}`
      : attribute === 'windowDays'
        ? `${String(value)} days`
        : Array.isArray(value)
          ? value.join(', ') || 'none'
          : String(value);
  return (
    <>
      <dt>{FACT_LABELS[attribute] ?? attribute}</dt>
      <dd>{shown}</dd>
    </>
  );
}

// ---------------------------------------------------------------------------------------

const MAIN_NODES = [
  { id: 'prepared', label: 'Prepared', events: ['proposal.prepared'] },
  { id: 'approved', label: 'Approved', events: ['approval.recorded'] },
  { id: 'submitted', label: 'Submitted', events: ['operation.accepted', 'reconciliation.found'] },
  { id: 'confirmed', label: 'Confirmed', events: ['verification.confirmed'] },
] as const;

const SIDE_NODES = [
  { id: 'blocked', label: 'Blocked', events: [] as string[] },
  { id: 'outcome_unknown', label: 'Outcome unknown', events: ['operation.outcome_unknown'] },
  {
    id: 'refused',
    label: 'Refused',
    events: ['operation.rejected', 'verification.refused', 'reconciliation.refused'],
  },
  { id: 'mismatch', label: 'Does not match', events: ['verification.mismatch'] },
];

function LifecyclePanel({ view }: { view: CaseView }) {
  const stage = view.lifecycle.stage;
  const firstAt = (types: readonly string[]) =>
    view.events.find((e) => types.includes(e.type))?.createdAt ?? null;
  const blockedAt =
    view.events.find(
      (e) =>
        e.type === 'assessment.compiled' &&
        ['request_information', 'escalate_for_review'].includes(String(e.data?.['nextStep'])),
    )?.createdAt ?? null;
  const current = (id: string) => stage === id || (id === 'approved' && stage === 'failed');
  return (
    <section className="panel" aria-label="Action lifecycle">
      <h2>Action lifecycle</h2>
      <div className="lifecycle">
        {MAIN_NODES.map((n) => {
          const at = firstAt(n.events);
          return (
            <div
              key={n.id}
              className="lc-node"
              data-node={n.id}
              data-visited={at !== null}
              data-current={current(n.id)}
            >
              {n.label}
              <span className="lc-when">{at ? clock(at) : 'not yet'}</span>
            </div>
          );
        })}
      </div>
      <div className="lc-side">
        {SIDE_NODES.map((n) => {
          const at = n.id === 'blocked' ? blockedAt : firstAt(n.events);
          return (
            <div
              key={n.id}
              className="lc-node"
              data-node={n.id}
              data-visited={at !== null}
              data-current={current(n.id)}
            >
              {n.label}
              <span className="lc-when">{at ? `first ${clock(at)}` : 'never'}</span>
            </div>
          );
        })}
      </div>
      <p className="fine" style={{ marginTop: 12 }}>
        Now: <strong>{view.lifecycle.label}</strong>. {view.lifecycle.detail}
      </p>
      {view.attempts.length > 0 && (
        <table className="matrix" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Call to retailer</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {view.attempts.map((t) => (
              <tr key={t.id}>
                <td>
                  {sentence(t.kind)} <span className="fine">{clock(t.startedAt)}</span>
                </td>
                <td>{sentence(t.outcome.replace(/^\w+\./, ''))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {view.operations[0] && (
        <p className="fine" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>
          Idempotency key, reused on every attempt: {view.operations[0].idempotencyKey}
        </p>
      )}
    </section>
  );
}

const ACTORS: { id: EventRecord['actor']; label: string }[] = [
  { id: 'customer', label: 'Customer' },
  { id: 'mcp_client', label: 'MCP client' },
  { id: 'aftercare', label: 'AFTERCARE' },
  { id: 'retailer', label: 'Retailer (simulated)' },
  { id: 'demo_control', label: 'Demo control' },
];

function TimelinePanel({ events }: { events: EventRecord[] }) {
  const [hidden, setHidden] = useState<string[]>([]);
  const shown = events.filter((e) => !hidden.includes(e.actor));
  return (
    <section className="panel" aria-label="Event timeline">
      <h2>Event timeline ({events.length})</h2>
      <div className="legend" role="group" aria-label="Show events from">
        {ACTORS.map((a) => (
          <label key={a.id} className="toggle">
            <input
              type="checkbox"
              checked={!hidden.includes(a.id)}
              onChange={(e) =>
                setHidden((h) => (e.target.checked ? h.filter((x) => x !== a.id) : [...h, a.id]))
              }
            />
            <span className="tl-dot" data-actor={a.id} aria-hidden="true" />
            {a.label}
          </label>
        ))}
      </div>
      <div className="timeline-scroll">
        <ol className="timeline">
          {shown.map((e) => (
            <li key={e.id}>
              <span className="tl-time">{clock(e.createdAt)}</span>
              <span className="tl-dot" data-actor={e.actor} aria-hidden="true" />
              <span>
                {e.summary}
                <span className="tl-type">{e.type}</span>
                {typeof e.data?.['interpreter'] === 'string' && (
                  <span className="tl-type">read by {e.data['interpreter']}</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function RetailerTruth({ sandbox }: { sandbox: SandboxState }) {
  return (
    <section className="panel truth" aria-label="Simulated retailer records">
      <h2>Inside the simulated retailer</h2>
      <p className="fine" style={{ marginBottom: 12 }}>
        Visible only because Kestrel Goods is a simulation. AFTERCARE never reads this panel’s data
        directly: it learns about the retailer only through its gateway calls, which is why a lost
        response creates real uncertainty.
      </p>
      <div className="comparison">
        <div>
          <h3>Returns on file ({sandbox.returns.length})</h3>
          {sandbox.returns.length === 0 ? (
            <p className="empty">None.</p>
          ) : (
            <ul className="checklist">
              {sandbox.returns.map((r) => (
                <li key={r.rmaId}>
                  <Tick ok={r.status === 'authorized'} />
                  <span>
                    {r.rmaId}: {r.orderId}, {sentence(r.status)}
                    <span className="detail" style={{ overflowWrap: 'anywhere' }}>
                      {r.returnShipping === 'prepaid_label'
                        ? 'Prepaid label'
                        : 'Customer pays shipping'}
                      . Request {r.idempotencyKey}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3>Requests received (latest 8)</h3>
          <div className="table-scroll">
            <table className="matrix">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Request</th>
                  <th>What happened</th>
                </tr>
              </thead>
              <tbody>
                {sandbox.requestLog.slice(-8).map((r, i) => (
                  <tr key={`${r.at}-${i}`}>
                    <td>{clock(r.at)}</td>
                    <td>{sentence(r.operation)}</td>
                    <td>
                      {sentence(r.outcome)}
                      {r.detail && <span className="fine"> {r.detail}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------

const METRICS: {
  key: keyof EvaluationResults['totals']['aftercare'];
  label: string;
  better: 'higher' | 'lower';
}[] = [
  { key: 'outcomeCorrect', label: 'Correct outcome', better: 'higher' },
  { key: 'wrongfulDenial', label: 'Wrongful denials', better: 'lower' },
  { key: 'missedBlocker', label: 'Missed blockers', better: 'lower' },
  { key: 'authorizationViolation', label: 'Authorization violations', better: 'lower' },
  { key: 'wrongTerms', label: 'Wrong terms submitted', better: 'lower' },
  { key: 'unsupportedAction', label: 'Unsupported actions', better: 'lower' },
  { key: 'duplicateAttempts', label: 'Duplicate submission attempts', better: 'lower' },
  { key: 'extraReturnsCreated', label: 'Extra returns created', better: 'lower' },
  { key: 'confirmedBeforeVerifying', label: 'Confirmed before verifying', better: 'lower' },
];

function Comparison({ results }: { results: EvaluationResults }) {
  const n = results.scenarioCount;
  return (
    <section className="panel" aria-label="Measured comparison">
      <h2>Measured: AFTERCARE against a baseline, {n} scenarios</h2>
      <p className="fine" style={{ marginBottom: 16, maxWidth: '90ch' }}>
        Produced by <code>npm run eval</code> from this repository: {n} synthetic scenarios on the
        fictional retailer, with hand-labelled expected outcomes. These are behaviour tests, not
        statistical estimates. Counts are numbers of scenarios (duplicate attempts and extra returns
        count events). {results.baselineDefinition}
      </p>
      <div className="comparison">
        <div>
          {METRICS.map((m) => {
            const av = results.totals.aftercare[m.key];
            const bv = results.totals.baseline[m.key];
            const max = Math.max(n, av, bv, 1);
            return (
              <div className="metric-row" key={m.key}>
                <span>
                  {m.label}
                  <span className="fine" style={{ display: 'block' }}>
                    {m.better === 'higher' ? `out of ${n}, higher is better` : 'lower is better'}
                  </span>
                </span>
                <div className="bars">
                  {(
                    [
                      ['aftercare', 'AFTERCARE', av],
                      ['baseline', 'Baseline', bv],
                    ] as const
                  ).map(([id, label, v]) => (
                    <div className="bar" data-agent={id} key={id}>
                      <span>{label}</span>
                      <span className="bar-track" aria-hidden="true">
                        <span
                          className="bar-fill"
                          style={{ width: `${(v / max) * 100}%`, display: 'block' }}
                        />
                      </span>
                      <span className="bar-value">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="table-scroll">
          <table className="matrix">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Expected</th>
                <th>AFTERCARE</th>
                <th>Baseline</th>
              </tr>
            </thead>
            <tbody>
              {results.scenarios.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.id}</strong> {s.title}
                  </td>
                  <td>{sentence(s.expected.outcome)}</td>
                  <td className={s.aftercare.metrics.outcomeCorrect ? 'mark-ok' : 'mark-bad'}>
                    {sentence(s.aftercare.claim)} {s.aftercare.metrics.outcomeCorrect ? '✓' : '✗'}
                  </td>
                  <td className={s.baseline.metrics.outcomeCorrect ? 'mark-ok' : 'mark-bad'}>
                    {sentence(s.baseline.claim)} {s.baseline.metrics.outcomeCorrect ? '✓' : '✗'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <details className="more">
        <summary>Metric definitions</summary>
        <dl className="facts" style={{ marginTop: 8 }}>
          {Object.entries(results.metricDefinitions).map(([k, v]) => (
            <FragmentRow
              key={k}
              label={METRICS.find((m) => m.key === k)?.label ?? k}
              value=""
              detail={v}
            />
          ))}
        </dl>
      </details>
    </section>
  );
}
