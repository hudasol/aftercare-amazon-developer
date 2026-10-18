export function money(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export function longDate(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  });
}

export function clock(instant: string): string {
  return new Date(instant).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function relative(instant: string): string {
  const seconds = Math.round((Date.now() - Date.parse(instant)) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(instant).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function sentence(text: string): string {
  const t = text.replaceAll('_', ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export type Tone = 'good' | 'gate' | 'unknown' | 'stop' | 'neutral';

/** Presentation only: which colour family a server-reported state is drawn in. */
export function toneForState(state: string): Tone {
  switch (state) {
    case 'resolved':
      return 'good';
    case 'needs_information':
    case 'needs_review':
    case 'awaiting_approval':
      return 'gate';
    case 'needs_reconciliation':
      return 'unknown';
    case 'not_eligible':
    case 'closed':
      return 'stop';
    default:
      return 'neutral';
  }
}
