// The pieces of the timeline and the week board that show subscribed-calendar events.
// All read-only: no drag, no resize, no checkbox. They look different from tasks on
// purpose (a dashed outline in the calendar's colour), so nobody tries to move one.

import { useMemo, type CSSProperties } from "react";
import { layoutDayItems, type DayItem, type DayWindow } from "@onden/markdown";
import { Pressable } from "../../../../components/ui";
import type { ExternalEvent } from "../../../../lib/externalCalendars";
import { displayTitle } from "../../../../lib/noteLabel";
import { useT } from "../../../../lib/i18n";
import { classNames } from "../../../../lib/utils";
import { eventClock } from "./eventText";
import "../strings";
import "./external.css";

/** Events that run through the whole day, above the hours. */
export function AllDayStrip({ events, onOpen }: { events: readonly ExternalEvent[]; onOpen: (event: ExternalEvent) => void }) {
  const t = useT();
  if (events.length === 0) return null;
  return (
    <ul className="ext-allday" aria-label={t("All-day events")}>
      {events.map((event) => (
        <li key={event.id}>
          <Pressable type="button" className="ext-allday-item" style={{ "--ext-color": event.color } as CSSProperties} onClick={() => onOpen(event)}>
            <span className="ext-allday-title">{displayTitle(event.title)}</span>
          </Pressable>
        </li>
      ))}
    </ul>
  );
}

const MIN_BLOCK_MINUTES = 24;

/** The day's timed events placed on the hours, in lanes of their own on the right of the tasks. */
export function ExternalBlocks({ events, window, hourPx, yOf, onOpen }: {
  events: readonly ExternalEvent[]; window: DayWindow; hourPx: number;
  /** Where a minute is when the day is not drawn at one scale (the timeline's folded stretches); absent: evenly. */
  yOf?: (minutes: number) => number; onOpen: (event: ExternalEvent) => void;
}) {
  const placed = useMemo(() => {
    const byId = new Map(events.map((e) => [e.id, e]));
    const items: DayItem[] = events.map((e) => ({ kind: "task", title: e.id, at: e.starts_at, until: e.ends_at > e.starts_at ? e.ends_at : undefined, ref: null, past: false }));
    return layoutDayItems(items, window, undefined, (MIN_BLOCK_MINUTES * 60) / hourPx).placed
      .map((p) => ({ ...p, event: byId.get(p.item.title)! }));
  }, [events, window, hourPx]);
  const px = (minutes: number) => (minutes * hourPx) / 60;
  return (
    <div className="ext-lanes">
      {placed.map(({ event, topMinutes, heightMinutes, lane, lanes }) => (
        <Pressable key={event.id} type="button" className="ext-block"
          style={{ "--top": `${yOf ? yOf(topMinutes) : px(topMinutes)}px`, "--h": `${Math.max(px(heightMinutes) - 2, MIN_BLOCK_MINUTES)}px`, "--lane": lane, "--lanes": lanes, "--ext-color": event.color } as CSSProperties}
          onClick={() => onOpen(event)}>
          <span className="ext-block-time">{eventClock(event)}</span>
          <span className="ext-block-title">{displayTitle(event.title)}</span>
        </Pressable>
      ))}
    </div>
  );
}

/** One event as a card in a week-board column. */
export function ExternalCard({ event, onOpen }: { event: ExternalEvent; onOpen: (event: ExternalEvent) => void }) {
  return (
    <li className={classNames("week-card", "ext-card")} style={{ "--ext-color": event.color } as CSSProperties}>
      <Pressable type="button" className="week-card-open" onClick={() => onOpen(event)}>
        {!event.all_day && <span className="week-card-time">{eventClock(event)}</span>}
        <span className="week-card-title">{displayTitle(event.title)}</span>
      </Pressable>
    </li>
  );
}
