// 「那天的時間花在哪」: under a past day's timeline, one small table — per thing, the time it was planned for
// (only with a start and an end), the time really spent in focus, and the day's total. Spent past what was
// planned is marked. Shown only for a past day that has focus records.

import { useMemo } from "react";
import { useT } from "../../../lib/i18n";
import { displayTitle } from "../../../lib/noteLabel";
import type { TaskItem } from "../../../lib/tasks";
import type { FocusTotals } from "./focusTotals";
import { plannedMinutes } from "./todayLists";

type Props = {
  /** The day's tasks and any other thing focus was spent on (title by id). */
  tasks: readonly TaskItem[];
  titleOf: (taskId: string) => string | undefined;
  totals: FocusTotals;
};

type Line = { id: string; title: string; planned: number | null; focused: number };

export function timeSpentLines(tasks: readonly TaskItem[], titleOf: (id: string) => string | undefined, totals: FocusTotals): Line[] {
  const lines = new Map<string, Line>();
  for (const task of tasks) {
    const planned = plannedMinutes(task);
    const focused = totals.byTask.get(task.id) ?? 0;
    if (planned !== null || focused > 0) lines.set(task.id, { id: task.id, title: task.title, planned, focused });
  }
  for (const [id, focused] of totals.byTask) if (!lines.has(id)) lines.set(id, { id, title: titleOf(id) ?? "", planned: null, focused });
  return [...lines.values()].sort((a, b) => b.focused - a.focused || a.title.localeCompare(b.title));
}

export default function TimeSpent({ tasks, titleOf, totals }: Props) {
  const t = useT();
  const lines = useMemo(() => timeSpentLines(tasks, titleOf, totals), [tasks, titleOf, totals]);
  if (totals.total <= 0 && lines.every((line) => line.focused === 0)) return null;
  const plannedTotal = lines.reduce((sum, line) => sum + (line.planned ?? 0), 0);
  const min = (n: number) => t("{n} min", { n });
  return (
    <section className="today-spent" aria-label={t("Where the time went")}>
      <h3 className="today-section-title">{t("Where the time went")}</h3>
      <table className="today-spent-table">
        <thead><tr><th scope="col" /><th scope="col">{t("Planned time")}</th><th scope="col">{t("Focus time")}</th></tr></thead>
        <tbody>
          {lines.map((line) => {
            const over = line.planned !== null && line.focused > line.planned ? line.focused - line.planned : 0;
            return (
              <tr key={line.id}>
                <th scope="row">{displayTitle(line.title)}</th>
                <td>{line.planned === null ? "–" : min(line.planned)}</td>
                <td>{min(line.focused)}{over > 0 && <span className="today-spent-over"> · {t("{n} min over", { n: over })}</span>}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot><tr><th scope="row">{t("Total")}</th><td>{plannedTotal > 0 ? min(plannedTotal) : "–"}</td><td>{min(totals.total)}</td></tr></tfoot>
      </table>
    </section>
  );
}
