// The cycle's screens and rows (focus → break → focus …; the rules are lib/focus/focusCycle.ts):
//   CycleRow          the 週期 row of the start sheet
//   BreakBody         what a break shows (phone sheet and desktop full screen share it)
//   AfterBreakSheet   「休息結束」: the next round never starts by itself
// Ending the pending record and beginning the next round are two writes (lib/focus beginNextRound);
// a failure keeps the person where they were and says why.

import { useRef, useState } from "react";
import { Button, FieldError, Sheet, TextField } from "../../../components/ui";
import { addToast } from "../../../lib/appStore";
import { useT, tn } from "../../../lib/i18n";
import { writeErrors } from "../../../lib/data";
import { classNames } from "../../../lib/utils";
import { isEnterKey } from "../../../lib/keys";
import {
  LONG_BREAK_MINUTES, MAX_REST_MINUTES, beginNextRound, breakAfter, breakRemainingMs, endRunHere, focusLengthLabel,
  formatFocusClock, parseFocusCycle, runSummary, type FocusCycleSetting, type FocusRun, breakTitle, focusCycleLabel } from "../../../lib/focus";

import { ChoiceRow } from "../ChoiceRow";
import "./focus.css";

/** The break a run is in (or just was), and how much of it is left (negative once over). */
export function breakInfo(run: FocusRun, nowMs: number) {
  const next = breakAfter(run.round, run.cycle);
  return { ...next, title: breakTitle(next.kind), leftMs: run.restStartedAt ? breakRemainingMs(run.restStartedAt, next.minutes, nowMs) : 0 };
}

/** The rounds done in a run that stands at its pending record (breaks are not in the minutes). */
export const pendingRunSummary = (run: FocusRun, roundMinutes: number) => runSummary(run.finishedMinutes, roundMinutes);

/** 「開始第 N 輪」 / 「跳過休息」 with its busy flag and reason. */
function useNextRound(showFailureInline: boolean) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function go() {
    setBusy(true); setFailure(null);
    try { await beginNextRound(); }
    catch (error) { const message = writeErrors.message(error); if (showFailureInline) setFailure(message); else addToast(message, "error"); }
    finally { setBusy(false); }
  }
  return { busy, failure, go };
}

/** The break itself: its name, the round just done, the countdown and the two ways on. */
export function BreakBody({ run, now, bigClass }: { run: FocusRun; now: number; bigClass?: string }) {
  const t = useT();
  const info = breakInfo(run, now);
  const next = useNextRound(false);
  return (
    <>
      <p className="focus-what">{info.title}</p>
      <p className="focus-sub">{t("Round {n} is done", { n: run.round })}</p>
      <p className={classNames("focus-big", bigClass)} aria-live="off">{formatFocusClock(Math.max(0, info.leftMs), "up")}</p>
      <p className="focus-sub">{t("Breaks do not count as focus")}</p>
      <div className="focus-actions">
        <Button variant="secondary" disabled={next.busy} onClick={() => endRunHere()}>{t("That's it for today")}</Button>
        <Button variant="primary" disabled={next.busy} onClick={() => void next.go()}>{t("Skip the break")}</Button>
      </div>
    </>
  );
}

/** The break is over: go on, or stop. Nothing starts until the person says so. */
export function AfterBreakSheet({ run, roundMinutes }: { run: FocusRun; roundMinutes: number }) {
  const t = useT();
  const next = useNextRound(true);
  const go = useRef<HTMLButtonElement>(null);
  const done = run.recordEnded ? runSummary(run.finishedMinutes, null) : pendingRunSummary(run, roundMinutes);
  return (
    <Sheet label={t("Break is over")} cardClassName="focus-sheet focus-sheet--break" busy={next.busy} onClose={() => { /* only the two answers close it */ }} initialFocus={go}>
      <h2 className="focus-heading">{t("Break is over")}</h2>
      <p className="focus-sub">
        {tn("You have done {n} round, {m} min focused in all. The next round will not start by itself.",
          "You have done {n} rounds, {m} min focused in all. The next round will not start by itself.", done.rounds, { m: done.minutes })}
      </p>
      {next.failure && <FieldError>{next.failure}</FieldError>}
      <div className="focus-actions">
        <Button variant="secondary" disabled={next.busy} onClick={() => endRunHere()}>{t("That's it for today")}</Button>
        <Button ref={go} variant="primary" disabled={next.busy} onClick={() => void next.go()}>{t("Start round {n}", { n: run.round + 1 })}</Button>
      </div>
    </Sheet>
  );
}

const REST_CHOICES = [5, 10] as const;
const LONG_EVERY_CHOICES = [4, 3] as const;
type RowId = "cycle";

/** The start sheet's 週期 row: off (「不循環」) or focus and break in turn, with the break's length and when a long one comes. */
export function CycleRow({ value, onChange }: { value: FocusCycleSetting | null; onChange: (next: FocusCycleSetting | null) => void }) {
  const t = useT();
  const [open, setOpen] = useState<RowId | null>(null);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const set = (patch: Partial<FocusCycleSetting>) => { if (value) onChange({ ...value, ...patch }); };
  const choice = (on: boolean, label: string, onClick: () => void) => (
    <Button role="radio" aria-checked={on} variant={on ? "primary" : "secondary"} onClick={onClick}>{label}</Button>
  );
  const typedRest = parseFocusCycle({ rest: Number(typed), longEvery: 0 })?.rest ?? null;
  return (
    <ChoiceRow label={t("Cycle")} value={value ? focusCycleLabel(value) : null} unset={t("No cycle")} open={open === "cycle"} onToggle={() => setOpen(open ? null : "cycle")}>
      <div role="radiogroup" aria-label={t("Cycle")} className="focus-lengths">
        {choice(!value, t("No cycle"), () => onChange(null))}
        {choice(!!value, t("Focus and break in turn"), () => { if (!value) onChange({ rest: 5, longEvery: 4 }); })}
      </div>
      {value && (
        <>
          <p className="focus-row-label">{t("Break after each round")}</p>
          <div role="radiogroup" aria-label={t("Break after each round")} className="focus-lengths">
            {REST_CHOICES.map((rest) => choice(!typing && value.rest === rest, focusLengthLabel(rest), () => { setTyping(false); set({ rest }); }))}
            {choice(typing, t("Custom…"), () => setTyping(true))}
          </div>
          {typing && (
            <label className="focus-own">{t("How many minutes of break?")}
              <TextField type="number" inputMode="numeric" min={1} max={MAX_REST_MINUTES} value={typed}
                onChange={(e) => { setTyped(e.target.value); const rest = parseFocusCycle({ rest: Number(e.target.value), longEvery: 0 })?.rest; if (rest) set({ rest }); }}
                onKeyDown={(e) => { if (isEnterKey(e)) e.preventDefault(); }} />
              {typed.trim() !== "" && typedRest === null && <FieldError>{t("Between 1 and {n} minutes.", { n: MAX_REST_MINUTES })}</FieldError>}
            </label>
          )}
          <p className="focus-row-label">{t("Long break")}</p>
          <div role="radiogroup" aria-label={t("Long break")} className="focus-lengths">
            {LONG_EVERY_CHOICES.map((every) => choice(value.longEvery === every, t("Every {n} rounds ({long} min)", { n: every, long: LONG_BREAK_MINUTES }), () => set({ longEvery: every })))}
            {choice(value.longEvery === 0, t("No long break"), () => set({ longEvery: 0 }))}
          </div>
        </>
      )}
    </ChoiceRow>
  );
}
