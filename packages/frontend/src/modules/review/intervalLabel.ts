import { tn } from "../../lib/i18n";

/** How long until a card comes back, in words a person uses: days up to a
 *  month, then months, then years ("in 1 day", "in 12 days", "in 3 months", "in 1.5 years").
 *  `days` is what the server's scheduler answered (ReviewIntervals). */
export function intervalLabel(days: number): string {
  if (days < 30) return tn("in {n} day", "in {n} days", Math.max(1, Math.round(days)));
  if (days < 365) return tn("in {n} month", "in {n} months", Math.round(days / 30));
  const years = Math.round((days / 365) * 10) / 10;
  return tn("in {n} year", "in {n} years", years);
}
