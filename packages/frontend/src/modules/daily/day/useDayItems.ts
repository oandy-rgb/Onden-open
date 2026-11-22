// One day for the 日子 page: what the modules know from the local copy (tasks,
// captures, the wrap-up — works offline) plus what the server adds for that date
// (edit runs, notes created, the agent's work; useDayLens). Both are DayItems;
// this hook only joins them.

import { useMemo } from "react";
import { isDayItemPast, sortDayItems, type DayItem } from "@onden/markdown";
import { useTagRows, useTaskRows, useAllNodes } from "../../../lib/appStore";
import { useModuleFilter, useTasksEnabled } from "../../../hooks/useModuleFilter";
import { focusDayItems } from "../../../lib/focus";
import { useFocusOfDay } from "./useFocusOfDay";
import { useNowMs } from "../../../hooks/useNowMs";
import { collectDayItems } from "../../index";
import { useDayLens, type DayLens } from "./useDayLens";

/** The server's items minus the ones a module already handed over for the same note. */
export function joinDayItems(local: readonly DayItem[], remote: readonly DayItem[], nowMs: number): DayItem[] {
  const captured = new Set(local.filter((i) => i.kind === "capture" && i.ref).map((i) => i.ref!.id));
  const extra = remote.filter((i) => !(i.kind === "created" && i.ref && captured.has(i.ref.id)));
  return sortDayItems([...local, ...extra]).map((item) => ({ ...item, past: isDayItemPast(item, nowMs) }));
}

export function useDayItems(date: string, today: string): { items: DayItem[]; nowMs: number; serverMissing: boolean; lens: DayLens | null } {
  const nodes = useAllNodes();
  const tasks = useTaskRows();
  const tags = useTagRows();
  const isImported = useModuleFilter();
  const nowMs = useNowMs();
  const { lens, failed } = useDayLens(date);
  const tasksOn = useTasksEnabled();
  // The person's focus records are not in the day lens; a failure to read them only leaves them out.
  const focus = useFocusOfDay(date, tasksOn);

  // Minute precision is enough for what modules compute from the clock.
  const minute = Math.floor(nowMs / 60_000) * 60_000;
  const local = useMemo(
    () => collectDayItems({ date, today, nowMs: minute, nodes, tasks, tags: tags ?? [] }, isImported),
    [date, today, minute, nodes, tasks, tags, isImported],
  );
  const focusItems = useMemo(() => {
    if (!tasksOn || !focus) return [];
    const titleOf = (id: string) => tasks.find((task) => task.id === id)?.title ?? nodes.find((node) => node.id === id)?.title;
    return focusDayItems(date, focus.sessions, focus.running, titleOf, nowMs);
  }, [tasksOn, focus, date, tasks, nodes, nowMs]);
  const items = useMemo(() => joinDayItems(local, [...(lens?.items ?? []), ...focusItems], nowMs), [local, lens, focusItems, nowMs]);
  return { items, nowMs, serverMissing: failed, lens };
}
