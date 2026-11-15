// The sections under a day's words (DayPage). The journal looks back (write and
// remember), so it lists no to-dos: what is still to be done is one line to the Tasks
// page (one whole pressable row: 今天 「還有 N 件要做」, a later day 「排了 N 件」, a past day nothing). Each section
// is only drawn when it has something; when none has, one line says so.
//   這天發生的   the day note's quick captures, the tasks finished that day
//               (「完成了 …」, by finish time), and the notes made or saved that day
//               (the server's day lens, the first few, the rest on request).
//   提到這天的   notes that link to the day note, with the sentence around the link.

import { useMemo, useState } from "react";
import { BacklinkSnippetView } from "../../../components/BacklinkSnippetView";
import EmptyState from "../../../components/EmptyState";
import { Button } from "../../../components/ui";
import type { ContentNode } from "../../../lib/api";
import { useAppSelector, useTaskRows } from "../../../lib/appStore";
import { findBacklinkSnippet } from "../../../lib/backlinks";
import { setPendingCursor } from "../../../lib/cursorHandoff";
import { tn, useT } from "../../../lib/i18n";
import { noteLinks, noteNeighborhood } from "../../../lib/noteNeighborhood";
import { displayTitle } from "../../../lib/noteLabel";
import type { DayItem } from "@onden/markdown";
import { itemTimeText } from "./dayItemText";
import { dayItemNoteId, useDayItemActions } from "./dayTaskWrites";
import { finishedTaskItems } from "./finishedTasks";
import { useDayItems } from "./useDayItems";
import type { LensNote } from "./useDayLens";

/** Notes listed before 「還有 N 篇」. */
export const HAPPENED_SHOWN = 5;

type Props = {
  date: string;
  today: string;
  day: ContentNode | undefined;
  captures: readonly ContentNode[];
  nodes: readonly ContentNode[];
  tasksOn: boolean;
  onOpenNode: (id: string) => void;
  onOpenView?: (id: string) => void;
};

export default function DayBelow({ date, today, day, captures, nodes, tasksOn, onOpenNode, onOpenView }: Props) {
  const t = useT();
  const edges = useAppSelector((s) => s.data.edges);
  const { items, lens } = useDayItems(date, today);

  const taskRows = useTaskRows();
  const tasks = useMemo(() => (tasksOn ? items.filter((i) => i.kind === "task") : []), [items, tasksOn]);
  // Today: what is not done yet. A later day: everything scheduled on it. A past day: no line.
  const todoCount = date === today ? tasks.filter((i) => !i.done).length : date > today ? tasks.length : 0;
  // The ones in the day note's own words are ticked in that text; listing them again was the repeat.
  const finished = useMemo(
    () => (tasksOn ? finishedTaskItems(taskRows, date).filter((i) => !day || dayItemNoteId(taskRows, i) !== day.id) : []),
    [tasksOn, taskRows, date, day],
  );

  const captureIds = useMemo(() => new Set(captures.map((c) => c.id)), [captures]);
  const made = useMemo<MadeNote[]>(() => {
    const seen = new Set<string>();
    const tagged = [
      ...(lens?.buckets.created.items ?? []).map((n): MadeNote => ({ ...n, how: "created" })),
      ...(lens?.buckets.edited.items ?? []).map((n): MadeNote => ({ ...n, how: "edited" })),
    ];
    return tagged.filter((n) => n.id !== day?.id && !captureIds.has(n.id) && !seen.has(n.id) && !!seen.add(n.id));
  }, [lens, day, captureIds]);

  const mentions = useMemo(
    () => day ? noteLinks(noteNeighborhood(day, [...nodes], edges).relations).backlinks.filter((n) => n.id !== day.id) : [],
    [day, nodes, edges],
  );

  if (todoCount === 0 && finished.length === 0 && captures.length === 0 && made.length === 0 && mentions.length === 0) {
    return <EmptyState size="inline" title={t("No tasks or records on this day, and no note mentions it yet.")} />;
  }
  return (
    <>
      {todoCount > 0 && (
        // One whole row you can press (not a small text link): what is left, and the way to the Tasks page.
        <Button variant="secondary" className="day-todo-row" disabled={!onOpenView} onClick={() => onOpenView?.("tasks")}>
          <span className="day-todo-text">
            {date === today
              ? tn("{n} thing left to do", "{n} things left to do", todoCount)
              : tn("{n} thing scheduled", "{n} things scheduled", todoCount)}
          </span>
          <span className="day-todo-go">{t("Go to Tasks ›")}</span>
        </Button>
      )}
      {(captures.length > 0 || finished.length > 0 || made.length > 0) && (
        <HappenedSection captures={captures} finished={finished} made={made} onOpenNode={onOpenNode} />
      )}
      {mentions.length > 0 && (
        <section className="day-section" aria-label={t("Mentions this day")}>
          <h3 className="day-section-title">{t("Mentions this day")}</h3>
          <div className="day-mentions">
            {mentions.map((src) => {
              const snippet = day ? findBacklinkSnippet(src, day) : null;
              return (
                <Button key={src.id} variant="ghost" className="backlink-card" title={t("Open {title}", { title: src.title })}
                  onClick={() => {
                    if (snippet) setPendingCursor(src.id, snippet.linkAbsStart, snippet.linkAbsStart + (snippet.linkEnd - snippet.linkStart));
                    onOpenNode(src.id);
                  }}>
                  <span className="backlink-card-title">{displayTitle(src.title)}</span>
                  {snippet && <BacklinkSnippetView snippet={snippet} />}
                </Button>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

type MadeNote = LensNote & { how: "created" | "edited" };

function HappenedSection({ captures, finished, made, onOpenNode }: { captures: readonly ContentNode[]; finished: readonly DayItem[]; made: readonly MadeNote[]; onOpenNode: (id: string) => void }) {
  const t = useT();
  const { open } = useDayItemActions(onOpenNode);
  const [all, setAll] = useState(false);
  const shown = all ? made : made.slice(0, HAPPENED_SHOWN);
  const row = (key: string, title: string, label: string, onClick: () => void) => (
    <li key={key}>
      <Button variant="ghost" className="day-happened-row" onClick={onClick}>
        <span className="day-happened-title">{title}</span>
        <span className="day-happened-kind">{label}</span>
      </Button>
    </li>
  );
  return (
    <section className="day-section" aria-label={t("Happened this day")}>
      <h3 className="day-section-title">{t("Happened this day")}</h3>
      <ul className="day-happened">
        {captures.map((c) => row(c.id, displayTitle(c.title), t("Quick note"), () => onOpenNode(c.id)))}
        {finished.map((item) => row(`task-${item.ref!.id}`, t("Finished {title}", { title: displayTitle(item.title) }), itemTimeText(item), () => open(item)))}
        {shown.map((n) => row(n.id, displayTitle(n.title), t(n.how === "created" ? "Created" : "Edited"), () => onOpenNode(n.id)))}
      </ul>
      {made.length > HAPPENED_SHOWN && (
        <Button variant="ghost" size="sm" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? t("Show less") : t("{n} more notes", { n: made.length - HAPPENED_SHOWN })}
        </Button>
      )}
    </section>
  );
}
