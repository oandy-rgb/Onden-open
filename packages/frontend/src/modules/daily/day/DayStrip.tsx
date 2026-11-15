// The journal's one way to pick a day, under the date (DayPage): a row of ‹ range ›
// over the week (Monday first, 一 二 三…). The date button above opens the month,
// which REPLACES the week row; the same ‹ › then step months and the range reads
// 「2026年11月」, so only one pair of arrows and one set of days is ever drawn.
// The selected day is the same filled circle in both (ui/MonthDayCell). Dots: solid =
// a journal entry that day, hollow = tasks scheduled; the month adds a legend.
// What is shown (a week or month) follows the chosen day, but ‹ › page through
// without choosing. 「回到今天」 lives next to the date (DayPage).

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addMonths, weekdayOf } from "@onden/markdown";
import { Button, MONDAY_FIRST_WEEKDAYS, MonthDayCell, MonthGrid } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { addDays } from "../../../lib/localDate";
import { dayIdLabel, monthLabel } from "../../../lib/timeLabels";

type Props = {
  date: string;
  today: string;
  /** Days with a journal entry (solid dot). */
  written: ReadonlySet<string>;
  /** Days with tasks scheduled (hollow dot). */
  planned: ReadonlySet<string>;
  onPick: (date: string) => void;
  /** The month is open in place of the week row; the page's date opens and closes it. */
  monthOpen: boolean;
  onMonthOpenChange: (open: boolean) => void;
};

/** The Monday of the week `date` is in. */
export function weekStart(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

export const weekDays = (date: string, count = 7): string[] => Array.from({ length: count }, (_, i) => addDays(weekStart(date), i));

const dateParts = (date: string) => date.split("-").map(Number) as [number, number, number];
export const dayNumber = (date: string) => dateParts(date)[2];
export const weekdayText = (date: string) => dayIdLabel(date, "weekdayShort");

/** "11月9日 – 15日", or "10月26日 – 11月1日" across a month. */
export function weekRangeLabel(date: string): string {
  const days = weekDays(date);
  const first = days[0]!;
  const last = days[6]!;
  const sameMonth = dateParts(first)[1] === dateParts(last)[1];
  return `${dayIdLabel(first, "short")} – ${dayIdLabel(last, sameMonth ? "dayOnly" : "short")}`;
}

export default function DayStrip({ date, today, written, planned, onPick, monthOpen, onMonthOpenChange }: Props) {
  const t = useT();
  // The day the week or month on show belongs to: the chosen day until ‹ › page away from it.
  const [anchor, setAnchor] = useState(date);
  const [chosen, setChosen] = useState(date);
  if (chosen !== date) { setChosen(date); setAnchor(date); }
  const pick = (next: string) => { onPick(next); onMonthOpenChange(false); };
  const step = (direction: -1 | 1) => setAnchor(monthOpen ? addMonths(anchor, direction) : addDays(anchor, 7 * direction));
  const [year, month] = dateParts(anchor);

  return (
    <div className="day-strip">
      <div className="day-strip-nav">
        <Button variant="icon" size="sm" onClick={() => step(-1)} aria-label={monthOpen ? t("Previous month") : t("Previous week")}><ChevronLeft size={16} aria-hidden="true" /></Button>
        <span className="day-strip-range" aria-live="polite">{monthOpen ? monthLabel(year, month - 1) : weekRangeLabel(anchor)}</span>
        <Button variant="icon" size="sm" onClick={() => step(1)} aria-label={monthOpen ? t("Next month") : t("Next week")}><ChevronRight size={16} aria-hidden="true" /></Button>
      </div>
      {monthOpen ? (
        <>
          <MonthGrid className="day-strip-month" value={date} today={today} show={anchor} onPick={pick}
            marked={written} planned={planned} hideNav onMonthChange={setAnchor} />
          <p className="day-strip-legend">
            <span><span className="ui-month-dot is-written" aria-hidden="true" /> {t("Has a journal entry")}</span>
            <span><span className="ui-month-dot is-planned" aria-hidden="true" /> {t("Has tasks scheduled")}</span>
          </p>
        </>
      ) : (
        <div className="ui-month day-strip-week" role="grid" aria-label={t("This week")}>
          <div role="row" className="ui-month-row">
            {MONDAY_FIRST_WEEKDAYS.map((w) => <span key={w} role="columnheader" className="ui-month-weekday">{t(w)}</span>)}
          </div>
          <div role="row" className="ui-month-row">
            {weekDays(anchor).map((d) => (
              <MonthDayCell key={d} date={d} day={dayNumber(d)} picked={d === date} today={d === today}
                written={written.has(d)} planned={planned.has(d)} onPick={pick} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
