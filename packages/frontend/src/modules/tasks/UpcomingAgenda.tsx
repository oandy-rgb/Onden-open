// 接下來 as an agenda, for a phone and a computer alike (the 3 天／週 timeline is the 今天 tab's):
// a week row on top (the next seven days, a dot under the days that have something; a tap
// scrolls to that day), then one section per day with tasks — 「今天 11/9 週一」, 「明天 11/10 週二」,
// then 「週三 11/11」 — the days with nothing folded into one grey line, and what is further
// than two weeks off under 「之後」 with its date on the left. The rows are the Tasks page's
// TaskRow (handed in), the sorting is lib/tasks/upcomingAgenda.

import { useRef, type ReactNode } from "react";
import { weekdayOf } from "@onden/markdown";
import { MONDAY_FIRST_WEEKDAYS, MonthDayCell } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { addDays } from "../../lib/localDate";
import { nearDayLabel } from "../../lib/timeLabels";
import { agendaWeek, upcomingAgenda, type TaskItem } from "../../lib/tasks";
import { agendaDayTitle, plainDayLabel } from "./taskLabels";

type Props = {
  /** Open tasks with a day (today or later); others are ignored. */
  tasks: readonly TaskItem[];
  today: string;
  renderRow: (task: TaskItem) => ReactNode;
};

export default function UpcomingAgenda({ tasks, today, renderRow }: Props) {
  const t = useT();
  const segments = upcomingAgenda(tasks, today);
  const anchors = useRef(new Map<string, HTMLElement>());
  if (segments.length === 0) return null;
  const withTasks = new Set(segments.flatMap((s) => (s.kind === "day" ? [s.date] : [])));
  const anchor = (dates: string[]) => (el: HTMLElement | null) => { for (const d of dates) { if (el) anchors.current.set(d, el); else anchors.current.delete(d); } };
  const scrollTo = (date: string) => anchors.current.get(date)?.scrollIntoView({ block: "start", behavior: "smooth" });
  const spanOf = (from: string, to: string) => {
    const dates: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
    return dates;
  };

  return (
    <div className="tk-agenda">
      <div className="ui-month tk-agenda-week" role="grid" aria-label={t("Next seven days")}>
        <div role="row" className="ui-month-row">
          {agendaWeek(today).map((d) => <span key={d} role="columnheader" className="ui-month-weekday">{t(MONDAY_FIRST_WEEKDAYS[(weekdayOf(d) + 6) % 7]!)}</span>)}
        </div>
        <div role="row" className="ui-month-row">
          {agendaWeek(today).map((d) => (
            <MonthDayCell key={d} date={d} day={Number(d.slice(8))} picked={false} today={d === today} planned={withTasks.has(d)} onPick={scrollTo} />
          ))}
        </div>
      </div>
      {segments.map((segment) => {
        if (segment.kind === "day") {
          return (
            <section key={segment.date} ref={anchor([segment.date])} className="tk-agenda-day">
              <h3 className="tasks-section-title tk-agenda-title">{agendaDayTitle(segment.date, today, t)}</h3>
              <ul className="tasks-list">{segment.items.map(renderRow)}</ul>
            </section>
          );
        }
        if (segment.kind === "quiet") {
          const from = plainDayLabel(segment.from, t);
          return (
            <p key={segment.from} ref={anchor(spanOf(segment.from, segment.to))} className="tk-agenda-quiet">
              {segment.from === segment.to ? t("{day} Nothing planned", { day: from }) : t("{from} – {to} Nothing planned", { from, to: plainDayLabel(segment.to, t) })}
            </p>
          );
        }
        const dates = [...new Set(segment.items.map((task) => task.whenDate!))];
        return (
          <section key="later" className="tk-agenda-day">
            <h3 className="tasks-section-title tk-agenda-title">{t("After that")}</h3>
            {dates.map((date) => (
              <div key={date} className="tk-agenda-later">
                <span className="tk-agenda-date">{nearDayLabel(date, today)}</span>
                <ul className="tasks-list">{segment.items.filter((task) => task.whenDate === date).map(renderRow)}</ul>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
