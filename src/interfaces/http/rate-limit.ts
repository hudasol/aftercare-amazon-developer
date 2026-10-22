/**
 * A small in memory rate limit for /mcp and /api, so one script cannot take
 * the shared demo down. Fixed one minute windows per client address. It keeps
 * no state across restarts and is not meant for more than one process.
 */
import type { NextFunction, Request, Response } from 'express';

const WINDOW_MS = 60_000;
/** Forget idle clients once this many are tracked. */
const PRUNE_ABOVE = 10_000;

export interface RateLimitOptions {
  /** Requests allowed per client per minute; 0 turns the limit off. */
  perMinute: number;
  /**
   * Use the last X-Forwarded-For entry as the client address. Only correct
   * behind exactly one trusted proxy, such as the hosting platform's.
   */
  trustProxy: boolean;
  now?: () => number;
}

function clientKey(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const list = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? ''))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const last = list.at(-1);
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function rateLimit(options: RateLimitOptions) {
  const now = options.now ?? (() => Date.now());
  const windows = new Map<string, { start: number; count: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    if (options.perMinute <= 0) {
      next();
      return;
    }
    const t = now();
    const key = clientKey(req, options.trustProxy);
    let window = windows.get(key);
    if (!window || t - window.start >= WINDOW_MS) {
      window = { start: t, count: 0 };
      windows.set(key, window);
    }
    window.count += 1;
    if (windows.size > PRUNE_ABOVE) {
      for (const [k, w] of windows) if (t - w.start >= WINDOW_MS) windows.delete(k);
    }
    if (window.count > options.perMinute) {
      res
        .status(429)
        .set('Retry-After', String(Math.max(1, Math.ceil((window.start + WINDOW_MS - t) / 1000))))
        .json({
          error: {
            code: 'rate_limited',
            message: 'Too many requests from this address. Wait a minute and try again.',
          },
        });
      return;
    }
    next();
  };
}
