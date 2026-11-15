// How an event reads on the timeline: its time and the calendar it comes from. Pure.

import type { ExternalEvent } from "../../../../lib/externalCalendars";
import { clockLabel } from "../../../../lib/dayWindow";
import { dayIdLabel } from "../../../../lib/timeLabels";

/** "10:00–11:00" for a timed event, "" for an all-day one (the strip says that itself). */
export function eventClock(event: Pick<ExternalEvent, "all_day" | "starts_at" | "ends_at">): string {
  if (event.all_day) return "";
  const start = clockLabel(event.starts_at);
  return event.ends_at > event.starts_at ? `${start}–${clockLabel(event.ends_at)}` : start;
}

/** The dates an event covers: one day, or "first – last" when it spans several. */
export function eventDays(event: Pick<ExternalEvent, "start_day" | "end_day">): string {
  return event.start_day === event.end_day
    ? dayIdLabel(event.start_day, "long")
    : `${dayIdLabel(event.start_day, "medium")} – ${dayIdLabel(event.end_day, "medium")}`;
}

/** The first lines of the note made from an event: when, and where. */
export function eventNoteBody(event: ExternalEvent, allDayLabel: string, placeLabel: string): string {
  const when = [eventDays(event), event.all_day ? allDayLabel : eventClock(event)].filter(Boolean).join(" ");
  return [when, event.location ? `${placeLabel}${event.location}` : ""].filter(Boolean).join("\n") + "\n\n";
}
