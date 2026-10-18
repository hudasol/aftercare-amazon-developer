/**
 * Calendar-date arithmetic for policy evaluation.
 *
 * Business dates (order dates, delivery dates, the "as of" date a case is
 * evaluated on) are plain ISO calendar dates (YYYY-MM-DD) with no time zone.
 * Event timestamps elsewhere are full ISO instants; they never feed eligibility.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export type IsoDate = string;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function toUtcMs(date: IsoDate): number {
  if (!isIsoDate(date)) throw new RangeError(`Not an ISO calendar date: ${date}`);
  return Date.parse(`${date}T00:00:00Z`);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(toUtcMs(date) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / MS_PER_DAY);
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return toUtcMs(a) - toUtcMs(b);
}

/** True when `date` falls inside [from, to]; a null bound is open. */
export function isWithin(date: IsoDate, from: IsoDate | null, to: IsoDate | null): boolean {
  if (from !== null && compareDates(date, from) < 0) return false;
  if (to !== null && compareDates(date, to) > 0) return false;
  return true;
}

export function formatLongDate(date: IsoDate): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
