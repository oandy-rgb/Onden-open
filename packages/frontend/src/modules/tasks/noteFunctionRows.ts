import { ListChecks } from "lucide-react";
import { t, tn } from "../../lib/i18n";
import { calendarDayOf } from "@onden/markdown";
import { todayId, workspaceTimeZone } from "../../lib/localDate";
import { displayTitle } from "../../lib/noteLabel";
import { isOpen } from "../../lib/tasks";
import type { NoteFunctionEnv, NoteFunctionRow } from "../types";
import { deadlineLabel } from "./taskLabels";
import { openQuickAddTask } from "./openQuickAddTask";

/** The 「任務」 row of the 「功能」 tab: the open tasks written in this note or added under it (NodeTask.node_id).
 *  Without any it is still offered, as 「＋ 任務」 for this note. */
export default function taskNoteFunctionRows({ node, tasks, canEdit, nav }: NoteFunctionEnv): NoteFunctionRow[] {
  const today = todayId();
  const target = { id: node.id, title: displayTitle(node.title), spaceId: node.space_id };
  const mine = tasks.filter((task) => task.node_id === node.id && isOpen(task.status));
  const add = canEdit ? { label: t("＋ Task"), run: () => openQuickAddTask(target) } : undefined;
  if (mine.length === 0) {
    return canEdit ? [{ id: "tasks", Icon: ListChecks, name: t("Tasks"), related: false, status: t("Add a task to this note"), action: add }] : [];
  }
  // The nearest day it is due: the deadline, else the day to do it.
  const dated = mine.flatMap((task) => { const day = calendarDayOf(task.deadline ?? task.when_date ?? task.due_date ?? null, workspaceTimeZone()); return day ? [{ task, day }] : []; })
    .sort((a, b) => a.day.localeCompare(b.day));
  const count = tn("1 task", "{n} tasks", mine.length);
  return [{
    id: "tasks",
    Icon: ListChecks,
    name: t("Tasks"),
    related: true,
    status: dated[0] ? t("{count}, nearest {due}", { count, due: deadlineLabel(dated[0].day, today, t) }) : count,
    badge: { n: mine.length },
    details: mine.map((task) => task.title),
    action: add,
    // The Tasks page has no filter for one note yet: it opens the page.
    jump: { label: t("Open the Tasks page"), run: () => nav.setMode("tasks") },
  }];
}
