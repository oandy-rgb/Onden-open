import { Suspense, useState, type CSSProperties } from "react";
import { ArrowLeft, GraduationCap } from "lucide-react";
import type { ReviewStatus, ReviewStatusCard } from "@onden/contract";
import { Button, TextField } from "../../components/ui";
import PanelHeader from "../../components/PanelHeader";
import EmptyState from "../../components/EmptyState";
import { sendWrite, writeErrors } from "../../lib/data";
import { addToast } from "../../lib/appStore";
import { tn, useT } from "../../lib/i18n";
import { dayIdLabel } from "../../lib/timeLabels";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { displayTitle } from "../../lib/noteLabel";
import { revealBlockInNote } from "../../lib/noteReveal";
import { randomUUID } from "../../lib/uuid";
import { reviewCapPref } from "./reviewCapPref";
import { cardKey, cardPath } from "./cardKey";
import { useLiveResource } from "./useLiveResource";
import StoppedCards from "./StoppedCards";
import ReviewGroups from "./ReviewGroups";
import { scopeQuery, type ReviewPlace, type ReviewScope } from "./reviewPlace";
import { useScopeName } from "./ReviewScopePicker";
import "./ReviewPanel.css";
import "./ReviewStatusPage.css";

// The review status page: how many cards to review today, the overdue ones
// apart from the week ahead, the cards that keep being forgotten (each with a
// button to edit that paragraph, not to drop it), the ones the person stopped
// (with a way back), and their own daily limit. Every number comes from
// GET /api/review/status; this page only lays them out.

const ReviewEditSheet = lazyWithReload(() => import("./ReviewEditSheet"));

type Props = { online: boolean; scope?: ReviewScope; onBack: () => void; onOpenNode: (id: string) => void; onChanged?: () => void; onPractise?: (place: ReviewPlace) => void };

export default function ReviewStatusPage({ online, scope = { kind: "all" }, onBack, onOpenNode, onChanged, onPractise }: Props) {
  const t = useT();
  const { value: status, refresh } = useLiveResource<ReviewStatus, ReviewStatus | null>(`/api/review/status${scopeQuery(scope)}`, (raw) => raw, null, 60_000);
  const scopeName = useScopeName(scope);
  const [editing, setEditing] = useState<ReviewStatusCard | null>(null);
  const [busy, setBusy] = useState(false);

  async function resume(card: ReviewStatusCard) {
    setBusy(true);
    try {
      await sendWrite("POST", `${cardPath(cardKey(card))}/resume`, {}, randomUUID());
      await refresh();
      onChanged?.();
    } catch (error) {
      writeErrors.report(error, addToast);
    } finally { setBusy(false); }
  }

  const open = (card: ReviewStatusCard) => {
    if (card.block) revealBlockInNote(card.node_id, card.block.ref);
    onOpenNode(card.node_id);
  };

  return (
    <div className="review-panel review-status-panel">
      <PanelHeader icon={<GraduationCap size={16} />} title={t("Review status")}>
        <Button type="button" variant="ghost" size="sm" className="review-status-link" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" /> {t("Back to review")}</Button>
      </PanelHeader>
      {!status ? (
        <EmptyState size="inline" title={online ? t("Loading…") : t("Review status needs a connection.")} />
      ) : (
        <div className="review-status">
          {scope.kind !== "all" && <p className="review-status-note">{t("Counting only: {name}", { name: scopeName })}</p>}
          <section aria-label={t("Today")}>
            <div className="review-status-today">
              <Figure kind="today" value={status.today} label={t("Due today")} />
              <Figure kind="overdue" value={status.overdue} label={t("Overdue")} />
              <Figure kind="new" value={status.new_available} label={t("New today")} />
            </div>
            {status.rolled_over > 0 && (
              <p className="review-status-note">{tn("1 card was moved to tomorrow by your daily limit.", "{n} cards were moved to tomorrow by your daily limit.", status.rolled_over)}</p>
            )}
          </section>

          {onPractise && <ReviewGroups online={online} onPractise={onPractise} />}

          <section aria-label={t("Next seven days")}>
            <h3>{t("Next seven days")}</h3>
            <WeekAhead forecast={status.forecast} />
          </section>

          <DailyLimit key={status.reviews_per_day ?? "none"} status={status} online={online} onSaved={() => { void refresh(); onChanged?.(); }} />

          <section aria-label={t("Often forgotten")}>
            <h3>{t("Often forgotten")}</h3>
            <p className="review-status-note">{t("Cards you have forgotten {n} or more times. Rewriting them usually helps more than seeing them again.", { n: status.forgotten_min })}</p>
            {status.forgotten.length === 0 ? <p className="review-status-note">{t("No card has been forgotten that often.")}</p> : (
              <ul className="review-status-cards">
                {status.forgotten.map((card) => (
                  <li key={cardKey(card)} className="review-status-card">
                    <span className="review-status-card-title">{displayTitle(card.title)}</span>
                    <span className="review-status-card-meta">{tn("Forgotten 1 time", "Forgotten {n} times", card.lapses)}</span>
                    <span className="review-status-card-actions">
                      <Button type="button" variant="ghost" disabled={!online} onClick={() => setEditing(card)}>{t(card.block ? "Edit this paragraph" : "Edit this note")}</Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {status.stopped.length > 0 && (
            <section aria-label={t("Stopped")}>
              <h3>{t("Stopped")}</h3>
              <p className="review-status-note">{t("Cards you stopped reviewing. They stay in their notes.")}</p>
              <StoppedCards cards={status.stopped} online={online} busy={busy} onOpen={open} onResume={(card) => void resume(card)} />
            </section>
          )}
        </div>
      )}
      {editing && (
        <Suspense fallback={null}>
          <ReviewEditSheet
            nodeId={editing.node_id} noteTitle={editing.title} blockRef={editing.block?.ref ?? null} online={online}
            onClose={() => { setEditing(null); void refresh(); }}
            onOpenSource={() => open(editing)}
          />
        </Suspense>
      )}
    </div>
  );
}

function Figure({ kind, value, label }: { kind: "today" | "overdue" | "new"; value: number; label: string }) {
  return (
    <div className="review-status-figure" data-kind={kind} data-zero={value === 0}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function WeekAhead({ forecast }: { forecast: ReviewStatus["forecast"] }) {
  const most = Math.max(1, ...forecast.map((day) => day.count));
  return (
    <ul className="review-status-week">
      {forecast.map((day) => (
        <li key={day.date} className="review-status-day">
          <span className="review-status-day-name">{dayIdLabel(day.date, "weekdayShort")} {dayIdLabel(day.date, "monthDay")}</span>
          <span className="review-status-day-bar" aria-hidden="true"><span style={{ "--share": day.count / most } as CSSProperties} /></span>
          <span className="review-status-day-count">{day.count}</span>
        </li>
      ))}
    </ul>
  );
}

/** The person's own cap on reviews a day: one number for all their cards, kept
 *  with the account so every device they use has the same one. */
function DailyLimit({ status, online, onSaved }: { status: ReviewStatus; online: boolean; onSaved: () => void }) {
  const t = useT();
  const [text, setText] = useState(status.reviews_per_day === null ? "" : String(status.reviews_per_day));
  const [busy, setBusy] = useState(false);
  const value = Math.floor(Number(text));
  const valid = text !== "" && Number.isFinite(value) && value >= 1 && value <= 5000;

  async function save(next: number | null) {
    setBusy(true);
    // Saved only once the server has it: a copy still marked unsent is not saved.
    reviewCapPref.store.save(next);
    await reviewCapPref.store.sync();
    if (reviewCapPref.store.get().dirty) addToast(t("Not saved yet. The limit will be sent when you are back online."), "error");
    else onSaved();
    setBusy(false);
  }

  return (
    <section aria-label={t("Daily limit")}>
      <h3>{t("Daily limit")}</h3>
      <p className="review-status-note">
        {status.reviews_per_day === null ? t("No limit. Every card that is due is offered.")
          : t("{done} of {cap} reviews today. Cards over the limit wait for tomorrow.", { done: status.reviewed_today, cap: status.reviews_per_day })}
      </p>
      <form className="review-status-cap" noValidate onSubmit={(event) => { event.preventDefault(); if (valid) void save(value); }}>
        <TextField type="number" inputMode="numeric" min={1} max={5000} value={text} disabled={busy || !online} aria-label={t("Reviews per day")}
          placeholder={t("No limit")} onChange={(event) => setText(event.target.value)} />
        <Button type="submit" disabled={busy || !online || !valid}>{t("Save limit")}</Button>
        {status.reviews_per_day !== null && <Button type="button" variant="ghost" disabled={busy || !online} onClick={() => void save(null)}>{t("Remove limit")}</Button>}
      </form>
    </section>
  );
}
