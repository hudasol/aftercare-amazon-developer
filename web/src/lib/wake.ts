/**
 * Waiting for a sleeping demo server.
 *
 * The free hosting plan stops the server after a period without traffic. While
 * it starts again, which takes about a minute, requests fail with HTTP 502,
 * 503 or 504, a page that is not ours, or a network error. These helpers retry
 * such failures for up to about 90 seconds and report that the demo is waking,
 * so the interface can say so instead of showing an error.
 */

export type WakeState = 'awake' | 'waking';

const listeners = new Set<(state: WakeState) => void>();
let waiting = 0;

export function wakeState(): WakeState {
  return waiting > 0 ? 'waking' : 'awake';
}

export function onWakeState(listener: (state: WakeState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changeWaiting(delta: number): void {
  const before = wakeState();
  waiting += delta;
  const after = wakeState();
  if (after !== before) listeners.forEach((l) => l(after));
}

/** Status codes a proxy returns while the server behind it is starting. */
export const WAKE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** An HTTP answer that did not come from AFTERCARE itself. */
export class NotReadyError extends Error {
  constructor(readonly status: number) {
    super(`The demo server is not ready yet (HTTP ${status}).`);
  }
}

export interface RetryOptions {
  /** Give up after this long. Default 90 seconds. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Runs `attempt` until it succeeds. Failures for which `isWakeFailure` is true
 * are retried with growing pauses until `maxWaitMs` has passed; any other
 * failure, or the last one, is thrown.
 */
export async function retryWhileWaking<T>(
  attempt: () => Promise<T>,
  isWakeFailure: (error: unknown) => boolean,
  options: RetryOptions = {},
): Promise<T> {
  const maxWaitMs = options.maxWaitMs ?? 90_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => globalThis.setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
  const started = now();
  let pause = 1000;
  let counted = false;
  try {
    for (;;) {
      try {
        return await attempt();
      } catch (error) {
        const left = maxWaitMs - (now() - started);
        if (!isWakeFailure(error) || left <= 0) throw error;
        if (!counted) {
          counted = true;
          changeWaiting(1);
        }
        await sleep(Math.min(pause, left));
        pause = Math.min(pause * 2, 8000);
      }
    }
  } finally {
    if (counted) changeWaiting(-1);
  }
}

/** A network failure, or an answer from a proxy rather than from AFTERCARE. */
export function isWakeFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof NotReadyError && (WAKE_STATUSES.has(error.status) || error.status === 200))
  );
}

/**
 * Resolves once the server answers its health check, waiting while it wakes.
 * Safe to repeat: the health check changes nothing.
 */
export function ensureAwake(
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
  options: RetryOptions = {},
): Promise<void> {
  return retryWhileWaking(
    async () => {
      const res = await fetchImpl('/api/health', { headers: { accept: 'application/json' } });
      const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      if (!res.ok || body?.ok !== true) throw new NotReadyError(res.status);
    },
    isWakeFailure,
    options,
  );
}
