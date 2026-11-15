import { useMemo } from "react";
import { useTagRows, useTaskRows, useAllNodes } from "../lib/appStore";
import { nextUp, type NextUp } from "../lib/dayNextUp";
import { todayId } from "../lib/localDate";
import { collectDayItems } from "../modules";
import { useModuleFilter } from "./useModuleFilter";
import { useNowMs } from "./useNowMs";

/** The next timed thing today (see lib/dayNextUp), or null. Reads what the modules
 *  put on today's day, so it follows whatever they know about the day. */
export function useNextUp(): NextUp | null {
  const nodes = useAllNodes();
  const tasks = useTaskRows();
  const tags = useTagRows();
  const isImported = useModuleFilter();
  const nowMs = useNowMs();
  const minute = Math.floor(nowMs / 60_000) * 60_000;
  const items = useMemo(() => {
    const today = todayId(new Date(minute));
    return collectDayItems({ date: today, today, nowMs: minute, nodes, tasks, tags: tags ?? [] }, isImported);
  }, [minute, nodes, tasks, tags, isImported]);
  return useMemo(() => nextUp(items, nowMs), [items, nowMs]);
}
