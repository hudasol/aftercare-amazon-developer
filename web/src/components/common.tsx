import type { JourneyStage } from '../lib/types';
import { toneForState } from '../lib/format';

const STATUS_TEXT: Record<JourneyStage['status'], string> = {
  done: 'done',
  current: 'in progress',
  waiting_on_customer: 'waiting for you',
  paused: 'paused for review',
  unknown: 'outcome unknown',
  stopped: 'stopped',
  upcoming: 'not started',
};

export function Journey({
  stages,
  label = 'Case progress',
}: {
  stages: JourneyStage[];
  label?: string;
}) {
  return (
    <ol className="journey" aria-label={label}>
      {stages.map((s) => (
        <li
          key={s.id}
          data-status={s.status}
          aria-current={
            s.status === 'current' || s.status === 'waiting_on_customer' ? 'step' : undefined
          }
        >
          <span className="stop" aria-hidden="true" />
          <span className="stage-label">{s.label}</span>
          <span className="stage-note">
            <span className="visually-hidden">{STATUS_TEXT[s.status]}. </span>
            {s.note}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function StatePill({ state, label }: { state: string; label: string }) {
  const tone = toneForState(state);
  return (
    <span className="pill" data-tone={tone === 'neutral' ? undefined : tone}>
      {label}
    </span>
  );
}

export function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16">
        <path
          d="M3.5 8.5l3 3 6-7"
          fill="none"
          stroke="#f5f7f6"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function Tick({ ok }: { ok: boolean }) {
  return ok ? (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-label="met" role="img">
      <circle cx="8" cy="8" r="7" fill="var(--evergreen-tint)" />
      <path
        d="M4.5 8.3l2.2 2.2 4.6-5"
        fill="none"
        stroke="var(--evergreen)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-label="not met" role="img">
      <rect x="1" y="1" width="14" height="14" rx="3" fill="var(--amber-tint)" />
      <path d="M5 8h6" stroke="var(--amber)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
