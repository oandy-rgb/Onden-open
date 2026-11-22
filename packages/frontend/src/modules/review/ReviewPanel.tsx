import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { GraduationCap, ExternalLink } from "lucide-react";
import type { ReviewCard as WireCard, ReviewGradeRequest, ReviewGradeResult, ReviewRating, ReviewUndoRequest } from "@onden/contract";
import { ApiError } from "../../lib/api";
import { t } from "../../lib/i18n";
import { ReviewCard } from "../../components/markdownSurfaces";
import { useReviewStats } from "./useReviewStats";
import { inkThumbnailSvg } from "../../lib/ink/thumbnail";
import { decodeInk } from "@onden/markdown/ink";
import { randomUUID } from "../../lib/uuid";
import { reads, sendWrite, writeErrors } from "../../lib/data";
import { getAppState, subscribeApp, useAppSelector } from "../../lib/appStore";
import { register } from "../../lib/liveInvalidation";
import "./ReviewPanel.css";
import { Button, Pressable } from "../../components/ui";
import PanelHeader from "../../components/PanelHeader";
import { displayTitle } from "../../lib/noteLabel";
import EmptyState from "../../components/EmptyState";
import { onWindow } from "../../lib/globalEvents";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { revealBlockInNote } from "../../lib/noteReveal";
import { cardKey, cardPath } from "./cardKey";
import { intervalLabel } from "./intervalLabel";
import { ReviewActions, ReviewContextBlock } from "./ReviewCardExtras";
import StoppedInNote from "./StoppedInNote";
import { useHasKeyboard } from "../../hooks/useKbdHint";

// The review drawer — one card at a time, four plain buttons. Deliberately
// ordinary: no ease factors, no retention dials, no SRS vocabulary beyond
// again/hard/good/easy ([[surface-no-programmer-ui]]). Keyboard 1–4 grades
// the visible card.
//
// A session retains its position, but not an authority snapshot: live changes
// and membership checks invalidate its readable cards. Revalidation intersects
// the remaining session with the server queue; it never restarts completed work.

const ReviewEditSheet = lazyWithReload(() => import("./ReviewEditSheet"));

type Card = WireCard;
type Rating = ReviewRating;
// `seenReps`: the card's reps as shown when the grade was chosen, kept across retries so the server can tell a card another device graded since.
type GradeAttempt = { nodeId: string; rating: Rating; key: string; seenReps: number };

type Props = {
  online: boolean;
  /** Drawer close — omitted when Review is a full page (its own mode). */
  onClose?: () => void;
  onOpenNode: (id: string) => void;
  /** Called after a grading session changes counts (lets the host refresh
   *  any due-count surfaces). */
  onGraded?: () => void;
  /** Optional subtree scope — review only the cards under this note (its
   *  deck), without the tag filter. "卡片長在空間結構上". */
  rootId?: string;
  rootTitle?: string;
  /** Direct members of a tag that provides review; independent of tree scope. */
  tagId?: string;
  tagName?: string;
  /** Only the cards no tag group covers (the status page's 「沒有標籤」 group). */
  untagged?: boolean;
  /** Leave the group for all cards; shown beside the line that says which group this is. */
  onShowAll?: () => void;
  /** Open the status page (the full page only; a tag's own session has none). */
  onOpenStatus?: () => void;
};

const GRADES: Array<{ rating: Rating; label: string }> = [
  { rating: 1, label: "Again" },
  { rating: 2, label: "Hard" },
  { rating: 3, label: "Good" },
  { rating: 4, label: "Easy" },
];

export default function ReviewPanel(props: Props) {
  return <ReviewSession key={JSON.stringify([props.rootId ?? null, props.tagId ?? null, props.untagged ?? false])} {...props} />;
}

function ReviewSession({ online, onClose, onOpenNode, onGraded, rootId, rootTitle, tagId, tagName, untagged, onShowAll, onOpenStatus }: Props) {
  const hasKeyboard = useHasKeyboard();
  // Offer the one-step setup only while no tag gives Review.
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const membershipGated = useAppSelector(s => s.membershipGated);
  const [queueChecked, setQueueChecked] = useState(false);
  const [checking, setChecking] = useState(true);
  const [queueError, setQueueError] = useState<string | null>(null);
  const queueReadable = useRef(false);
  const gradeBusy = useRef(false);
  const queue = useRef<{ invalidate: () => void; resume: () => void; remove: (id: string) => void; restore: (id: string) => void } | null>(null);
  // The card just graded, until undone or the next grade (undo-grade steps
  // that one grade back; a second undo would have nothing to step to).
  const [lastGraded, setLastGraded] = useState<string | null>(null);
  // The reps that grade produced: the undo carries it, so it never removes a grade another device made since.
  const lastGradedReps = useRef(0);
  // And its id: reps repeat after grade, undo, grade (also from another device), an id does not.
  const lastGradedId = useRef<string | undefined>(undefined);
  // One Idempotency-Key per undo attempt, reused when retrying an unconfirmed
  // one: a second undo with a new key would step back again — past the grade
  // — and reset the card to new.
  const undoAttempt = useRef<{ nodeId: string; key: string } | null>(null);
  // A transport failure can mean that the grade committed but its response was
  // lost. Keep this attempt's key and rating until the server confirms it.
  const attempt = useRef<GradeAttempt | null>(null);
  const [uncertainRating, setUncertainRating] = useState<Rating | null>(null);
  // Recall gate: the back (note body) stays hidden until you explicitly
  // reveal it, so a review actually tests recall instead of just showing the
  // answer. Reset per card as the queue advances.
  const [revealed, setRevealed] = useState(false);
  // How many new cards today's cap still allows, made legible: it explains why fewer new cards surface than exist.
  // Tick-driven, so it follows along as grading uses the cap.
  const { stats } = useReviewStats();
  // The paragraph being edited in place (the editor's own sheet; see ReviewEditSheet).
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let alive = true;
    let revision = 0;
    let inFlight = false;
    let dirty = true;
    let gated = getAppState().membershipGated;
    let controller: AbortController | null = null;
    let remainingIds: string[] | null = null;
    const completed = new Set<string>();
    const url = untagged ? "/api/review/queue?untagged=true" : tagId ? `/api/review/queue?tag_id=${encodeURIComponent(tagId)}`
      : rootId ? `/api/review/queue?root=${encodeURIComponent(rootId)}` : "/api/review/queue";

    async function readQueue() {
      if (!alive || inFlight || gated || gradeBusy.current || !dirty) return;
      inFlight = true;
      dirty = false;
      const readingRevision = revision;
      controller = new AbortController();
      setChecking(true);
      try {
        const result = await reads.modules.review.queue<{ cards: Card[]; total: number }>(url, controller.signal);
        if (!alive || readingRevision !== revision || gated) return;
        const available = new Map(result.cards.filter(card => !completed.has(cardKey(card))).map(card => [cardKey(card), card]));
        remainingIds = remainingIds === null ? [...available.keys()] : remainingIds.filter(id => available.has(id));
        setCards(remainingIds.map(id => available.get(id)!));
        queueReadable.current = true;
        setQueueChecked(true);
        setQueueError(null);
      } catch (e) {
        if (!alive || readingRevision !== revision || gated) return;
        // Never fall back to an old body after a refused/failed authority read.
        // Keep only session IDs, so a later retry can recover its place.
        setCards([]);
        setQueueError(writeErrors.requestMessage(e, t("Could not load the review queue")));
      } finally {
        inFlight = false;
        controller = null;
        if (alive) {
          setChecking(false);
          if (dirty) void readQueue();
        }
      }
    }

    function invalidate() {
      revision += 1;
      dirty = true;
      queueReadable.current = false;
      setQueueChecked(false);
      setQueueError(null);
      if (gated) controller?.abort();
      void readQueue();
    }
    queue.current = {
      invalidate,
      resume: () => { if (dirty) void readQueue(); },
      remove: id => {
        completed.add(id);
        remainingIds = remainingIds?.filter(candidate => candidate !== id) ?? null;
        setCards(previous => previous?.filter(card => cardKey(card) !== id) ?? previous);
      },
      // An undone grade puts the card back at the front of this session; the
      // queue re-reads, so it shows only while the server still offers it.
      restore: id => {
        completed.delete(id);
        remainingIds = remainingIds === null ? null : [id, ...remainingIds.filter(candidate => candidate !== id)];
        invalidate();
      },
    };
    // Subscribe directly as well as selecting the display gate: a true→false
    // pair batched into one React render must still retire the pending read.
    const unsubscribeStore = subscribeApp(() => {
      const next = getAppState().membershipGated;
      if (next !== gated) { gated = next; invalidate(); }
    });
    // A change or a permission change re-reads the queue; so does a reopened
    // stream, and a 60s poll while it is down (lib/liveInvalidation.ts).
    const unregisterChanged = register("changed", invalidate, { pollMs: 60_000 });
    const unregisterMembership = register("membership", invalidate);
    void readQueue();
    return () => {
      alive = false;
      revision += 1;
      controller?.abort();
      unsubscribeStore(); unregisterChanged(); unregisterMembership();
      queue.current = null;
    };
  }, [rootId, tagId, untagged]);

  const previousOnline = useRef(online);
  useEffect(() => {
    if (online && !previousOnline.current) queue.current?.invalidate();
    previousOnline.current = online;
  }, [online]);

  const candidate = queueChecked && !membershipGated ? cards?.[0] ?? null : null;
  // A lost grade response may have moved that card out of the queue already.
  // Confirm its original intent without retaining the old title/body, and do
  // not let the next card receive that pending rating/key.
  const current = attempt.current && (candidate ? cardKey(candidate) : undefined) !== attempt.current.nodeId ? null : candidate;
  const confirmWithoutCard = uncertainRating !== null && !current && !membershipGated;

  // Revalidation temporarily hides the card; it must not discard recall state
  // when the server still returns the same card. A changed/excluded card or a
  // failed queue read changes the held ID and greets the next card front-side-up.
  const heldCardId = cards?.[0] ? cardKey(cards[0]) : undefined;
  useEffect(() => { setRevealed(false); }, [heldCardId]);
  useEffect(() => { if (revealed) { setNotice(null); setPutAsideKey(null); } }, [revealed]);

  const grade = useCallback(async (rating: Rating) => {
    if (gradeBusy.current || !online || getAppState().membershipGated) return;
    const pending = attempt.current;
    if (pending && pending.rating !== rating) return;
    if (!pending && (!current || !queueReadable.current || !revealed)) return;
    const selected = pending ?? { nodeId: cardKey(current!), rating, key: randomUUID(), seenReps: current!.state?.reps ?? 0 };
    attempt.current = selected;
    gradeBusy.current = true;
    setBusy(true);
    setError(null);
    try {
      const graded = await sendWrite<Partial<ReviewGradeResult>>("POST", `${cardPath(selected.nodeId)}/grade`, { rating, seen_reps: selected.seenReps } satisfies ReviewGradeRequest, selected.key);
      // A 200 {deduped:true} also confirms that the original grade committed.
      attempt.current = null;
      setUncertainRating(null);
      queue.current?.remove(selected.nodeId);
      undoAttempt.current = null; // a new grade: any earlier undo attempt is moot
      lastGradedReps.current = selected.seenReps + 1;
      lastGradedId.current = graded?.grade_id;
      setLastGraded(selected.nodeId);
      setDone((n) => n + 1);
      onGraded?.();
    } catch (e) {
      const kind = writeErrors.classify(e);
      if (kind === "retryable" || kind === "authentication") {
        setUncertainRating(rating);
        setError(t("Could not confirm this grade. Retry the same button to finish."));
        // A grade is personal progress and emits no live event, so recheck
        // the queue here: a grade that did commit retires its card, while the
        // unconfirmed intent stays retryable with the same key.
        queue.current?.invalidate();
      } else {
        attempt.current = null;
        setUncertainRating(null);
        // 409: the card changed on another device (stopped there, or graded there first).
        setError(e instanceof ApiError && e.status === 409 ? t("This card changed on another device, so it was not graded.") : writeErrors.message(e));
        queue.current?.invalidate();
      }
    } finally {
      gradeBusy.current = false;
      setBusy(false);
      queue.current?.resume();
    }
  }, [current, online, revealed, onGraded]);

  const undoLastGrade = useCallback(async () => {
    const nodeId = lastGraded;
    if (!nodeId || gradeBusy.current || !online) return;
    const retrying = undoAttempt.current?.nodeId === nodeId;
    const attemptKey = retrying ? undoAttempt.current! : { nodeId, key: randomUUID() };
    undoAttempt.current = attemptKey;
    gradeBusy.current = true;
    setBusy(true);
    setError(null);
    const undone = () => {
      undoAttempt.current = null;
      setLastGraded(null);
      setDone((n) => Math.max(0, n - 1));
      setRevealed(false);
      queue.current?.restore(nodeId);
      onGraded?.();
    };
    try {
      await sendWrite("POST", `${cardPath(nodeId)}/undo-grade`, { graded_reps: lastGradedReps.current, ...(lastGradedId.current ? { graded_id: lastGradedId.current } : {}) } satisfies ReviewUndoRequest, attemptKey.key);
      undone();
    } catch (e) {
      // Retrying an unconfirmed undo: "nothing to undo" (409, answered before
      // the key is claimed) means the first attempt already stepped it back.
      if (retrying && e instanceof ApiError && e.status === 409) { undone(); return; }
      const kind = writeErrors.classify(e);
      if (kind === "retryable" || kind === "authentication") {
        // It may have landed: keep the key, so trying again finishes it once.
        setError(t("Could not confirm the undo. Try again to finish."));
      } else {
        undoAttempt.current = null;
        if (e instanceof ApiError && e.status === 409) {
          // Graded again elsewhere (or nothing left to undo): keep that grade, offer no further undo, refresh the queue.
          setLastGraded(null);
          setError(t("This card was graded again elsewhere, so it was not undone."));
          queue.current?.invalidate();
        } else setError(writeErrors.message(e));
      }
    } finally {
      gradeBusy.current = false;
      setBusy(false);
      queue.current?.resume();
    }
  }, [lastGraded, online, onGraded]);

  // "Tomorrow" and "stop reviewing": no grade, so the schedule is untouched; the
  // card leaves this session either way. Repeating either request is harmless,
  // so a failure that may have landed just offers the same button again.
  const [notice, setNotice] = useState<string | null>(null);
  // The card just put off or stopped, until taken back or the next one is shown.
  const [putAsideKey, setPutAsideKey] = useState<string | null>(null);
  const putAside = useCallback(async (action: "tomorrow" | "suspend") => {
    if (!current || gradeBusy.current || !online || membershipGated || attempt.current) return;
    const key = cardKey(current);
    gradeBusy.current = true;
    setBusy(true);
    setError(null);
    try {
      await sendWrite("POST", `${cardPath(key)}/${action}`, {}, randomUUID());
      queue.current?.remove(key);
      setPutAsideKey(key);
      setNotice(t(action === "tomorrow" ? "Put off until tomorrow." : "Stopped. You can bring it back from Review status."));
      onGraded?.();
    } catch (e) {
      setError(writeErrors.message(e));
    } finally {
      gradeBusy.current = false;
      setBusy(false);
      queue.current?.resume();
    }
  }, [current, online, membershipGated, onGraded]);

  // Taking it back: the same resume that clears any hold; the card returns to the front.
  const takeBack = useCallback(async () => {
    const key = putAsideKey;
    if (!key || gradeBusy.current || !online) return;
    gradeBusy.current = true;
    setBusy(true);
    setError(null);
    try {
      await sendWrite("POST", `${cardPath(key)}/resume`, {}, randomUUID());
      setPutAsideKey(null);
      setNotice(null);
      queue.current?.restore(key);
      onGraded?.();
    } catch (e) {
      setError(writeErrors.message(e));
    } finally {
      gradeBusy.current = false;
      setBusy(false);
      queue.current?.resume();
    }
  }, [putAsideKey, online, onGraded]);

  const openSource = useCallback((card: Card) => {
    if (card.block) revealBlockInNote(card.node_id, card.block.ref);
    onOpenNode(card.node_id);
    onClose?.();
  }, [onOpenNode, onClose]);

  // Keyboard: Space/Enter reveals the back; 1–4 grades — but only once the
  // answer is showing (ignores keystrokes aimed at inputs).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!current || !queueReadable.current || getAppState().membershipGated) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!revealed) {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          setRevealed(true);
        }
        return;
      }
      if (e.key >= "1" && e.key <= "4") {
        e.preventDefault();
        void grade(Number(e.key) as 1 | 2 | 3 | 4);
      }
    };
    return onWindow("keydown", handler);
  }, [current, revealed, grade]);

  const remaining = queueChecked && !membershipGated ? cards?.length ?? 0 : 0;
  return (
    <div className="review-panel">
      <PanelHeader icon={<GraduationCap size={16} />} title={t("Review")} onClose={onClose}>
        {cards !== null && remaining > 0 && (
          <span className="review-count">{t("{n} left", { n: remaining })}</span>
        )}
        {onOpenStatus && <Button type="button" variant="ghost" size="sm" className="review-status-link" onClick={onOpenStatus}>{t("Review status")}</Button>}
      </PanelHeader>
      {queueChecked && !membershipGated && (rootId || tagId || untagged) && (
        <div className="review-scope-row">
          <p className="review-scope" title={rootId ? t("Reviewing only the cards under this note") : undefined}>
            {untagged ? t("Practising cards with no tag")
              : tagId ? t("Reviewing notes tagged #{name}", { name: displayTitle(tagName) })
              : t("Studying {title}", { title: displayTitle(rootTitle) })}
          </p>
          {onShowAll && <Button type="button" variant="ghost" size="sm" onClick={onShowAll}>{t("All cards")}</Button>}
        </div>
      )}
      {rootId && !membershipGated && (
        <StoppedInNote rootId={rootId} online={online} onOpenNode={onOpenNode} onResumed={(key) => { queue.current?.restore(key); onGraded?.(); }} />
      )}

      {queueChecked && !membershipGated && !tagId && !untagged && typeof stats?.new_available === "number" && stats.new_available > 0 && (
        <p className="review-budget" title={t("New cards are introduced gradually so reviews stay manageable")}>{t("{n} new cards available today", { n: stats.new_available })}</p>
      )}

      {lastGraded && (
        <Button type="button" variant="ghost" className="review-undo" disabled={busy || !online} onClick={() => void undoLastGrade()}>
          {t("Undo last grade")}
        </Button>
      )}
      {error && <p className="review-error">{error}</p>}
      {queueError && <p className="review-error">{queueError}</p>}
      {notice && (
        <p className="review-notice" role="status">
          {notice}
          {putAsideKey && <Button type="button" variant="ghost" size="sm" disabled={busy || !online} onClick={() => void takeBack()}>{t("Bring it back")}</Button>}
        </p>
      )}

      {confirmWithoutCard ? (
        <div className="review-empty">
          <Pressable className={`review-grade review-grade--${uncertainRating}`} disabled={busy || !online}
            onClick={() => void grade(uncertainRating!)}>
            {t(GRADES.find(grade => grade.rating === uncertainRating)!.label)}
          </Pressable>
        </div>
      ) : membershipGated || !queueChecked || cards === null ? (
        queueError && !checking && !membershipGated ? <div className="review-empty">
          <Button variant="ghost" onClick={() => queue.current?.invalidate()}>{t("Check again")}</Button>
        </div> :
        <EmptyState size="inline" title={t("Loading…")} />
      ) : current ? (
        <div className="review-card">
          <div className="review-card-head">
            {/* A paragraph card's front is note text (code, bold, math), drawn like the back; a whole note shows its title. */}
            {current.block
              ? <div className="review-card-title review-card-front"><ReviewCard>{current.title}</ReviewCard></div>
              : <span className="review-card-title">{displayTitle(current.title)}</span>}
            {!revealed && (
              <Pressable className="review-open-note" title={t("Open the note")} onClick={() => openSource(current)}>
                <ExternalLink size={12} /> {t("Open")}
              </Pressable>
            )}
          </div>
          {revealed ? (
            <>
              <div className="review-card-body">
                {/* Full-note read surface: learning notes are exactly where
                    math/diagrams/callouts live — renderer parity matters here.
                    A handwritten card carries no markdown body, so when the note
                    is empty fall back to a static thumbnail of its ink strokes —
                    otherwise a #review ink note would render a blank card. */}
                {(() => {
                  if (current.markdown && current.markdown.trim()) {
                    return <ReviewCard>{current.markdown}</ReviewCard>;
                  }
                  const ink = decodeInk(current.ink_data);
                  const svg = inkThumbnailSvg(ink.kind === "page" ? ink.doc : null);
                  if (svg) {
                    return (
                      <div
                        className="review-ink-thumb"
                        role="img"
                        aria-label={t("Handwritten note")}
                        dangerouslySetInnerHTML={{ __html: svg }}
                      />
                    );
                  }
                  // A one-line block card has no back: it only asks you to recall it.
                  if (current.block) return <p className="review-recall-hint">{t("No answer written under this card.")}</p>;
                  return <ReviewCard>{`*${t("This note is empty.")}*`}</ReviewCard>;
                })()}
              </div>
              <ReviewContextBlock context={current.context} paragraph={!!current.block} />
              <ReviewActions
                paragraph={!!current.block} online={online} busy={busy}
                onOpen={() => openSource(current)} onEdit={() => setEditing(true)}
                onTomorrow={() => void putAside("tomorrow")} onStop={() => void putAside("suspend")}
              />
              <div className="review-grades">
                {GRADES.map((g) => (
                  <Pressable
                    key={g.rating}
                    className={`review-grade review-grade--${g.rating}`}
                    disabled={busy || !online || (uncertainRating !== null && uncertainRating !== g.rating)}
                    onClick={() => void grade(g.rating)}
                  >
                    <span className="review-grade-name">{t(g.label)}{hasKeyboard && <kbd>{g.rating}</kbd>}</span>
                    {/* An older server sends no intervals: the buttons then carry only their names. */}
                    {current.next_days?.[g.rating] !== undefined && <span className="review-grade-next">{intervalLabel(current.next_days[g.rating])}</span>}
                  </Pressable>
                ))}
              </div>
            </>
          ) : (
            <div className="review-card-prompt">
              {/* The back stays hidden until you recall, then reveal it. */}
              <p className="review-recall-hint">{t(current.block ? "Try to recall the answer, then reveal it." : "Try to recall this note, then reveal it.")}</p>
              <Pressable className="review-reveal" onClick={() => setRevealed(true)}>
                {t("Show answer")}
                {hasKeyboard && <kbd>{t("Space")}</kbd>}
              </Pressable>
            </div>
          )}
        </div>
      ) : (
        <div className="review-empty">
          {done > 0 ? (
            <p className="review-done">{t("Done — {n} reviewed. See you next time.", { n: done })}</p>
          ) : untagged ? (
            <p>{t("Nothing to review in cards with no tag right now.")}</p>
          ) : tagId ? (
            <p>{t("Nothing to review with this tag right now.")}</p>
          ) : rootId ? (
            <p>{t("Nothing to review under this note right now.")}</p>
          ) : (
            <p>{t("Nothing to review right now. On a paragraph, choose “Make this block a review card” to add one.")}</p>
          )}
        </div>
      )}
      {editing && current && (
        <Suspense fallback={null}>
          <ReviewEditSheet
            nodeId={current.node_id} noteTitle={current.context.source_title ?? current.title} blockRef={current.block?.ref ?? null}
            online={online}
            onClose={() => { setEditing(false); queue.current?.invalidate(); }}
            onOpenSource={() => openSource(current)}
          />
        </Suspense>
      )}
    </div>
  );
}
