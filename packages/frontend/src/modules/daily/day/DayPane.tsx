// 時間軸只放任務與專注（onTimeline，業主 2026-10-31）；修改、建立、快速記錄、AI 執行
// 在「歷史」看。useDayItems 仍交出全部來源，日記頁「這天發生的」（DaySections）照舊用。
// 時間軸只在任務頁（業主 2026-11-09）：日記往回看，不放時間軸。
// 時間軸: one day as a timeline, or — in 3 天 / 週 — the days side by side.
// (收工 and 規劃今天 are gone, 業主 2026-11-06: what was not done stays on the
// Tasks page's 今天, and 「這天發生的」 lists the day.) What has no slot yet is not listed here: the Tasks page hands
// in `unscheduled` (「可以排進今天的」 and 「還沒排時間」), shown above the timeline. It reads one list of DayItems
// (useDayItems) and shows it; each module decides what it puts there. It is the
// Tasks page's planning part, starting on today with the 1 天 / 3 天 / 週 switch.
// The switch is for a wide screen only (業主 2026-11-09: 3 天／週 is too cramped on a phone): a
// phone has the one day, and a range picked on a wide screen reads as 1 天 there. The one-day
// timeline folds its empty stretches (DayTimeline `foldEmpty`); 3 天／週 does not.

import { useState, type ReactNode } from "react";
import { Button, Segmented } from "../../../components/ui";
import { MOBILE_QUERY, useMediaQuery } from "../../../hooks/useIsMobile";
import { useTasksEnabled } from "../../../hooks/useShellFeature";
import { useToday } from "../../../hooks/useToday";
import { onTimeline } from "@onden/markdown";
import { useT } from "../../../lib/i18n";
import { addDays } from "../../../lib/localDate";
import { dayIdLabel } from "../../../lib/timeLabels";
import { classNames } from "../../../lib/utils";
import { weekDays } from "./DayStrip";
import TimelinePlanner from "./TimelinePlanner";
import WeekBoard from "./WeekBoard";
import { useDayItemActions } from "./dayTaskWrites";
import { useDayItems } from "./useDayItems";
import { eventsOnDay, type ExternalEvent } from "../../../lib/externalCalendars";
import { useExternalEvents } from "../../../hooks/useExternalEvents";
import ExternalEventSheet from "./external/ExternalEventSheet";
import "./day.css";

export type DayRange = "day" | "3days" | "week";
const RANGES: readonly (readonly [DayRange, string])[] = [["day", "1 day"], ["3days", "3 days"], ["week", "Week"]];

type Props = {
  onOpenNode: (id: string) => void;
  /** Under the header, above the timeline: the Tasks page's 「可以排進今天的」 and 「還沒排時間」. */
  unscheduled?: ReactNode;
};

export default function DayPane({ onOpenNode, unscheduled }: Props) {
  const t = useT();
  const phone = useMediaQuery(MOBILE_QUERY);
  const today = useToday();
  const tasksOn = useTasksEnabled();
  const [picked, setRange] = useState<DayRange>("day");
  const range: DayRange = phone ? "day" : picked;
  const [own, setOwn] = useState<string | null>(null);
  const date = own ?? today;
  const { items, nowMs } = useDayItems(date, today);
  const { open } = useDayItemActions(onOpenNode);
  const timeline = items.filter(onTimeline);
  const board = range !== "day";
  // Events from subscribed calendars: read-only, so they are not part of `items`; opened for a look.
  const shownDays = board ? (range === "week" ? weekDays(date) : [date, addDays(date, 1), addDays(date, 2)]) : [date];
  const external = useExternalEvents(shownDays[0]!, shownDays[shownDays.length - 1]!);
  const [openEvent, setOpenEvent] = useState<ExternalEvent | null>(null);

  return (
    <section className={classNames("day-pane", phone && "is-phone", board && "is-board")} aria-label={t("Day timeline")}>
      <header className="day-pane-head">
        <h2 className="day-pane-title">{t("Day timeline")}</h2>
        {/* Only a span of days needs its start date. */}
        {board && <span className="day-pane-date">{dayIdLabel(date, "long")}</span>}
        {!phone && (
          <Segmented className="day-pane-ranges" label={t("How many days")} value={range}
            options={RANGES.map(([id, label]) => ({ value: id, label: t(label) }))} onChange={setRange} />
        )}
        {date !== today && <Button size="sm" variant="ghost" onClick={() => setOwn(null)}>{t("Back to today")}</Button>}
      </header>

      {unscheduled && <div className="day-pane-list">{unscheduled}</div>}

      <div className="day-pane-main">
      {board ? (
        <WeekBoard days={range === "week" ? weekDays(date) : [date, addDays(date, 1), addDays(date, 2)]}
          today={today} selected={date} nowMs={nowMs} onPick={(d) => { setOwn(d); setRange("day"); }} onOpen={open}
          external={external} onOpenExternal={setOpenEvent} />
      ) : (
        <>
          <TimelinePlanner key={date} enabled={tasksOn} foldEmpty date={date} items={timeline} nowMs={nowMs} onOpen={open}
            external={eventsOnDay(external, date)} onOpenExternal={setOpenEvent} />
        </>
      )}
      </div>
      {openEvent && <ExternalEventSheet event={openEvent} onClose={() => setOpenEvent(null)} onOpenNode={onOpenNode} />}
    </section>
  );
}
