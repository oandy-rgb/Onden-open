import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ArrowLeft, ExternalLink, Layers, X } from "lucide-react";
import { clampNoteTitle, NODE_TITLE_MAX } from "@onden/markdown";
import type { ContentNode } from "../../lib/api";
import { resolveWikilink, type WikilinkSource } from "../../lib/wikilinks";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { INK_KINDS, type InkKind } from "@onden/markdown/ink";
import { drafts, nodeMutations, noteWriter, reads, writeErrors } from "../../lib/data";
import type { InkEdit } from "@onden/contract";
import { useAccountSession } from "../../lib/accountSession";
import { useT } from "../../lib/i18n";
import { dateLabel, dayLabel, timeLabel } from "../../lib/timeLabels";
import {
  alignParagraphs, pointChangeText, inkChangeText, inkKindHeading, splitParagraphs, planTakeBack, buildTimeline, initialIndex, scrubReducer, shown,
  type HistoryMarker, type NoteHistoryVersion, type ScrubAction, type ScrubState, type TimelinePoint,
} from "../../lib/history";
import { useVersionRestore } from "../../hooks/useVersionRestore";
import { Button, LoadError, Modal, Pressable } from "../ui";
import { HistorySlider } from "./HistorySlider";
import { displayTitle } from "../../lib/noteLabel";
import RestoreVersionDialog from "./RestoreVersionDialog";
import InkChangeDisclosure from "./InkChangeDisclosure";
import { useLoad } from "./useLoad";
import "./NoteHistory.css";

const OverviewPreview = lazyWithReload(() => import("../OverviewPreview"));

type Props = {
  node: ContentNode;
  /** Shown at once while the list is read again from the server. Newest first. */
  versions?: NoteHistoryVersion[];
  initialVersionId?: string;
  /** No version asked for: open on the end of this day (YYYY-MM-DD). */
  initialDay?: string;
  /** The note's live text, including unsaved typing. */
  currentMarkdown: string;
  nodes: ContentNode[];
  from?: WikilinkSource | null;
  online: boolean;
  /** Open another note (the copy made by "save as new note"). */
  onOpenNote: (id: string) => void;
  /** Close the dialog. Not used inline. */
  onClose?: () => void;
  /** Sits in the page beside a list instead of in a dialog: no back button, a button that
   *  opens the note in the editor. The slider, marks and every action are the same. */
  inline?: boolean;
  /** A restore, a taken-back paragraph or a copy changed the workspace (the list beside this reads again). */
  onChanged?: () => void;
};

const NO_VERSIONS: NoteHistoryVersion[] = [];

/** "3:01 PM" today, "Oct 3, 3:01 PM" otherwise. */
function whenLabel(iso: string | null): string {
  if (!iso) return "";
  return dayLabel(iso) === dayLabel(new Date().toISOString()) ? timeLabel(iso) : dateLabel(iso, "shortDateTime");
}

function markerLabel(t: ReturnType<typeof useT>, marker: HistoryMarker): string {
  if (marker === "before_agent") return t("Before AI edit");
  if (marker === "restored") return t("Back to an older version");
  return t("Published #{n}", { n: marker.slice("published:".length) });
}

export function NoteHistory({ node, versions: initialVersions = NO_VERSIONS, initialVersionId, initialDay, currentMarkdown, nodes, from, online, onOpenNote, onClose, inline = false, onChanged }: Props) {
  const t = useT();
  const selfName = useAccountSession()?.user.name ?? null;
  const [versions, setVersions] = useState(initialVersions);
  const points = useMemo(() => buildTimeline(versions, currentMarkdown, node.title), [versions, currentMarkdown, node.title]);
  const pointCount = useRef(points.length);
  pointCount.current = points.length;
  const [scrub, setScrub] = useState<ScrubState>(() => ({ index: initialIndex(buildTimeline(initialVersions, currentMarkdown, node.title), initialVersionId, initialDay), holding: false, paragraph: null }));
  const dispatch = useCallback((action: ScrubAction) => setScrub((s) => scrubReducer(s, action, pointCount.current)), []);
  const [panelOpen, setPanelOpen] = useState(false);
  const [notice, setNotice] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null);
  const [working, setWorking] = useState(false);
  const busy = useRef(false);
  const { restore } = useVersionRestore();
  // Asked only when the version's title is not the note's title now.
  const [askTitle, setAskTitle] = useState<{ versionId: string; label: string; titleThen: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const openLink = (label: string, targetId: string | null) => {
    if (busy.current) return;
    const target = targetId ? nodes.find((n) => n.id === targetId) : resolveWikilink(label, node, nodes);
    if (target) { onOpenNote(target.id); onClose?.(); }
  };

  // Read the list again: the dialog may open on the list from when the note was
  // opened, and a restore adds a row.
  const reload = useCallback(async () => {
    const fresh = await reads.notes.versions(node.id);
    setVersions(fresh as NoteHistoryVersion[]);
    return fresh as NoteHistoryVersion[];
  }, [node.id]);
  // Inline, the list arrives after the first paint: say so instead of showing an empty note.
  const [loaded, setLoaded] = useState(initialVersions.length > 0 || !online);
  // A failed read is not an empty history; Try again bumps `attempt` to read once more.
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const watching = useRef<string | null>(null);
  useEffect(() => {
    if (!online) {
      // Try again pressed with no connection: back to the failure row (it names the connection), not stuck on Loading.
      if (attempt > 0) { setRetrying(false); setLoaded(true); setLoadFailed(true); }
      return;
    }
    let cancelled = false;
    void reads.notes.versions(node.id).then((read) => {
      const fresh = read as NoteHistoryVersion[];
      // An empty answer cannot be right for a note opened with saved versions.
      if (cancelled || (fresh.length === 0 && initialVersions.length > 0)) return;
      setVersions(fresh);
      setLoaded(true);
      setLoadFailed(false);
      setRetrying(false);
      const rebuilt = buildTimeline(fresh, currentMarkdown, node.title);
      // Opened with no list at all: land on the newest stored version. Otherwise
      // stay on the version being looked at, wherever it now sits in the list.
      if (initialVersions.length === 0) dispatch({ type: "seek", index: initialIndex(rebuilt, initialVersionId, initialDay) });
      else if (watching.current === null) dispatch({ type: "latest" });
      else dispatch({ type: "seek", index: initialIndex(rebuilt, watching.current) });
    }).catch(() => { if (!cancelled) { setLoaded(true); setLoadFailed(true); setRetrying(false); } });
    return () => { cancelled = true; };
  }, [node.id, online, attempt]); // eslint-disable-line react-hooks/exhaustive-deps -- reads once per opening

  const view = shown(points, scrub);
  watching.current = points[scrub.index]?.versionId ?? null;
  const point = view.point;
  const atNow = scrub.index >= points.length - 1;

  const whoIs = (kind: TimelinePoint["authorKind"], name: string | null) => {
    if (kind === "agent") return { text: name || t("AI"), cls: "nh-author--agent" };
    if (kind === "system") return { text: t("Automatic"), cls: "nh-author--system" };
    return { text: selfName && name === selfName ? t("You") : name || t("Someone"), cls: "nh-author--human" };
  };
  const authorOf = (p: TimelinePoint) => (p.versionId === null ? null : whoIs(p.authorKind, p.authorName));
  // What each edit of the note's drawings (its handwriting page, its whiteboard's pen layer) drew and erased
  // (counts); the picture is read when a row is opened. A drawing that cannot be listed is left out.
  const [inkLists, reloadInk] = useLoad(
    () => (online ? Promise.all(INK_KINDS.map(async (kind) => ({ kind, edits: await reads.notes.inkEdits(node.id, kind).catch(() => [] as InkEdit[]) }))) : Promise.resolve([])),
    [node.id, online],
  );
  const inkSections = (inkLists.status === "ready" ? inkLists.value : []).filter((l) => l.edits.length > 0);
  const author = authorOf(scrub.holding && !atNow ? points[scrub.index] : point);
  const shownWhen = whenLabel(points[scrub.index].changedAt);

  // The shown version, marked against the step before it.
  const bodyParagraphs = useMemo(() => splitParagraphs(view.body), [view.body]);
  const rows = useMemo(() => view.markAgainst === null
    ? bodyParagraphs.map((p) => ({ kind: "same" as const, old: p, new: p }))
    : alignParagraphs(splitParagraphs(view.markAgainst), bodyParagraphs), [view.markAgainst, bodyParagraphs]);

  const plan = useMemo(() => scrub.paragraph === null || atNow ? null : planTakeBack(currentMarkdown, point.body, scrub.paragraph), [scrub.paragraph, atNow, currentMarkdown, point.body]);

  async function takeBackParagraph() {
    if (busy.current || scrub.paragraph === null || atNow) return;
    busy.current = true; setWorking(true);
    const index = scrub.paragraph, source = point.body;
    try {
      // Planned again on the note as it is when the save starts.
      const outcome = await drafts.editText(node.id, (body) => {
        const next = planTakeBack(body, source, index);
        return next.kind === "replace" || next.kind === "insert" ? next.markdown : body;
      });
      const saved = outcome === "applied" && await drafts.flush();
      if (saved) { dispatch({ type: "paragraph", index: null }); setNotice({ text: t("Took back that paragraph") }); onChanged?.(); }
      else if (outcome === "missing") setNotice({ text: t("This note's text is not available here yet.") });
    } catch (error) { setNotice({ text: writeErrors.message(error) }); }
    finally { busy.current = false; setWorking(false); }
  }

  async function restoreVersionAndOffer(versionId: string, label: string, restoreTitle: boolean) {
    if (busy.current) return;
    busy.current = true; setWorking(true); setNotice(null);
    const before = currentMarkdown;
    try {
      const outcome = await restore(node.id, versionId, { restoreTitle });
      if (outcome.status !== "applied") { setNotice({ text: outcome.message }); return; }
      const fresh = await reload().catch(() => null);
      dispatch({ type: "latest" });
      onChanged?.();
      // The step before the restore entry is where "undo" goes back to.
      const previous = fresh ? fresh.slice(1).find((v) => v.markdown === before) ?? fresh[1] : undefined;
      setNotice({
        text: t("Went back to the version of {when}", { when: label }),
        action: previous ? { label: t("Undo restore"), run: () => void undoRestore(previous.id) } : undefined,
      });
    } finally { busy.current = false; setWorking(false); }
  }
  async function undoRestore(versionId: string) {
    if (busy.current) return;
    busy.current = true; setWorking(true);
    try {
      // Undo puts the note back as it was, so its title too (a restore that kept the title changed nothing there).
      const outcome = await restore(node.id, versionId, { restoreTitle: true });
      if (outcome.status === "applied") { await reload().catch(() => null); dispatch({ type: "latest" }); setNotice({ text: t("Undone") }); onChanged?.(); }
      else setNotice({ text: outcome.message });
    } finally { busy.current = false; setWorking(false); }
  }

  /** Put one drawing back as it was after `edit`. The server writes only that drawing's own attribute. */
  async function restoreInk(kind: InkKind, edit: InkEdit, undoTo: InkEdit | null) {
    if (busy.current) return;
    busy.current = true; setWorking(true); setNotice(null);
    try {
      await nodeMutations.restoreInkVersion(node.id, kind, edit.after_event);
      reloadInk();
      onChanged?.();
      setNotice(undoTo
        ? { text: t("Went back to the drawing of {when}", { when: whenLabel(edit.changed_at) }), action: { label: t("Undo restore"), run: () => void restoreInk(kind, undoTo, null) } }
        : { text: t("Undone") });
    } catch (error) { setNotice({ text: writeErrors.message(error) }); }
    finally { busy.current = false; setWorking(false); }
  }

  async function saveAsNewNote() {
    if (busy.current || atNow) return;
    busy.current = true; setWorking(true);
    try {
      const title = clampNoteTitle(`${displayTitle(node.title)}（${shownWhen}）`, NODE_TITLE_MAX);
      const created = await noteWriter.create({
        title, markdown: point.body,
        // Beside the original: same parent, or the same space for a top-level note.
        ...(node.parent_id ? { parent_id: node.parent_id } : node.space_id ? { space_id: node.space_id } : {}),
      });
      setNotice({ text: t("Saved as a new note"), action: { label: t("Open note"), run: () => { onOpenNote(created.node.id); onClose?.(); } } });
      onChanged?.();
    } catch (error) { setNotice({ text: writeErrors.message(error) }); }
    finally { busy.current = false; setWorking(false); }
  }

  // Hold to see now: pointer or the space bar.
  const hold = (pressed: boolean) => dispatch({ type: "hold", pressed });
  const holdKeys = {
    onKeyDown: (e: KeyboardEvent) => { if (e.key === " " || e.key === "Spacebar") { e.preventDefault(); if (!e.repeat) hold(true); } },
    onKeyUp: (e: KeyboardEvent) => { if (e.key === " " || e.key === "Spacebar") hold(false); },
  };

  const lastIndex = points.length - 1;
  const close = () => { if (!busy.current) onClose?.(); };
  const summary = view.peeking ? null : pointChangeText(t, point);
  // A title other than the note's now is said out loud wherever a version is shown.
  const titleNote = (p: TimelinePoint) => p.versionId !== null && p.title !== node.title ? t("Title: {title}", { title: displayTitle(p.title) }) : null;
  const restoredFrom = point.restoredFrom ? versions.find((v) => v.id === point.restoredFrom) : null;

  const screen = (
      <div className={inline ? "nh nh--inline" : "nh"} ref={root} tabIndex={-1} {...(inline ? { role: "region", "aria-label": t("Version history") } : {})}>
        <header className="nh-top">
          {!inline && <Pressable className="nh-icon" onClick={close} aria-label={t("Back")} disabled={working}><ArrowLeft size={20} /></Pressable>}
          <div className="nh-top-title">
            <small>{t("History")}</small>
            <strong>{displayTitle(node.title)}</strong>
          </div>
          {inline && (
            <Pressable className="nh-open" onClick={() => onOpenNote(node.id)} disabled={working}>
              <ExternalLink size={16} aria-hidden="true" /> {t("Open note")}
            </Pressable>
          )}
          <Pressable className="nh-icon nh-all-btn" onClick={() => setPanelOpen((o) => !o)} aria-label={t("All versions")} aria-expanded={panelOpen}><Layers size={20} /></Pressable>
        </header>

        <section className="nh-status" aria-live="polite">
          <div className="nh-status-main">
            <h2>{view.peeking ? t("How it looks now") : atNow ? t("How it looks now") : t("How it looked at {when}", { when: shownWhen })}</h2>
            {!view.peeking && author && <span className={`nh-author ${author.cls}`}>{author.text}</span>}
          </div>
          <p className="nh-status-sub">
            {view.peeking ? t("Release to go back to {when}", { when: shownWhen })
              : atNow ? t("This is the version you are editing")
              : point.restoredFrom && restoredFrom ? t("Went back to the version of {when}", { when: whenLabel(restoredFrom.changed_at) })
              : summary}
          </p>
          {!view.peeking && titleNote(point) && <p className="nh-status-sub">{titleNote(point)}</p>}
        </section>

        <div className="nh-body">
          <div className="nh-paper">
            <Suspense fallback={<div className="nh-loading">{t("Rendering…")}</div>}>
              {((inline && !loaded) || retrying) && <p className="nh-loading">{t("Loading…")}</p>}
              {loadFailed && versions.length === 0 && (
                <LoadError failed={t("Couldn't load the history.")} online={online} onRetry={() => { setLoadFailed(false); setLoaded(false); setRetrying(true); setAttempt((n) => n + 1); }} />
              )}
              {!retrying && !(loadFailed && versions.length === 0) && (!inline || loaded) && rows.length === 0 && <p className="nh-empty">{t("This version has no text.")}</p>}
              {!retrying && !(loadFailed && versions.length === 0) && (!inline || loaded) && rows.map((row, i) => {
                const target = row.new;
                const index = target ? bodyParagraphs.indexOf(target) : -1;
                const selectable = !!target && !atNow && !view.peeking;
                const shownParagraph = target ?? row.old!;
                return (
                  <div
                    key={`${i}-${shownParagraph.start}`}
                    className={`nh-p nh-p--${view.peeking ? "same" : row.kind}${selectable ? " nh-p--pick" : ""}${selectable && scrub.paragraph === index ? " nh-p--open" : ""}`}
                    {...(selectable ? {
                      tabIndex: 0,
                      onClick: () => dispatch({ type: "paragraph", index: scrub.paragraph === index ? null : index }),
                      onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" && e.target === e.currentTarget) dispatch({ type: "paragraph", index }); },
                    } : {})}
                  >
                    {row.kind === "changed" && !view.peeking && <small className="nh-p-old"><del>{row.old.text}</del></small>}
                    <OverviewPreview draft={shownParagraph.text} nodes={nodes} from={from} onOpenWikilink={openLink} />
                  </div>
                );
              })}
            </Suspense>
          </div>
          {(
            <aside className={`nh-versions${panelOpen ? " nh-versions--open" : ""}`} aria-label={t("All versions")}>
              <div className="nh-versions-head">
                <strong>{t("All versions")}</strong>
                <Pressable className="nh-icon" onClick={() => setPanelOpen(false)} aria-label={t("Close")}><X size={18} /></Pressable>
              </div>
              <ol>
                {[...points].reverse().map((p, reversed) => {
                  const i = lastIndex - reversed;
                  const who = authorOf(p);
                  return (
                    <li key={p.versionId ?? "now"}>
                      <Pressable className={`nh-row${i === scrub.index ? " nh-row--current" : ""}`} aria-current={i === scrub.index || undefined}
                        onClick={() => { dispatch({ type: "seek", index: i }); setPanelOpen(false); }}>
                        <span className="nh-row-top">
                          <b>{p.versionId === null ? t("Now") : whenLabel(p.changedAt)}</b>
                          {who && <span className={`nh-author ${who.cls}`}>{who.text}</span>}
                          {p.markers.map((m) => <span key={m} className="nh-pill">{markerLabel(t, m)}</span>)}
                        </span>
                        <span className="nh-row-sub">{p.versionId === null ? t("This is the version you are editing") : pointChangeText(t, p)}</span>
                        {titleNote(p) && <span className="nh-row-sub">{titleNote(p)}</span>}
                      </Pressable>
                    </li>
                  );
                })}
              </ol>
              {inkSections.map(({ kind, edits }) => (
                <section key={kind} className="nh-ink" aria-label={inkKindHeading(t, kind)}>
                  <strong>{inkKindHeading(t, kind)}</strong>
                  <ul>
                    {edits.map((e, i) => {
                      const who = whoIs(e.actor_kind, e.actor_name);
                      return (
                        <li key={e.id}>
                          <span className="nh-row-top"><b>{whenLabel(e.changed_at)}</b><span className={`nh-author ${who.cls}`}>{who.text}</span></span>
                          <span className="nh-row-sub">{inkChangeText(t, kind, e)}</span>
                          <InkChangeDisclosure noteId={node.id} kind={kind} change={e} online={online} />
                          {i > 0 && (
                            <Pressable className="nh-ink-restore" disabled={working || !online}
                              title={online ? undefined : t("Offline — reconnect to restore")}
                              onClick={() => void restoreInk(kind, e, edits[0]!)}>{t("Go back to this drawing")}</Pressable>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </aside>
          )}
        </div>

        <footer className="nh-bottom">
          {notice && (
            <div className="nh-notice" role="status">
              <span>{notice.text}</span>
              {notice.action && <Pressable onClick={notice.action.run}>{notice.action.label}</Pressable>}
              <Pressable className="nh-icon" onClick={() => setNotice(null)} aria-label={t("Close")}><X size={16} /></Pressable>
            </div>
          )}
          {plan && plan.kind !== "missing" && (
            <div className="nh-take" role="region" aria-label={t("Take back just this paragraph")}>
              <strong>{t("Take back just this paragraph")}</strong>
              {plan.kind === "same" ? <p>{t("This paragraph is the same as now.")}</p> : (
                <div className="nh-take-pair">
                  <div className="nh-take-then"><small>{t("How it looked at {when}", { when: shownWhen })}</small><Suspense fallback={null}><OverviewPreview draft={plan.text} nodes={nodes} from={from} onOpenWikilink={openLink} /></Suspense></div>
                  <div className="nh-take-now"><small>{t("Now")}</small>{plan.kind === "replace" ? <Suspense fallback={null}><OverviewPreview draft={plan.now} nodes={nodes} from={from} onOpenWikilink={openLink} /></Suspense> : <p className="nh-muted">{t("This paragraph is not in the note now.")}</p>}</div>
                </div>
              )}
              <div className="nh-take-actions">
                <Button variant="ghost" onClick={() => dispatch({ type: "paragraph", index: null })}>{t("Cancel")}</Button>
                {plan.kind !== "same" && <Button variant="primary" disabled={working} onClick={() => void takeBackParagraph()}>{plan.kind === "insert" ? t("Put this paragraph back") : t("Take back this paragraph")}</Button>}
              </div>
            </div>
          )}

          {lastIndex > 0 && (
            <div className="nh-scrub">
              <div className="nh-markers" aria-hidden="true">
                {points.flatMap((p, i) => p.markers.map((m) => (
                  <span key={`${i}-${m}`} className="nh-pill nh-pill--float" style={{ "--at": `${Math.min(88, Math.max(12, lastIndex <= 0 ? 100 : (i / lastIndex) * 100))}%` } as CSSProperties}>{markerLabel(t, m)}</span>
                )))}
              </div>
              <HistorySlider
                points={points} index={scrub.index} disabled={working}
                ariaLabel={t("Move through this note's history")}
                ariaValueText={atNow ? t("Now") : `${shownWhen}${author ? ` · ${author.text}` : ""}`}
                labelFor={(i) => i >= lastIndex ? t("Now") : whenLabel(points[i]!.changedAt)}
                onSeek={(index) => dispatch({ type: "seek", index })}
              />
              <div className="nh-ends"><span>{dateLabel(points[0].changedAt, "short")}</span><span>{t("Now")}</span></div>
            </div>
          )}

          <div className="nh-actions">
            <Pressable
              className="nh-hold" disabled={atNow}
              onPointerDown={() => hold(true)} onPointerUp={() => hold(false)} onPointerLeave={() => hold(false)} onPointerCancel={() => hold(false)}
              onBlur={() => hold(false)} onContextMenu={(e) => e.preventDefault()} {...holdKeys}
            >{t("Hold to see now")}</Pressable>
            {atNow ? <p className="nh-now-note">{t("This is the version you are editing")}</p> : (<>
              <Button disabled={working} onClick={() => void saveAsNewNote()}>{t("Save as new note")}</Button>
              <Button variant="primary" disabled={working || !online || !point.versionId}
                title={online ? undefined : t("Offline — reconnect to restore")}
                onClick={() => point.title === node.title
                  ? void restoreVersionAndOffer(point.versionId!, shownWhen, false)
                  : setAskTitle({ versionId: point.versionId!, label: shownWhen, titleThen: point.title })}>{t("Go back to this version")}</Button>
            </>)}
          </div>
        </footer>
        {askTitle && (
          <RestoreVersionDialog
            when={askTitle.label} titleNow={node.title} titleThen={askTitle.titleThen}
            onClose={() => setAskTitle(null)}
            onConfirm={(restoreTitle) => { const ask = askTitle; setAskTitle(null); void restoreVersionAndOffer(ask.versionId, ask.label, restoreTitle); }}
          />
        )}
      </div>
  );
  return inline ? screen : (
    <Modal label={t("Version history")} className="nh-backdrop" busy={working} onClose={close} initialFocus={root}>
      {screen}
    </Modal>
  );
}

export default NoteHistory;
