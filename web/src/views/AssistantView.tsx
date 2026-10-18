import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Journey, StatePill } from '../components/common';
import { api } from '../lib/api';
import { longDate, money, relative, shortDate } from '../lib/format';
import { callTool, ToolError } from '../lib/mcp';
import { navigate } from '../lib/router';
import { canListen, canSpeak, listen, speak, stopSpeaking } from '../lib/speech';
import type { CaseSummary, CaseView, Proposal, Session, ToolCaseResult } from '../lib/types';

const FLAGSHIP =
  'My wireless headphones keep disconnecting. I bought them recently. Can you help me return them?';
const STARTERS = [
  FLAGSHIP,
  'I want to return my wireless headphones.',
  'My pour-over set arrived and I changed my mind. Can I send it back?',
];
const FOLLOW_UP_DELAY_MS = 1400;
const MAX_FOLLOW_UPS = 4;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function AssistantView({
  caseId,
  session,
}: {
  caseId: string | null;
  session: Session | null;
}) {
  const [loaded, setView] = useState<CaseView | null>(null);
  const view = caseId && loaded?.case.id === caseId ? loaded : null;
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readAloud, setReadAloud] = useState(false);
  const readAloudRef = useRef(readAloud);
  useEffect(() => {
    readAloudRef.current = readAloud;
  }, [readAloud]);
  const endRef = useRef<HTMLDivElement>(null);

  const refreshCases = useCallback(() => {
    api
      .cases()
      .then(setCases)
      .catch(() => undefined);
  }, []);

  const load = useCallback(async (id: string) => {
    const next = await api.getCase(id);
    setView(next);
    return next;
  }, []);

  useEffect(() => {
    refreshCases();
    if (caseId) {
      api
        .getCase(caseId)
        .then(setView)
        .catch((e: unknown) =>
          setError(e instanceof Error ? e.message : 'Could not load the case.'),
        );
    }
  }, [caseId, refreshCases]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [view?.messages.length, busy]);

  /** Run one MCP tool call, then re-read the persisted case. */
  const run = useCallback(
    async (
      label: string,
      tool: string,
      args: Record<string, unknown>,
    ): Promise<CaseView | null> => {
      setBusy(label);
      setError(null);
      try {
        const result = await callTool<ToolCaseResult>(tool, args);
        if (readAloudRef.current) speak(result.speech);
        if (result.caseId !== caseId) navigate({ view: 'assistant', caseId: result.caseId });
        const next = await load(result.caseId);
        refreshCases();
        return next;
      } catch (e) {
        setError(
          e instanceof ToolError || e instanceof Error ? e.message : 'Something went wrong.',
        );
        if (caseId) await load(caseId).catch(() => undefined);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [caseId, load, refreshCases],
  );

  /** After a submission, keep checking until the outcome is known or the case stops. */
  const followUp = useCallback(
    async (start: CaseView) => {
      let current: CaseView | null = start;
      for (let i = 0; i < MAX_FOLLOW_UPS && current; i++) {
        const state = current.case.state;
        if (state !== 'needs_reconciliation' && state !== 'awaiting_verification') return;
        setBusy(
          state === 'needs_reconciliation'
            ? 'Checking whether Kestrel Goods received it…'
            : 'Checking the return with Kestrel Goods…',
        );
        await wait(FOLLOW_UP_DELAY_MS);
        current = await run('Checking…', 'check_return_outcome', { caseId: current.case.id });
      }
    },
    [run],
  );

  const send = (text: string) =>
    view && !['resolved', 'closed'].includes(view.case.state)
      ? run('Thinking…', 'continue_case', { caseId: view.case.id, customerMessage: text })
      : run('Opening your case…', 'start_return_case', { customerRequest: text });

  const approve = async (proposal: Proposal) => {
    if (!view) return;
    const approved = await run('Recording your approval…', 'approve_proposed_return', {
      caseId: view.case.id,
      proposalId: proposal.id,
      proposalDigest: proposal.digest,
      // What the client actually captured: the control the customer used, not invented words.
      customerConfirmation: `Pressed “Approve and send return” on the return slip for order ${proposal.parameters.orderId} (${money(proposal.parameters.refundAmountCents, proposal.parameters.currency)}).`,
    });
    if (approved?.case.state === 'ready_to_submit') await submit(proposal.id, approved);
  };

  const submit = async (proposalId: string, from: CaseView) => {
    const submitted = await run('Sending your return to Kestrel Goods…', 'submit_approved_return', {
      caseId: from.case.id,
      proposalId,
    });
    if (submitted) await followUp(submitted);
  };

  const a = view?.assessment ?? null;
  const proposal = view
    ? ([...view.proposals]
        .reverse()
        .find((p) => p.status === 'prepared' || p.status === 'approved') ?? null)
    : null;
  const lastConfirmedProposal = view?.lifecycle.proposalId
    ? (view.proposals.find((p) => p.id === view.lifecycle.proposalId) ?? null)
    : null;

  return (
    <main className="assistant" id="main">
      <section className="conversation" aria-label="Conversation">
        {caseId && !view ? (
          error ? (
            <div className="welcome">
              <h1>That case couldn’t be opened</h1>
              <p className="welcome-lede">
                It may belong to someone else or no longer exist. Your own cases are listed on the
                right.
              </p>
              <button
                className="btn btn-primary"
                style={{ marginTop: 24 }}
                onClick={() => navigate({ view: 'assistant', caseId: null })}
              >
                Start a new case
              </button>
            </div>
          ) : (
            <p className="thinking" role="status" style={{ marginTop: 48 }}>
              Loading your case…
            </p>
          )
        ) : !view ? (
          <Welcome onStart={(t) => void send(t)} busy={busy !== null} />
        ) : (
          <>
            <div className="now" aria-live="polite">
              <p className="now-speech">{a?.nextStep.speech ?? view.case.stateLabel}</p>
              <div className="now-meta">
                <StatePill state={view.case.state} label={view.case.stateLabel} />
                <span>
                  Policies checked as of {longDate(view.case.asOf)}{' '}
                  <span className="demo-tag">demo date</span>
                </span>
              </div>
            </div>
            <ol className="transcript">
              {view.messages.map((m, i) => {
                const latest =
                  m.role === 'assistant' &&
                  view.messages.slice(i + 1).every((n) => n.role !== 'assistant');
                return (
                  <li key={m.id} className={`turn turn-${m.role}`} data-latest={latest}>
                    <span className="turn-who">{m.role === 'customer' ? 'You' : 'AFTERCARE'}</span>
                    {m.text}
                  </li>
                );
              })}
            </ol>
            <ActionArea
              view={view}
              proposal={proposal ?? lastConfirmedProposal}
              busy={busy !== null}
              onSerial={(serial) =>
                void run('Checking that serial…', 'provide_item_serial', {
                  caseId: view.case.id,
                  serialNumber: serial,
                })
              }
              onReply={(text) => void send(text)}
              onApprove={(p) => void approve(p)}
              onDecline={(p) =>
                void run('Closing the case…', 'decline_proposed_return', {
                  caseId: view.case.id,
                  proposalId: p.id,
                })
              }
              onSubmit={(p) => void submit(p.id, view)}
              onCheck={() =>
                void run('Checking…', 'check_return_outcome', { caseId: view.case.id }).then(
                  (v) => v && followUp(v),
                )
              }
            />
          </>
        )}
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
        <div ref={endRef} />
        <Composer
          disabled={busy !== null}
          placeholder={
            view ? 'Reply to AFTERCARE…' : 'Describe what went wrong with your purchase…'
          }
          onSend={(t) => void send(t)}
          readAloud={readAloud}
          onReadAloud={(on) => {
            setReadAloud(on);
            if (!on) stopSpeaking();
          }}
        />
      </section>

      <aside className="side" aria-label="Case details">
        {view && (
          <div className="panel">
            <div className="case-head">
              <div>
                <p className="case-title">{view.case.title}</p>
                <p className="case-id">Case {view.case.id}</p>
              </div>
              <StatePill state={view.case.state} label={view.case.stateLabel} />
            </div>
            <Journey stages={view.journey} />
          </div>
        )}
        {view && a && <Findings view={view} />}
        {view && (
          <a
            className="btn"
            href={`/lab/${view.case.id}`}
            onClick={(e) => {
              e.preventDefault();
              navigate({ view: 'lab', caseId: view.case.id });
            }}
          >
            See how this was decided
          </a>
        )}
        <div className="panel">
          <h2>Your cases</h2>
          {cases.length === 0 ? (
            <p className="empty">No cases yet. Describe a problem to start one.</p>
          ) : (
            <ul className="cases-list">
              {cases.map((c) => (
                <li key={c.id}>
                  <a
                    href={`/cases/${c.id}`}
                    aria-current={c.id === caseId ? 'page' : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate({ view: 'assistant', caseId: c.id });
                    }}
                  >
                    <strong>{c.title}</strong>
                    <StatePill state={c.state} label={c.stateLabel} />
                    <span className="sub">{c.headline ?? ''}</span>
                    <span className="sub">Updated {relative(c.updatedAt)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {view && (
            <button
              className="btn btn-small"
              style={{ marginTop: 12 }}
              onClick={() => navigate({ view: 'assistant', caseId: null })}
            >
              Start a new case
            </button>
          )}
        </div>
        {session && (
          <p className="fine">
            Acting as {session.customerName}. {session.retailer.name} is a simulated retailer: no
            real orders, returns or refunds are created.
          </p>
        )}
      </aside>
    </main>
  );
}

function Welcome({ onStart, busy }: { onStart: (text: string) => void; busy: boolean }) {
  return (
    <div className="welcome">
      <h1>Something wrong with a purchase?</h1>
      <p className="welcome-lede">
        Tell AFTERCARE what happened. It checks your order and the store’s actual policy, asks only
        for what it needs, and does nothing on your behalf until you approve the exact terms.
      </p>
      <ul className="promise">
        {[
          'Every answer is backed by a record you can inspect.',
          'If something is uncertain, it says so instead of guessing.',
          'Nothing is called done until the store confirms it.',
        ].map((t) => (
          <li key={t}>
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <path
                d="M4 10.5l4 4 8-9"
                fill="none"
                stroke="var(--evergreen)"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{t}</span>
          </li>
        ))}
      </ul>
      <div className="starters">
        <p className="fine">Try one (fictional demo account):</p>
        {STARTERS.map((s) => (
          <button key={s} className="starter" disabled={busy} onClick={() => onStart(s)}>
            “{s}”
          </button>
        ))}
      </div>
    </div>
  );
}

interface ActionAreaProps {
  view: CaseView;
  proposal: Proposal | null;
  busy: boolean;
  onSerial: (serial: string) => void;
  onReply: (text: string) => void;
  onApprove: (p: Proposal) => void;
  onDecline: (p: Proposal) => void;
  onSubmit: (p: Proposal) => void;
  onCheck: () => void;
}

function ActionArea(props: ActionAreaProps) {
  const { view, proposal, busy } = props;
  const a = view.assessment;
  const state = view.case.state;
  const need = a?.missing.find((m) => m.obtainableFrom === 'customer' && m.blocking);

  if (state === 'needs_information' && need?.id === 'item_serial') {
    const location = view.evidence
      .flatMap((e) => e.facts)
      .find((f) => f.attribute === 'serialLocation' && typeof f.value === 'string')?.value as
      string | undefined;
    return (
      <SerialGate
        why={need.why}
        location={location ?? null}
        onSubmit={props.onSerial}
        busy={busy}
        rejected={view.evidence.some(
          (e) => e.kind === 'item_serial' && e.verification === 'failed',
        )}
      />
    );
  }
  if (state === 'needs_information' && need?.id === 'return_reason') {
    return (
      <div className="gate">
        <h3>Why are you returning them?</h3>
        <p>Faulty items and unwanted items follow different rules and shipping terms.</p>
        <div className="row" style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button
            className="btn"
            disabled={busy}
            onClick={() => props.onReply('Something is wrong with them, they are faulty.')}
          >
            Something’s wrong with them
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => props.onReply('Nothing is wrong, I just changed my mind.')}
          >
            I just don’t want them
          </button>
        </div>
      </div>
    );
  }
  if (state === 'needs_review') {
    const refused = view.lifecycle.stage === 'refused';
    const mismatch = view.lifecycle.stage === 'mismatch';
    return (
      <div className="gate" data-tone={refused || mismatch ? 'stop' : undefined}>
        <h3>
          {refused
            ? 'The store refused this return'
            : mismatch
              ? 'The store’s return doesn’t match what you approved'
              : 'Paused for review'}
        </h3>
        {(a?.blockers ?? []).map((b) => (
          <p key={b.code}>{b.customerExplanation}</p>
        ))}
        <p className="hint">Nothing further will be submitted. {a?.blockers[0]?.resolvesWith}</p>
      </div>
    );
  }
  if (state === 'not_eligible') {
    return (
      <div className="gate" data-tone="stop">
        <h3>This item can’t be returned</h3>
        <p>{a?.eligibility.explanation}</p>
        {a?.eligibility.alternative === 'manufacturer_warranty' && (
          <p className="hint">
            Next step: the manufacturer’s warranty. Your case keeps the order details you’ll need.
          </p>
        )}
      </div>
    );
  }
  if (
    proposal &&
    [
      'awaiting_approval',
      'ready_to_submit',
      'executing',
      'needs_reconciliation',
      'awaiting_verification',
      'resolved',
    ].includes(state)
  ) {
    return <Slip {...props} proposal={proposal} />;
  }
  return null;
}

function SerialGate(props: {
  why: string;
  location: string | null;
  onSubmit: (s: string) => void;
  busy: boolean;
  rejected: boolean;
}) {
  const { onSubmit, busy, rejected } = props;
  const [serial, setSerial] = useState('');
  const [invalid, setInvalid] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = serial.trim();
    if (!/^[A-Za-z0-9-]{4,32}$/.test(value)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onSubmit(value);
    setSerial('');
  };
  return (
    <div className="gate">
      <h3>Which one do you have?</h3>
      <p>{props.why} The serial number on the item tells them apart.</p>
      <form onSubmit={submit}>
        <label className="visually-hidden" htmlFor="serial">
          Serial number
        </label>
        <input
          id="serial"
          value={serial}
          onChange={(e) => setSerial(e.target.value)}
          placeholder="HA-…"
          autoComplete="off"
          aria-invalid={invalid}
          aria-describedby="serial-hint"
        />
        <button className="btn btn-primary" disabled={busy || serial.trim().length === 0}>
          Check serial
        </button>
      </form>
      <p className="hint" id="serial-hint">
        {props.location
          ? `It’s printed ${props.location}.`
          : 'Look for a label on the item or its box.'}
      </p>
      {invalid && (
        <p className="field-error">A serial number uses only letters, numbers and dashes.</p>
      )}
      {rejected && !invalid && (
        <p className="field-error">
          The last serial didn’t match either order. Check it and try again.
        </p>
      )}
    </div>
  );
}

function Slip({
  view,
  proposal,
  busy,
  onApprove,
  onDecline,
  onSubmit,
  onCheck,
}: ActionAreaProps & { proposal: Proposal }) {
  const p = proposal.parameters;
  const stage = view.lifecycle.stage;
  const op = view.operations.find((o) => o.proposalId === proposal.id) ?? null;
  const stamp =
    stage === 'confirmed'
      ? { text: 'CONFIRMED', tone: 'good' }
      : stage === 'outcome_unknown'
        ? { text: 'OUTCOME UNKNOWN', tone: 'unknown' }
        : stage === 'submitted'
          ? { text: 'SUBMITTED', tone: 'ink' }
          : stage === 'approved'
            ? { text: 'APPROVED', tone: 'ink' }
            : stage === 'refused'
              ? { text: 'REFUSED', tone: 'stop' }
              : null;
  const labelUrl =
    typeof op?.observed?.['labelUrl'] === 'string' ? (op.observed['labelUrl'] as string) : null;

  return (
    <article className="slip" data-stage={stage} aria-label="Return proposal">
      {stamp && (
        <span className="slip-stamp" data-tone={stamp.tone}>
          {stamp.text}
        </span>
      )}
      <p className="slip-kind">Return for a refund</p>
      <p className="slip-amount">{money(p.refundAmountCents, p.currency)}</p>
      <dl className="facts">
        <dt>Item</dt>
        <dd>{p.productName}</dd>
        <dt>Order</dt>
        <dd>{p.orderId}</dd>
        <dt>Reason</dt>
        <dd>{p.reason === 'defective' ? 'Faulty' : 'Changed my mind'}</dd>
        <dt>Shipping</dt>
        <dd>
          {p.returnShipping === 'prepaid_label'
            ? 'Prepaid label from Kestrel Goods'
            : 'You pay return shipping'}
        </dd>
        <dt>Return by</dt>
        <dd>{longDate(p.returnBy)}</dd>
        <dt>Policy</dt>
        <dd>
          Kestrel Goods v{p.policyVersion}, rule {p.policyRuleId}
        </dd>
        {op?.externalRef && (
          <>
            <dt>Store reference</dt>
            <dd>{op.externalRef}</dd>
          </>
        )}
        {labelUrl && (
          <>
            <dt>Label</dt>
            <dd>
              Ready <span className="demo-tag">demo, not a real label</span>
            </dd>
          </>
        )}
      </dl>
      <p className="slip-fingerprint">
        Approval fingerprint {proposal.digest.slice(0, 8)}…{proposal.digest.slice(-6)}
      </p>

      <div className="slip-stub">
        {stage === 'prepared' && (
          <div className="slip-actions">
            <p>
              You’re approving exactly this return, and it will be sent to the store. Nothing is
              sent until you do.
            </p>
            <button className="btn btn-approve" disabled={busy} onClick={() => onApprove(proposal)}>
              Approve and send return
            </button>
            <button className="btn btn-quiet" disabled={busy} onClick={() => onDecline(proposal)}>
              Don’t return them
            </button>
          </div>
        )}
        {stage === 'approved' && (
          <div className="slip-actions">
            <p>
              {op?.status === 'failed'
                ? 'The store’s system didn’t process the last attempt, and nothing was created. Your approval still covers this exact return.'
                : 'Approved. Ready to send to the store.'}
            </p>
            <button className="btn btn-primary" disabled={busy} onClick={() => onSubmit(proposal)}>
              {op?.status === 'failed' ? 'Try sending again' : 'Send return'}
            </button>
          </div>
        )}
        {stage === 'outcome_unknown' && (
          <div className="slip-actions">
            <p>
              The store didn’t answer clearly, so this return may or may not exist. AFTERCARE won’t
              send it again until it has checked the store’s records.
            </p>
            <button className="btn" disabled={busy} onClick={onCheck}>
              Check with the store now
            </button>
          </div>
        )}
        {stage === 'submitted' && (
          <div className="slip-actions">
            <p>
              The store accepted the request. It isn’t confirmed until the store’s record matches
              what you approved.
            </p>
            <button className="btn" disabled={busy} onClick={onCheck}>
              Check again
            </button>
          </div>
        )}
        {stage === 'confirmed' && (
          <p>
            Verified against the store’s record. Your refund is issued when Kestrel Goods receives
            the item.
          </p>
        )}
      </div>
    </article>
  );
}

function Findings({ view }: { view: CaseView }) {
  const a = view.assessment;
  if (!a) return null;
  const candidates = a.subject.candidates;
  return (
    <div className="panel">
      <h2>What AFTERCARE checked</h2>
      <dl className="facts">
        {a.subject.orderId ? (
          <>
            <dt>Order</dt>
            <dd>{a.subject.orderId}</dd>
          </>
        ) : (
          <>
            <dt>Matching orders</dt>
            <dd>
              {candidates.length === 0
                ? 'None yet'
                : candidates
                    .map((c) => `${c.orderId} (delivered ${shortDate(c.deliveredOn)})`)
                    .join(', ')}
            </dd>
          </>
        )}
        {a.policy.governingVersion && (
          <>
            <dt>Policy</dt>
            <dd>v{a.policy.governingVersion} (in effect when you ordered)</dd>
          </>
        )}
        {a.eligibility.deadline && (
          <>
            <dt>{a.eligibility.status === 'eligible' ? 'Return by' : 'Window closed'}</dt>
            <dd>{longDate(a.eligibility.deadline)}</dd>
          </>
        )}
        <dt>Records</dt>
        <dd>
          {view.evidence.length} items{' '}
          {view.evidence.some((e) => e.simulated) && <span className="demo-tag">demo data</span>}
        </dd>
      </dl>
    </div>
  );
}

function Composer(props: {
  disabled: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  readAloud: boolean;
  onReadAloud: (on: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value || props.disabled) return;
    props.onSend(value);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
  const toggleMic = () => {
    if (listening) {
      stopRef.current?.();
      return;
    }
    setVoiceError(null);
    setListening(true);
    stopRef.current = listen({
      onText: (t) => setText((prev) => (prev ? `${prev} ${t}` : t)),
      onEnd: () => setListening(false),
      onError: setVoiceError,
    });
  };

  return (
    <div className="composer">
      <form onSubmit={submit}>
        <label htmlFor="message" className="visually-hidden">
          Message
        </label>
        <textarea
          id="message"
          rows={1}
          value={text}
          placeholder={props.placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          maxLength={2000}
        />
        {canListen() && (
          <button
            type="button"
            className="btn mic"
            aria-pressed={listening}
            onClick={toggleMic}
            title="Speak instead of typing"
          >
            {listening ? 'Listening…' : 'Speak'}
          </button>
        )}
        <button className="btn btn-primary" disabled={props.disabled || text.trim().length === 0}>
          Send
        </button>
      </form>
      <div className="composer-tools">
        {canSpeak() && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={props.readAloud}
              onChange={(e) => props.onReadAloud(e.target.checked)}
            />
            Read replies aloud
          </label>
        )}
        {voiceError && <span role="alert">{voiceError}</span>}
      </div>
    </div>
  );
}
