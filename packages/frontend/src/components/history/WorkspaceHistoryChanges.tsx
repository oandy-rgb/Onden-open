// 「變更」: the 14-day bar chart picks one day, and the list under it shows only that day: a heading,
// the AI runs and the edited notes. An older day loads the older pages first; the chart's arrows
// move the 14 days it draws.
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { addDays, dateIdAt, todayId } from "../../lib/localDate";
import { HISTORY_DAYS, fetchActivity, openNoteHistory } from "../../lib/history";
import WorkspaceHistoryChart, { monthDay } from "./WorkspaceHistoryChart";
import WorkspaceHistoryNoteRow from "./WorkspaceHistoryNoteRow";
import WorkspaceHistoryRunCard from "./WorkspaceHistoryRunCard";
import WorkspaceHistoryNotePane from "./WorkspaceHistoryNotePane";
import WorkspaceHistorySystemTidy from "./WorkspaceHistorySystemTidy";
import WorkspaceHistoryRewindCard from "./WorkspaceHistoryRewindCard";
import RewindPreview from "./RewindPreview";
import { cutBefore, cutForDayEnd, cutWhen, isAfterCut, type Cut } from "./rewindCut";
import { NARROW, type DetailSlot } from "./detailSlot";
import { useHistorySpace } from "./historySpace";
import { failed, useLoad } from "./useLoad";
import { useHistoryFeed } from "./useHistoryFeed";
import { LoadError, Pressable } from "../ui";
import type { ActivityDay, RewindResult } from "@onden/contract";

type Props = {
  online: boolean;
  onOpenNote: (noteId: string) => void;
  /** Open one note's own history on the given day (the end of that day). */
  onOpenNoteHistory?: (noteId: string, day: string) => void;
  onOpenInbox: () => void;
  onNotice: (message: string) => void;
  /** Two columns: a row shows its note's history on the right instead of in a dialog. */
  detail?: DetailSlot;
};

type Selection = { noteId: string; day: string };
const rowKey = (s: Selection) => `${s.noteId}|${s.day}`;

/** 14 empty days ending `until`, for an older backend or before the first answer. */
function emptyDays(until: string): ActivityDay[] {
  return Array.from({ length: HISTORY_DAYS }, (_, i) => ({ date: addDays(until, i - (HISTORY_DAYS - 1)), you: 0, agents: 0 }));
}

/** Where the cut line goes in a list newest first, or null for none: after the items newer than the cut,
 *  when the cut falls between two of them, or when it falls on this very day. */
function cutLineAt<T>(items: readonly T[], cut: Cut | null, isAfter: (item: T) => boolean, onCutDay: boolean): number | null {
  if (!cut) return null;
  const first = items.findIndex((item) => !isAfter(item));
  const at = first < 0 ? items.length : first;
  return (at > 0 && at < items.length) || onCutDay ? at : null;
}

function CutLine({ cut }: { cut: Cut }) {
  const t = useT();
  return <div className="wh-cut-line" role="separator" aria-label={t("Restoring to here")}><span>{t("Restoring to here")} · {cutWhen(cut)}</span></div>;
}


export default function WorkspaceHistoryChanges({ online, onOpenNote, onOpenNoteHistory, onOpenInbox, onNotice, detail = NARROW }: Props) {
  const t = useT();
  const today = todayId();
  const root = useRef<HTMLDivElement>(null);
  const { spaceId } = useHistorySpace();
  const feed = useHistoryFeed(today, spaceId);
  // The point being looked at (「那天的樣子」 or 「回到這之前」), if any: the preview shows it, the list marks what lies after it.
  const [cut, setCut] = useState<Cut | null>(null);
  const cutDay = cut ? dateIdAt(new Date(cut.at)) : null;

  const [chartUntil, setChartUntil] = useState(today);
  const [activity, reloadActivity] = useLoad(() => fetchActivity(HISTORY_DAYS, chartUntil === today ? undefined : chartUntil, spaceId), [chartUntil, spaceId]);
  const chartDays = activity.status === "ready" ? activity.value : emptyDays(chartUntil);

  // What the person pressed. A day outside the drawn 14 (after the arrows moved them) no longer counts:
  // the newest day with edits in the new window is selected, or its last day when it is all quiet.
  const [picked, setPicked] = useState<string | null>(null);
  const newest = feed.days[0]?.date ?? null;
  const inChart = (date: string) => chartDays.some((d) => d.date === date);
  const fallback = newest && inChart(newest)
    ? newest
    : [...chartDays].reverse().find((d) => d.you + d.agents > 0)?.date ?? chartDays[chartDays.length - 1]?.date ?? chartUntil;
  const selected = picked && inChart(picked) ? picked : fallback;
  const day = feed.days.find((d) => d.date === selected) ?? null;

  // An older day is not in the first page: read pages until it is covered.
  const { loadThrough } = feed;
  const covered = feed.covers(selected);
  useEffect(() => {
    if (feed.status === "ready" && activity.status !== "loading" && !covered) void loadThrough(selected);
  }, [feed.status, activity.status, covered, selected, loadThrough]);

  // 「顯示更多」: the day whose next page is being read, and the day whose last try failed.
  const [moreNotes, setMoreNotes] = useState<string | null>(null);
  const [moreNotesFailed, setMoreNotesFailed] = useState<string | null>(null);
  const showMoreNotes = async (date: string) => {
    setMoreNotes(date);
    setMoreNotesFailed(null);
    const ok = await feed.loadMoreNotes(date);
    setMoreNotes(null);
    if (!ok) setMoreNotesFailed(date);
  };

  // The rows of the selected day, top to bottom: what the arrow keys walk and the first is the default pick.
  const rows = useMemo<Selection[]>(() => (day?.notes ?? []).map((n) => ({ noteId: n.id, day: day!.date })), [day]);
  // Kept once chosen (the first row, until another is picked), so a reload that puts a new row on top
  // does not swap the history under a person who is in the middle of a restore. Another day starts
  // over at its own first row.
  const [chosen, setChosen] = useState<Selection | null>(null);
  // Another space: the open note may not be in it, so start over at the first row.
  useEffect(() => { setChosen(null); }, [spaceId]);
  const first = rows[0] ?? null;
  const keptChoice = chosen !== null && chosen.day === selected ? chosen : null;
  // An updater, not `first` itself: a row picked before this effect ran (the list is on screen a moment
  // earlier) is already queued and must win over this render's stale "nothing chosen yet".
  useEffect(() => {
    if (detail.wide && first && !keptChoice) setChosen((now) => (now !== null && now.day === first.day ? now : first));
  }, [detail.wide, first, keptChoice]);
  const current = detail.wide ? (keptChoice ?? first) : null;

  const openHistory = (noteId: string, day: string) => {
    if (detail.wide) { setChosen({ noteId, day }); return; }
    if (onOpenNoteHistory) return onOpenNoteHistory(noteId, day);
    openNoteHistory(noteId, undefined, day);
    onOpenNote(noteId);
  };

  const agentNames = useMemo(() => [...new Set(feed.days.flatMap((d) => d.agent_runs.map((r) => r.agent_name)))], [feed.days]);
  const agentLabel = agentNames.length === 1 ? agentNames[0]! : t("AI");

  const dayHeading = (date: string) => date === today ? `${t("Today")} ${monthDay(date)}` : date === addDays(today, -1) ? `${t("Yesterday")} ${monthDay(date)}` : monthDay(date);

  const loadFailed = failed(activity) || (feed.status === "error" && !feed.unavailable);
  const retryAll = () => { reloadActivity(); feed.reload(); };

  const rewound = (result: RewindResult | undefined) => {
    setCut(null);
    if (!result) { feed.reload(); reloadActivity(); return; }
    const n = result.restored.length + result.undeleted.length + result.deleted.length;
    const parts = [n > 0 ? t("Restored {n} notes", { n }) : t("Nothing needed to change")];
    if (result.unwritable.length > 0) parts.push(t("{n} notes you can't edit were left alone", { n: result.unwritable.length }));
    const other = result.stale.length + result.skipped.length;
    if (other > 0) parts.push(t("{n} notes were left as they are", { n: other }));
    onNotice(parts.join(" · "));
    feed.reload();
    reloadActivity();
  };

  // Up and down walk the rows (the pick follows); Enter opens the note itself.
  const onListKeyDown = (event: KeyboardEvent) => {
    if (!detail.wide) return;
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-row]");
    if (!el) return;
    const at = rows.findIndex((r) => rowKey(r) === el.dataset.row);
    if (at < 0) return;
    if (event.key === "Enter") { event.preventDefault(); onOpenNote(rows[at]!.noteId); return; }
    const next = event.key === "ArrowDown" ? rows[at + 1] : event.key === "ArrowUp" ? rows[at - 1] : undefined;
    if (!next) return;
    event.preventDefault();
    setChosen(next);
    root.current?.querySelector<HTMLElement>(`[data-row="${rowKey(next)}"]`)?.focus();
  };

  return (
    <div ref={root} className="wh-changes" onKeyDown={onListKeyDown}>
      {cut && !detail.wide && <RewindPreview cut={cut} online={online} dialog onClose={() => setCut(null)} onRewound={rewound} />}
      {detail.host && createPortal(
        cut ? <RewindPreview cut={cut} online={online} dialog={false} onClose={() => setCut(null)} onRewound={rewound} />
        : current ? (
          <WorkspaceHistoryNotePane
            noteId={current.noteId}
            day={current.day}
            online={online}
            onOpenNote={onOpenNote}
            onChanged={() => { feed.reload(); reloadActivity(); }}
          />
        ) : <p className="wh-empty wh-detail-empty">{t("Pick a change to see what changed here")}</p>,
        detail.host,
      )}
      {loadFailed && (
        <LoadError failed={t("Couldn't load the history.")} online={online} onRetry={retryAll} />
      )}

      {cut && (
        <p className="wh-cut-banner" role="status">
          {t("Looking back to {when}. Changes after it are dimmed: a restore would undo them.", { when: cutWhen(cut) })}{" "}
          <Pressable type="button" className="wh-link" onClick={() => setCut(null)}>{t("Close preview")}</Pressable>
        </p>
      )}

      <WorkspaceHistoryChart
        days={chartDays}
        selected={selected}
        agentLabel={agentLabel}
        onSelect={setPicked}
        onEarlier={() => setChartUntil(addDays(chartUntil, -HISTORY_DAYS))}
        onLater={chartUntil < today ? () => setChartUntil(addDays(chartUntil, HISTORY_DAYS) > today ? today : addDays(chartUntil, HISTORY_DAYS)) : null}
      />

      {feed.status === "loading" && <p className="wh-empty">{t("Loading…")}</p>}

      {day && (
        <section key={day.date} className="wh-day-group" data-day={day.date}>
          <div className="wh-day-head">
            <h3 className="wh-day-title">
              {dayHeading(day.date)}{" "}
              <span className="wh-day-count">· {t("{n} edits", { n: day.edits_total })}</span>
            </h3>
            {day.date !== today && (
              <Pressable type="button" className="wh-link wh-day-look" onClick={() => setCut(cutForDayEnd(day.date, day.end_at))}>{t("How it looked that day")}</Pressable>
            )}
          </div>
          {(day.rewinds ?? []).map((rewind) => (
            <WorkspaceHistoryRewindCard
              key={rewind.rewind_id}
              rewind={rewind}
              online={online}
              afterCut={isAfterCut(cut, rewind.at)}
              onOpenInbox={onOpenInbox}
              onNotice={onNotice}
              onChanged={() => { feed.reload(); reloadActivity(); }}
            />
          ))}
          {(day.system_tidies ?? []).map((tidy) => (
            <WorkspaceHistorySystemTidy
              key={`${tidy.batch}:${tidy.at}`}
              tidy={tidy}
              onOpenNote={(noteId) => openHistory(noteId, day.date)}
              selectedNoteId={current !== null && current.day === day.date ? current.noteId : null}
            />
          ))}
          {(() => {
            const runLine = cutLineAt(day.agent_runs, cut, (r) => isAfterCut(cut, r.started_at), cutDay === day.date && day.notes.length === 0);
            return day.agent_runs.map((run, i) => (
              <Fragment key={run.run_id}>
                {runLine === i && cut && <CutLine cut={cut} />}
            <WorkspaceHistoryRunCard
              run={run}
              online={online}
              afterCut={isAfterCut(cut, run.started_at)}
              onGoBackBefore={() => setCut(cutBefore(run.started_at))}
              onOpenNoteHistory={(noteId) => openHistory(noteId, day.date)}
              selectedNoteId={current !== null && current.day === day.date ? current.noteId : null}
              onOpenInbox={onOpenInbox}
              onNotice={onNotice}
              onChanged={() => { feed.reload(); reloadActivity(); }}
            />
              </Fragment>
            )).concat(runLine === day.agent_runs.length && cut ? [<CutLine key="cut-line" cut={cut} />] : []);
          })()}
          {day.notes.length > 0 && (() => {
            const noteLine = cutLineAt(day.notes, cut, (n) => isAfterCut(cut, n.last_at), cutDay === day.date);
            return (
              <ul className="wh-notes">
                {day.notes.map((n, i) => {
                  const key = rowKey({ noteId: n.id, day: day.date });
                  return (
                    <Fragment key={n.id}>
                      {noteLine === i && cut && <li className="wh-cut-item"><CutLine cut={cut} /></li>}
                      <WorkspaceHistoryNoteRow
                        note={n} online={online} rowId={key} selected={current !== null && rowKey(current) === key}
                        afterCut={isAfterCut(cut, n.last_at)}
                        onGoBackBefore={() => setCut(cutBefore(n.first_at))}
                        onOpen={() => openHistory(n.id, day.date)}
                      />
                    </Fragment>
                  );
                })}
                {noteLine === day.notes.length && cut && <li className="wh-cut-item"><CutLine cut={cut} /></li>}
                {day.notes_total > day.notes.length && (
                  <li className="wh-more-item">
                    <Pressable type="button" className="wh-link" disabled={!online || moreNotes === day.date} onClick={() => void showMoreNotes(day.date)}>
                      {t("Show more ({n} left)", { n: day.notes_total - day.notes.length })}
                    </Pressable>
                    {moreNotesFailed === day.date && <span className="wh-empty"> {t("Couldn't load the history.")}</span>}
                  </li>
                )}
              </ul>
            );
          })()}
        </section>
      )}

      {!day && (feed.status === "ready" || feed.unavailable) && (
        covered ? (
          <p className="wh-empty">{feed.days.length === 0 && !feed.hasMore ? t("No changes yet.") : t("No edits on this day.")}</p>
        ) : feed.moreStatus === "error" ? (
          <LoadError failed={t("Couldn't load the history.")} online={online} onRetry={() => void loadThrough(selected)} />
        ) : <p className="wh-empty">{t("Loading…")}</p>
      )}
    </div>
  );
}
