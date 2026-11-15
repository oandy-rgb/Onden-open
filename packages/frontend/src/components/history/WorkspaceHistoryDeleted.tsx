// 「最近刪除」: every deleted note, with the blank ones (no title, no text, nothing under them)
// folded into one row on top that can bring them all back or delete them all for good.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { Button, LoadError, Pressable } from "../ui";
import { useCapabilities } from "../../lib/capabilities";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { nodeMutations, notePurge, PURGE_BATCH_MAX, writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { addDays, dateIdAt } from "../../lib/localDate";
import { useToday } from "../../hooks/useToday";
import { timeLabel } from "../../lib/timeLabels";
import { useHistorySpace } from "./historySpace";
import { fetchDeleted } from "../../lib/history";
import { monthDay } from "./WorkspaceHistoryChart";
import PurgeBlankNotesDialog from "./PurgeBlankNotesDialog";
import WorkspaceHistoryDeletedPane from "./WorkspaceHistoryDeletedPane";
import { NARROW, type DetailSlot } from "./detailSlot";
import { failed, useLoad } from "./useLoad";
import { displayTitle } from "../../lib/noteLabel";
import EmptyState from "../EmptyState";
import type { DeletedNote } from "@onden/contract";

const PurgeDeletedModal = lazyWithReload(() => import("../PurgeDeletedModal"));

/** A long list shows this many rows and then 「顯示更多」. */
const PAGE = 50;

type Props = {
  online: boolean;
  onNotice: (message: string) => void;
  /** Two columns: a row shows what the note said on the right. */
  detail?: DetailSlot;
};

/** The selection of the folded row of blank notes. */
const BLANK_GROUP = "blank-group";

export default function WorkspaceHistoryDeleted({ online, onNotice, detail = NARROW }: Props) {
  const t = useT();
  const today = useToday();
  const { spaceId, labelFor } = useHistorySpace();
  const [deleted, reload] = useLoad(() => fetchDeleted(undefined, spaceId), [spaceId]);
  // 永久刪除 is offered to a manager of the note's space, or the owner in a shared one — the server's rule.
  const caps = useCapabilities(online);
  const [busy, setBusy] = useState(false);
  const [purging, setPurging] = useState<string | null>(null);
  const [blankOpen, setBlankOpen] = useState(false);
  const [confirmingBlank, setConfirmingBlank] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [blankShown, setBlankShown] = useState(PAGE);

  // 「顯示更早」: nothing is deleted by age, so the list goes on past the first page (the last 30 days) by the server's cursor.
  const [older, setOlder] = useState<{ notes: DeletedNote[]; cursor: string | null; loading: boolean; failed: boolean } | null>(null);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setOlder(null); }, [deleted]);
  const firstPage = deleted.status === "ready" ? deleted.value : null;
  const olderCursor = older ? older.cursor : firstPage?.older_cursor ?? null;
  const showEarlier = async () => {
    if (olderCursor === null || older?.loading) return;
    const mine = generation.current;
    setOlder((o) => ({ notes: o?.notes ?? [], cursor: olderCursor, loading: true, failed: false }));
    try {
      const page = await fetchDeleted(undefined, spaceId, olderCursor);
      if (mine === generation.current) setOlder((o) => ({ notes: [...(o?.notes ?? []), ...page.notes], cursor: page.older_cursor, loading: false, failed: false }));
    } catch {
      if (mine === generation.current) setOlder((o) => ({ notes: o?.notes ?? [], cursor: olderCursor, loading: false, failed: true }));
    }
  };

  const all = useMemo(() => (firstPage ? [...firstPage.notes, ...(older?.notes ?? [])] : []), [firstPage, older]);
  const blank = useMemo(() => all.filter((n) => n.blank), [all]);
  const rest = useMemo(() => all.filter((n) => !n.blank), [all]);
  const purgeableBlank = blank.filter((n) => caps.canPurgeDeleted(n.space_id));

  // Rows top to bottom, as the arrow keys walk them; the first is the default pick.
  const order = useMemo(() => [
    ...(blank.length > 0 ? [BLANK_GROUP] : []),
    ...(blankOpen ? blank.slice(0, blankShown).map((n) => n.id) : []),
    ...rest.slice(0, shown).map((n) => n.id),
  ], [blank, blankOpen, blankShown, rest, shown]);
  const [chosen, setChosen] = useState<string | null>(null);
  const first = order[0] ?? null;
  const chosenExists = chosen !== null && (chosen === BLANK_GROUP ? blank.length > 0 : all.some((n) => n.id === chosen));
  useEffect(() => {
    if (detail.wide && first && !chosenExists) setChosen(first);
  }, [detail.wide, first, chosenExists]);
  const current = detail.wide ? (chosenExists ? chosen : first) : null;
  const list = useRef<HTMLElement>(null);
  const onListKeyDown = (event: KeyboardEvent) => {
    if (!detail.wide) return;
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-row]");
    if (!el) return;
    const at = order.indexOf(el.dataset.row!);
    const next = event.key === "ArrowDown" ? order[at + 1] : event.key === "ArrowUp" ? order[at - 1] : undefined;
    if (at < 0 || !next) return;
    event.preventDefault();
    setChosen(next);
    list.current?.querySelector<HTMLElement>(`[data-row="${next}"]`)?.focus();
  };

  const deletedWhen = (iso: string) => {
    const day = dateIdAt(new Date(iso));
    const label = day === today ? t("Today") : day === addDays(today, -1) ? t("Yesterday") : monthDay(day);
    return `${label} ${timeLabel(iso)}`;
  };

  const rescue = useCallback(async (note: DeletedNote) => {
    if (busy) return;
    setBusy(true);
    try {
      if (await nodeMutations.undeleteNode(note.id)) {
        onNotice(t("Brought back “{title}” to where it was", { title: displayTitle(note.title) }));
        reload();
      }
    } finally {
      setBusy(false);
    }
  }, [busy, onNotice, reload, t]);

  const rescueAllBlank = async () => {
    if (busy) return;
    setBusy(true);
    let ok = 0;
    try {
      // One at a time: each is its own undelete, with the single note's checks and error report.
      for (const note of blank) if (await nodeMutations.undeleteNode(note.id)) ok++;
    } finally {
      setBusy(false);
      if (ok > 0) reload();
    }
    const left = blank.length - ok;
    onNotice(left === 0 ? t("Brought back {n} blank notes", { n: ok }) : t("Brought back {n} blank notes, {m} could not be brought back", { n: ok, m: left }));
  };

  const purgeAllBlank = async () => {
    if (busy) return;
    setBusy(true);
    setPurgeError(null);
    let gone = 0;
    let refused = 0;
    let unknown = false;
    try {
      // A blank note goes alone, so the ids to confirm are just its own.
      for (let i = 0; i < purgeableBlank.length; i += PURGE_BATCH_MAX) {
        const items = purgeableBlank.slice(i, i + PURGE_BATCH_MAX).map((n) => ({ nodeId: n.id, expectedIds: [n.id] }));
        const results = await notePurge.purgeMany(items);
        if (results === null) { unknown = true; continue; }
        // Already gone (not_found) is what was asked for.
        for (const r of results) if (r.purged || r.code === "not_found") gone++; else refused++;
      }
      setConfirmingBlank(false);
      onNotice(unknown ? t("Sent. The list was read again.")
        : refused === 0 ? t("Deleted {n} blank notes for good", { n: gone })
          : t("Deleted {n} blank notes for good, {m} could not be deleted", { n: gone, m: refused }));
    } catch (error) {
      setPurgeError(writeErrors.message(error));
      if (gone > 0) onNotice(t("Deleted {n} blank notes for good, {m} could not be deleted", { n: gone, m: purgeableBlank.length - gone }));
    } finally {
      setBusy(false);
      if (gone > 0 || unknown) reload();
    }
  };

  const rows = (items: DeletedNote[], limit: number, more: () => void) => (
    <>
      <ul className="wh-notes">
        {items.slice(0, limit).map((n) => {
          const text = (
            <>
              <span className="wh-note-titleline">
                <span className="wh-note-title">{displayTitle(n.title)}</span>
                {labelFor(n.space_id) && <span className="wh-note-space">{labelFor(n.space_id)}</span>}
              </span>
              <span className="wh-note-meta">{t("Deleted {when}", { when: deletedWhen(n.deleted_at) })}</span>
            </>
          );
          return (
          <li key={n.id} className={"wh-deleted-row" + (current === n.id ? " selected" : "")}>
            {detail.wide
              ? <Pressable type="button" className="wh-note-text wh-deleted-pick wh-touch" data-row={n.id} aria-current={current === n.id || undefined} onClick={() => setChosen(n.id)}>{text}</Pressable>
              : <span className="wh-note-text">{text}</span>}
            <span className="wh-deleted-actions">
              <Button variant="secondary" size="sm" className="wh-touch" disabled={!online || busy} onClick={() => void rescue(n)}>
                {t("Bring back")}
              </Button>
              {caps.canPurgeDeleted(n.space_id) && (
                <Button variant="ghost" size="sm" className="wh-touch wh-purge" disabled={!online || busy} onClick={() => setPurging(n.id)}>
                  {t("Delete for good")}
                </Button>
              )}
            </span>
          </li>
          );
        })}
      </ul>
      {items.length > limit && (
        <Pressable type="button" className="wh-link wh-more" onClick={more}>
          {t("Show more ({n} left)", { n: items.length - limit })}
        </Pressable>
      )}
    </>
  );

  return (
    <section ref={list} className="wh-deleted" aria-label={t("Recently deleted")} onKeyDown={onListKeyDown}>
      {detail.host && createPortal(
        <WorkspaceHistoryDeletedPane
          note={current === null || current === BLANK_GROUP ? null : all.find((n) => n.id === current) ?? null}
          blankCount={current === BLANK_GROUP ? blank.length : 0}
          online={online}
          busy={busy}
          onRescue={(n) => void rescue(n)}
        />,
        detail.host,
      )}
      {failed(deleted) && (
        <LoadError failed={t("Couldn't load the history.")} online={online} onRetry={reload} />
      )}
      {deleted.status === "loading" && <EmptyState size="inline" title={t("Loading…")} />}
      {((deleted.status === "ready" && all.length === 0) || (deleted.status === "error" && deleted.unavailable)) && (
        <EmptyState size="inline" title={t("You have no deleted notes.")} />
      )}

      {blank.length > 0 && (
        <div className="wh-blank">
          <div className={"wh-blank-row" + (current === BLANK_GROUP ? " selected" : "")}>
            <Pressable
              type="button"
              className="wh-blank-toggle wh-touch"
              aria-expanded={blankOpen}
              aria-controls="wh-blank-list"
              aria-current={current === BLANK_GROUP || undefined}
              data-row={detail.wide ? BLANK_GROUP : undefined}
              onClick={() => { setBlankOpen((open) => !open); if (detail.wide) setChosen(BLANK_GROUP); }}
            >
              <ChevronRight size={16} aria-hidden="true" className={"wh-chevron" + (blankOpen ? " open" : "")} />
              <span className="wh-note-title">{t("{n} blank notes", { n: blank.length })}</span>
            </Pressable>
            <span className="wh-deleted-actions">
              <Button variant="secondary" size="sm" className="wh-touch" disabled={!online || busy} onClick={() => void rescueAllBlank()}>
                {t("Bring back all")}
              </Button>
              {purgeableBlank.length > 0 && (
                <Button variant="ghost" size="sm" className="wh-touch wh-purge" disabled={!online || busy} onClick={() => { setPurgeError(null); setConfirmingBlank(true); }}>
                  {t("Delete all for good")}
                </Button>
              )}
            </span>
          </div>
          {blankOpen && <div id="wh-blank-list">{rows(blank, blankShown, () => setBlankShown((n) => n + PAGE))}</div>}
        </div>
      )}

      {rows(rest, shown, () => setShown((n) => n + PAGE))}
      {olderCursor !== null && rest.length <= shown && (
        older?.failed
          ? <LoadError failed={t("Couldn't load the history.")} online={online} onRetry={() => void showEarlier()} />
          : (
            <Pressable type="button" className="wh-link wh-more" disabled={!online || older?.loading} onClick={() => void showEarlier()}>
              {older?.loading ? t("Loading…") : t("Show earlier")}
            </Pressable>
          )
      )}

      {purging && (
        <Suspense fallback={null}>
          <PurgeDeletedModal
            nodeId={purging}
            onClose={() => setPurging(null)}
            onPurged={() => { setPurging(null); reload(); }}
          />
        </Suspense>
      )}
      {confirmingBlank && (
        <PurgeBlankNotesDialog
          count={purgeableBlank.length}
          skipped={blank.length - purgeableBlank.length}
          busy={busy}
          error={purgeError}
          onConfirm={() => void purgeAllBlank()}
          onClose={() => setConfirmingBlank(false)}
        />
      )}
    </section>
  );
}
