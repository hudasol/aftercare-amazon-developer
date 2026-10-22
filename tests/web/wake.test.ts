import { describe, expect, it } from 'vitest';
import {
  ensureAwake,
  isWakeFailure,
  NotReadyError,
  onWakeState,
  retryWhileWaking,
  type WakeState,
} from '../../web/src/lib/wake.js';

/** A clock that only moves when the code under test sleeps. */
function fakeTime() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('waiting for the hosted demo to wake', () => {
  it('retries proxy errors and network failures until the server answers', async () => {
    const time = fakeTime();
    const answers: (() => Response)[] = [
      () => {
        throw new TypeError('Failed to fetch');
      },
      () => new Response('<html>starting</html>', { status: 503 }),
      () => new Response('<html>Service waking</html>', { status: 200 }),
      () => json(200, { ok: true }),
    ];
    const states: WakeState[] = [];
    const stop = onWakeState((s) => states.push(s));
    let calls = 0;
    await ensureAwake(
      (() => Promise.resolve().then(() => (answers[calls++] as () => Response)())) as typeof fetch,
      time,
    );
    stop();
    expect(calls).toBe(4);
    expect(time.sleeps).toEqual([1000, 2000, 4000]);
    expect(states).toEqual(['waking', 'awake']);
  });

  it('gives up after about 90 seconds and reports the last failure', async () => {
    const time = fakeTime();
    const states: WakeState[] = [];
    const stop = onWakeState((s) => states.push(s));
    await expect(
      ensureAwake((() => Promise.resolve(json(502, {}))) as typeof fetch, time),
    ).rejects.toBeInstanceOf(NotReadyError);
    stop();
    expect(time.now()).toBe(90_000);
    expect(Math.max(...time.sleeps)).toBe(8000);
    expect(states).toEqual(['waking', 'awake']);
  });

  it('does not retry an ordinary error', async () => {
    const time = fakeTime();
    let calls = 0;
    await expect(
      retryWhileWaking(
        () => {
          calls += 1;
          return Promise.reject(new Error('Case not found'));
        },
        isWakeFailure,
        time,
      ),
    ).rejects.toThrow('Case not found');
    expect(calls).toBe(1);
    expect(time.sleeps).toEqual([]);
  });

  it('treats only proxy statuses and foreign pages as waking', () => {
    expect(isWakeFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isWakeFailure(new NotReadyError(502))).toBe(true);
    expect(isWakeFailure(new NotReadyError(504))).toBe(true);
    expect(isWakeFailure(new NotReadyError(200))).toBe(true);
    expect(isWakeFailure(new NotReadyError(500))).toBe(false);
    expect(isWakeFailure(new NotReadyError(429))).toBe(false);
  });
});
