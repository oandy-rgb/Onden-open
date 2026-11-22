// What the Tasks page's tabs and sections are made of, the tab names, the empty
// sentences, what the agenda lists, and a titled section.

import type { ReactNode } from "react";
import { classNames } from "../../lib/utils";
import type { TaskBuckets, TaskItem, TaskTab } from "../../lib/tasks";

export const TAB_LABEL: Record<TaskTab, string> = { today: "Today", upcoming: "Coming up", anytime: "Anytime", someday: "Someday" };
export const TAB_EMPTY: Record<TaskTab, string> = {
  today: "Nothing for today.",
  upcoming: "Nothing planned for later.",
  anytime: "Nothing waiting.",
  someday: "Nothing parked here.",
};

/** The agenda (接下來) starts on today, so today's own tasks are in it too, then every later day's. */
export function agendaTasksOf(buckets: TaskBuckets, today: string): TaskItem[] {
  return [...[...buckets.today.today, ...buckets.today.evening].filter((task) => task.whenDate === today), ...buckets.upcoming.flatMap((group) => group.items)];
}

type SectionProps = { title: string; tone?: "soon"; count?: number; note?: string; action?: ReactNode; className?: string; children: ReactNode };

/** A titled group of task rows: the title with its count, an optional note and a button at the right end. */
export function TaskSection({ title, tone, count, note, action, className, children }: SectionProps) {
  return (
    <section className={classNames("tasks-section", className)} aria-label={title}>
      <header className="tasks-section-head">
        <h3 className={classNames("tasks-section-title", tone === "soon" && "tasks-section-title--soon")}>
          {title}{count !== undefined && <span className="tasks-mode-count">{count}</span>}
        </h3>
        {note && <span className="tasks-section-note">{note}</span>}
        {action}
      </header>
      {children}
    </section>
  );
}
