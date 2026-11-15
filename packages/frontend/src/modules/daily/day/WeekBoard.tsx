// 3 天 / 週: the days side by side, each column with its untimed things on top and
// its timed things in order. On the left, 「還沒排的事」 — open tasks with no day.
// Dragging a task onto a column plans it for that day (taskWriter); a task has no
// time of day to set yet, so a column is one drop target, not an hour grid.
// The same cards carry a 「排到今天」 button for keyboards and touch.

import { useMemo, useRef, useState, type CSSProperties } from "react";
import { isDayItemPast, onTimeline, type DayItem } from "@onden/markdown";
import { Button, Pressable } from "../../../components/ui";
import EmptyState from "../../../components/EmptyState";
import { useTagRows, useTaskRows, useAllNodes } from "../../../lib/appStore";
import { useT } from "../../../lib/i18n";
import { fromNodeTask } from "../../../lib/tasks";
import { classNames } from "../../../lib/utils";
import { useModuleFilter } from "../../../hooks/useModuleFilter";
import { collectDayItems } from "../../index";
import { planTaskOn } from "./dayTaskWrites";
import { moveTaskToDay } from "./moveTaskToDay";
import { itemTimeText, itemTitle } from "./dayItemText";
import { dayNumber, weekdayText } from "./DayStrip";
import { displayTitle } from "../../../lib/noteLabel";
import { droppedTaskId, taskDragSource } from "../../../lib/taskDrag";
import { closestAtPoint, trackPointerDrag } from "../../../lib/pointerDragSession";
import { holdSurface } from "../../../lib/touchHold";
import { taskRefById, useTaskRefs } from "../../../lib/taskRefs";
import { ExternalCard } from "./external/ExternalDayParts";
import { eventsOnDay, type ExternalEvent } from "../../../lib/externalCalendars";

type Props = {
  days: readonly string[];
  today: string;
  selected: string;
  nowMs: number;
  onPick: (date: string) => void;
  onOpen: (item: DayItem) => void;
  /** Events from subscribed calendars across the shown days: cards that cannot be dragged. */
  external?: readonly ExternalEvent[];
  onOpenExternal?: (event: ExternalEvent) => void;
};

export default function WeekBoard({ days, today, selected, nowMs, onPick, onOpen, external = [], onOpenExternal }: Props) {
  const t = useT();
  const nodes = useAllNodes();
  const tasks = useTaskRows();
  const tags = useTagRows();
  const isImported = useModuleFilter();
  const [over, setOver] = useState<string | null>(null);
  const refs = useTaskRefs();
  // A finger holds a card (then drags it to another day's column); native drag is for the mouse.
  const [lifted, setLifted] = useState<string | null>(null);
  const touching = useRef(false);

  const columns = useMemo(() => days.map((date) => ({
    date,
    items: collectDayItems({ date, today, nowMs, nodes, tasks, tags: tags ?? [] }, isImported)
      .filter(onTimeline)
      .map((item) => ({ ...item, past: isDayItemPast(item, nowMs) })),
  })), [days, today, nowMs, nodes, tasks, tags, isImported]);

  // Open tasks with no day at all (parked ones included): the shelf to plan from.
  const shelf = useMemo(() => tasks
    .map(fromNodeTask)
    .filter((task) => (task.status === "todo" || task.status === "doing") && !task.when_date), [tasks]);

  const drop = (date: string, event: React.DragEvent) => {
    event.preventDefault();
    setOver(null);
    const id = droppedTaskId(event);
    if (id) void put(id, date);
  };
  // A task that has a day moves there (time kept, with 復原); one from the shelf is planned for it.
  const put = (id: string, date: string) => (tasks.find((task) => task.id === id)?.when_date ? moveTaskToDay(id, date) : planTaskOn(id, date));
  const touchDrag = (id: string) => (event: React.PointerEvent) => {
    touching.current = event.pointerType !== "mouse";
    if (!touching.current) return;
    let target: string | null = null;
    trackPointerDrag(event, {
      hold: true,
      onLift: () => setLifted(id),
      onDrag: (x, y) => { target = closestAtPoint(x, y, "[data-date]")?.dataset.date ?? null; setOver(target); },
      onEnd: (_x, _y, dragged) => { setLifted(null); setOver(null); if (dragged && target) void put(id, target); },
      onCancel: () => { setLifted(null); setOver(null); },
    });
  };
  const cardDrag = (id: string) => ({
    ...taskDragSource(id),
    onPointerDown: touchDrag(id),
    onDragStart: (event: React.DragEvent) => { if (touching.current) { event.preventDefault(); return; } taskDragSource(id).onDragStart(event); },
  });

  return (
    <div className="week-board" ref={holdSurface}>
      <aside className="week-shelf" aria-label={t("Not planned yet")}>
        <h3 className="week-shelf-title">{t("Not planned yet")}</h3>
        {shelf.length === 0 ? <EmptyState size="inline" title={t("Everything has a day.")} /> : (
          <ul className="week-cards">
            {shelf.map((task) => (
              <li key={task.id} className="week-card" {...taskDragSource(task.id)}>
                <span className="week-card-title">{displayTitle(task.title)}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => void planTaskOn(task.id, today)}>{t("Plan for today")}</Button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <div className="week-columns" style={{ "--cols": days.length } as CSSProperties}>
        {columns.map(({ date, items }) => (
          <section key={date} data-date={date} aria-label={date}
            className={classNames("week-column", date === today && "is-today", date === selected && "is-selected", over === date && "is-over")}
            onDragOver={(event) => { event.preventDefault(); if (over !== date) setOver(date); }}
            onDragLeave={() => setOver((now) => (now === date ? null : now))}
            onDrop={(event) => drop(date, event)}>
            <Pressable type="button" className="week-column-head" onClick={() => onPick(date)}>
              <span className="week-column-weekday">{weekdayText(date)}</span>
              <span className="week-column-num">{dayNumber(date)}</span>
            </Pressable>
            <ul className="week-cards">
              {onOpenExternal && eventsOnDay(external, date).filter((e) => e.all_day).map((event) => <ExternalCard key={event.id} event={event} onOpen={onOpenExternal} />)}
              {[...items.filter((i) => !i.at), ...items.filter((i) => i.at)].map((item, index) => (
                <li key={`${item.ref?.id ?? index}`} className={classNames("week-card", item.past && "is-past", item.done && "is-done", item.ref && lifted === item.ref.id && "is-lifted")}
                  {...(item.kind === "task" && item.ref && !item.done && taskRefById(item.ref.id, refs)?.task.writable === true ? cardDrag(item.ref.id) : {})}>
                  <Pressable type="button" className="week-card-open" disabled={!item.ref} onClick={() => onOpen(item)}>
                    {item.at && <span className="week-card-time">{itemTimeText(item)}</span>}
                    <span className="week-card-title">{itemTitle(item, t)}</span>
                  </Pressable>
                </li>
              ))}
              {onOpenExternal && eventsOnDay(external, date).filter((e) => !e.all_day).map((event) => <ExternalCard key={event.id} event={event} onOpen={onOpenExternal} />)}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
