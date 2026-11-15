// The point History looks back to: 「那天的樣子」 (the end of a day) or 「回到這之前」 (just before one
// change). `at` is the instant sent to the server; `labelAt` is the moment a person recognises it by
// (the change's own time), so 「還原到 10/23 下午06:00」 names the save, not the millisecond before it.
import { t } from "../../lib/i18n";
import { dateLabel, timeLabel } from "../../lib/timeLabels";

export type Cut = { at: string; labelAt: string; kind: "day" | "before"; day?: string };

/** How a day looked when it ended (the present, for a day that is not over). `endAt` is the
 *  server's end of that day (FeedDay.end_at, in the zone and day start it cut the days with). */
export function cutForDayEnd(day: string, endAt: string, now: Date = new Date()): Cut {
  const end = new Date(endAt);
  const at = end.getTime() > now.getTime() ? now : end;
  return { at: at.toISOString(), labelAt: at.toISOString(), kind: "day", day };
}

/** The instant just before something happened at `iso` (a note's first save of the day, an AI run's start). */
export function cutBefore(iso: string): Cut {
  return { at: new Date(Date.parse(iso) - 1).toISOString(), labelAt: iso, kind: "before" };
}

/** Changes at or after the cut are the ones a rewind would undo. */
export function isAfterCut(cut: Cut | null, iso: string): boolean {
  return cut !== null && Date.parse(iso) > Date.parse(cut.at);
}

/** "10/23" from a YYYY-MM-DD workspace day. */
export const monthDayOf = (date: string): string => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

/** "10/23 下午06:00" for a moment; "10/23 結束時" for the end of a day. */
export function cutWhen(cut: Pick<Cut, "labelAt" | "kind" | "day">): string {
  if (cut.kind === "day" && cut.day) return t("the end of {date}", { date: monthDayOf(cut.day) });
  return whenLabel(cut.labelAt);
}
export const whenLabel = (iso: string): string => `${dateLabel(iso, "monthDay")} ${timeLabel(iso)}`;
