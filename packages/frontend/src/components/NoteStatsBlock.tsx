import { useAppSelector } from "../lib/appStore";
import { getLocale, tn, useT } from "../lib/i18n";
import { noteMenuStats } from "../lib/noteMenuStats";
import { dateLabel } from "../lib/timeLabels";
import "./infoFunctions";

/** The top of the note's ⋯ menu: how long the note is, and under it its paragraphs, tasks and the day it
 *  was made. The text is counted once when the menu opens; the tasks are the ones in this note
 *  (NodeTask.node_id), as the 「功能」 tab's 任務 row counts them. */
export default function NoteStatsBlock({ nodeId, body, createdAt }: { nodeId: string; body: () => string; createdAt?: string | null }) {
  const t = useT();
  const stats = noteMenuStats(body());
  const tasks = useAppSelector((s) => s.data.tasks.filter((task) => task.node_id === nodeId).length);
  const words = stats.words.toLocaleString(getLocale());
  return (
    <div className="note-actions-stats" role="group" aria-label={t("About this note")}>
      <span className="note-actions-stats-main">
        {stats.words === 0 ? t("No text yet") : t(stats.words === 1 ? "{words} word · {minutes} min read" : "{words} words · {minutes} min read", { words, minutes: stats.minutes })}
      </span>
      <span className="note-actions-stats-sub">
        {[
          tn("1 paragraph", "{n} paragraphs", stats.paragraphs),
          tn("1 task", "{n} tasks", tasks),
          createdAt ? t("Created {date}", { date: dateLabel(createdAt, "short") }) : null,
        ].filter(Boolean).join(" · ")}
      </span>
    </div>
  );
}
