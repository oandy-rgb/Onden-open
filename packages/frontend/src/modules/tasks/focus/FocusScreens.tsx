// Everything the focus timer draws once there is something to show:
//   phone    a bar above the navigation (any page; tap it to open the big clock) and the end step as a bottom sheet
//   desktop  the full screen (big clock beside the task's note); Esc or 「收起」 tucks it into FocusTopMark
// Starting asks the length (or, when one is already running, whether to end it first).
// The end step is 「做了什麼？」. The clock is read off the record's start time and
// the length, so a reload or another device shows the same time.

import { useEffect, useRef, useState } from "react";
import { Coffee, Timer } from "lucide-react";
import { Button, Checkbox, FieldError, Modal, Sheet, TextField } from "../../../components/ui";
import { NotePreview } from "../../../components/markdownSurfaces";
import { addToast, useAllNodes } from "../../../lib/appStore";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { useNowMs } from "../../../hooks/useNowMs";
import { useT } from "../../../lib/i18n";
import { writeErrors } from "../../../lib/data";
import { randomUUID } from "../../../lib/uuid";
import { classNames } from "../../../lib/utils";
import { displayTitle } from "../../../lib/noteLabel";
import {
  MAX_FOCUS_MINUTES, askAfterBreak, beginBreak, beginFocus, breakAfter, endRunHere, runSummary, type FocusCycleSetting, type FocusRun,
   focusLengthChoices, parseFocusMinutes, claimTimeUpPrompt, closeFocusEnding, dismissFocusRequest, endFocusWith, focusBigClock, focusClockText, focusLengthLabel,
  focusMinutesSpent, focusRemainingMs, focusWrittenMessage, openFocusEnding, setFocusExpanded, useFocusMinutes, useFocusState,
  type RunningFocus, breakStartedMessage, focusRoundSub, runSummaryText } from "../../../lib/focus";

import { useFocusTask, type FocusTask } from "./useFocusTask";
import { focusBarParts } from "./focusBarParts";
import FocusEndButton from "./FocusEndButton";
import { focusCyclePref } from "./focusCyclePref";
import { AfterBreakSheet, BreakBody, CycleRow, breakInfo } from "./FocusCycle";
import "./focus.css";
import { useHasKeyboard } from "../../../hooks/useKbdHint";
import { isEnterKey } from "../../../lib/keys";

export default function FocusScreens({ onOpenNote }: { onOpenNote: (id: string) => void }) {
  const t = useT();
  const { running, request, ending, expanded, run: storedRun } = useFocusState();
  const phone = useIsMobile();
  const pref = useFocusMinutes();
  const now = useNowMs(1000);
  const task = useFocusTask(running?.task_id);
  // A run belongs to the record it waits on; a record this device knows of no run for is one focus, counted by the pref.
  const run = storedRun && running && storedRun.recordId === running.id ? storedRun : null;
  const minutes = run?.minutes ?? pref;
  const onBreak = run?.phase === "break";
  const asking = run?.phase === "asking";

  // Time is up: say so lightly and ask 「做了什麼？」; the record is not ended until the person answers.
  const left = running ? focusRemainingMs(running.started_at, minutes, now) : null;
  // In a cycle the break starts by itself instead, and the record stays open until the run is over (lib/focus beginNextRound / endRunHere).
  useEffect(() => {
    if (!running || left === null || left > 0) return;
    if (run) {
      if (run.phase !== "focus" || !claimTimeUpPrompt(running.id)) return;
      const next = breakAfter(run.round, run.cycle);
      addToast(breakStartedMessage(next.kind, next.minutes), "info");
      beginBreak();
      return;
    }
    if (!claimTimeUpPrompt(running.id)) return;
    addToast(t("Time is up. Keep going or write down what you got done."), "info");
    openFocusEnding(new Date(Math.min(Date.now(), Date.parse(running.started_at) + minutes * 60_000)).toISOString());
  }, [running, run, left, minutes, t]);
  // The break ran out: ask, and say so.
  const breakOver = run && onBreak && breakInfo(run, now).leftMs <= 0;
  useEffect(() => {
    if (!run || !breakOver) return;
    addToast(t("Break is over. Start round {n}, or call it a day.", { n: run.round + 1 }), "info");
    askAfterBreak();
  }, [run, breakOver, t]);
  const showFull = expanded && !ending && !asking;

  return (
    <>
      {running && phone && <FocusBar running={running} task={task} minutes={minutes} now={now} run={run} />}
      {running && phone && showFull && <FocusPhoneSheet running={running} task={task} minutes={minutes} now={now} run={run} />}
      {running && !phone && showFull && <FocusFullscreen running={running} task={task} minutes={minutes} now={now} run={run} onOpenNote={onOpenNote} />}
      {run && asking && !ending && !request && <AfterBreakSheet run={run} roundMinutes={minutes} />}
      {request && !ending && (running ? <EndFirstSheet task={task} run={run} /> : <StartSheet taskId={request.taskId} expandOnStart={!phone} />)}
      {running && ending && <EndSheet running={running} task={task} endedAt={ending.endedAt} run={run} />}
    </>
  );
}

type RunningProps = { running: RunningFocus; task: FocusTask | null; minutes: number; now: number; run: FocusRun | null };

/** 「第 N 輪」 while a round runs in a cycle. */
const RoundTag = ({ run }: { run: FocusRun }) => <p className="focus-round">{useT()("Round {n}", { n: run.round })}</p>;

/** The bar above the phone's navigation: what, how much is left, and 結束. */
function FocusBar({ running, task, minutes, now, run }: RunningProps) {
  const t = useT();
  const { rest, what, title, time } = focusBarParts({ startedAt: running.started_at, minutes, now, run, taskTitle: task?.title });
  const Icon = rest ? Coffee : Timer;
  return (
    <div className={classNames("focus-bar", rest && "focus-bar--break")} role="region" aria-label={t("Focus timer")}>
      <Button variant="ghost" className="focus-bar-main" onClick={() => setFocusExpanded(true)}>
        <Icon size={16} aria-hidden="true" />
        <span className="focus-bar-title">{!rest && run ? `${what} · ${t("Round {n}", { n: run.round })}` : title}</span>
        <span className="focus-bar-time">{time}</span>
      </Button>
      <FocusEndButton onBreak={!!rest} />
    </div>
  );
}

/** Tapping the bar: the big clock, with the same 結束. */
function FocusPhoneSheet({ running, task, minutes, now, run }: RunningProps) {
  const t = useT();
  const back = useRef<HTMLButtonElement>(null);
  if (run && run.phase === "break") {
    return (
      <Sheet label={t("Focus timer")} cardClassName="focus-sheet focus-sheet--break" onClose={() => setFocusExpanded(false)} initialFocus={back}>
        <BreakBody run={run} now={now} />
        <Button ref={back} variant="ghost" onClick={() => setFocusExpanded(false)}>{t("Close")}</Button>
      </Sheet>
    );
  }
  return (
    <Sheet label={t("Focus timer")} cardClassName="focus-sheet" onClose={() => setFocusExpanded(false)} initialFocus={back}>
      <p className="focus-what">{task?.title ? displayTitle(task.title) : t("Focusing")}</p>
      {run && <RoundTag run={run} />}
      <p className="focus-big" aria-live="off">{focusBigClock(running.started_at, minutes, now)}</p>
      <p className="focus-sub">{run ? focusRoundSub(minutes, run.round, run.cycle) : focusLengthLabel(minutes)}</p>
      <div className="focus-actions">
        <Button ref={back} variant="secondary" onClick={() => setFocusExpanded(false)}>{t("Back to work")}</Button>
        <Button variant="primary" onClick={() => openFocusEnding()}>{t("End focus")}</Button>
      </div>
    </Sheet>
  );
}

/** Desktop: the big clock in the middle of the screen, the task's note beside it. */
function FocusFullscreen({ running, task, minutes, now, run, onOpenNote }: RunningProps & { onOpenNote: (id: string) => void }) {
  const hasKeyboard = useHasKeyboard();
  const t = useT();
  const nodes = useAllNodes();
  const tuck = useRef<HTMLButtonElement>(null);
  const noteId = task?.noteId ?? null;
  const note = noteId ? nodes.find((node) => node.id === noteId) : undefined;
  return (
    <Modal label={t("Focus timer")} className="focus-full-layer" onClose={() => setFocusExpanded(false)} initialFocus={tuck}>
      <div className={classNames("focus-full", run?.phase === "break" && "focus-full--break")}>
        <div className="focus-full-clock">
          {run && run.phase === "break" ? (
            <>
              <BreakBody run={run} now={now} bigClass="focus-big--full" />
              <Button ref={tuck} variant="ghost" onClick={() => setFocusExpanded(false)}>{hasKeyboard ? `${t("Tuck away")} (Esc)` : t("Tuck away")}</Button>
            </>
          ) : (
            <>
              <p className="focus-what">{task?.title ? displayTitle(task.title) : t("Focusing")}</p>
              {run && <RoundTag run={run} />}
              <p className="focus-big focus-big--full">{focusBigClock(running.started_at, minutes, now)}</p>
              <p className="focus-sub">{focusClockText(running.started_at, minutes, now)} · {run ? focusRoundSub(minutes, run.round, run.cycle) : focusLengthLabel(minutes)}</p>
              <div className="focus-actions">
                <Button ref={tuck} variant="secondary" onClick={() => setFocusExpanded(false)}>{hasKeyboard ? `${t("Tuck away")} (Esc)` : t("Tuck away")}</Button>
                <Button variant="primary" onClick={() => openFocusEnding()}>{t("End focus")}</Button>
              </div>
            </>
          )}
        </div>
        {note && task?.noteText !== null && (
          <aside className="focus-full-note" aria-label={t("The note of this task")}>
            <div className="focus-full-note-head">
              <h2 className="focus-full-note-title">{displayTitle(note.title)}</h2>
              <Button size="sm" variant="ghost" onClick={() => { setFocusExpanded(false); onOpenNote(note.id); }}>{t("Write in the editor")}</Button>
            </div>
            <div className="focus-full-note-body"><NotePreview nodes={nodes} from={note}>{task?.noteText ?? ""}</NotePreview></div>
          </aside>
        )}
      </div>
    </Modal>
  );
}

/** Begin: how long, then go. A refused start keeps the sheet open with the reason. */
function StartSheet({ taskId, expandOnStart }: { taskId: string | null; expandOnStart: boolean }) {
  const t = useT();
  const remembered = useFocusMinutes();
  const [minutes, setMinutes] = useState(remembered);
  // A length of one's own: typed here, kept as the account's length, so it is one of the choices next time.
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  // The cycle on offer: the account's last choice; 「不計時」 has none (it counts up, so nothing ends a round).
  const rememberedCycle = focusCyclePref.useValue().value;
  const [cycle, setCycle] = useState<FocusCycleSetting | null>(rememberedCycle);
  const own = typing ? parseFocusMinutes(Number(typed)) : null;
  const ready = !typing || (own !== null && own > 0 && typed.trim() !== "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const task = useFocusTask(taskId);
  const go = useRef<HTMLButtonElement>(null);

  async function start() {
    setBusy(true); setFailure(null);
    const length = typing && own ? own : minutes;
    const chosen = length > 0 ? cycle : null;
    try {
      if (JSON.stringify(chosen) !== JSON.stringify(rememberedCycle)) focusCyclePref.store.save(chosen);
      await beginFocus(taskId, length, expandOnStart, chosen);
    }
    catch (error) { setFailure(writeErrors.message(error)); }
    finally { setBusy(false); }
  }
  return (
    <Sheet label={t("Start focus")} cardClassName="focus-sheet" busy={busy} onClose={dismissFocusRequest} initialFocus={go}>
      <h2 className="focus-heading">{t("Start focus")}</h2>
      <p className="focus-what">{task?.title ? displayTitle(task.title) : t("Focus on nothing in particular")}</p>
      <div role="radiogroup" aria-label={t("How long?")} className="focus-lengths">
        {focusLengthChoices(remembered).map((length) => {
          const on = !typing && minutes === length;
          return (
            <Button key={length} role="radio" aria-checked={on} variant={on ? "primary" : "secondary"} onClick={() => { setTyping(false); setMinutes(length); if (length === 0) setCycle(null); }}>
              {focusLengthLabel(length)}
            </Button>
          );
        })}
        <Button role="radio" aria-checked={typing} variant={typing ? "primary" : "secondary"} onClick={() => setTyping(true)}>{t("Custom…")}</Button>
      </div>
      {(typing || minutes > 0) && <CycleRow value={cycle} onChange={setCycle} />}
      {typing && (
        <label className="focus-own">{t("How many minutes?")}
          <TextField type="number" inputMode="numeric" min={1} max={MAX_FOCUS_MINUTES} value={typed}
            onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (isEnterKey(e) && ready) { e.preventDefault(); void start(); } }} />
        </label>
      )}
      {failure && <FieldError>{failure}</FieldError>}
      <div className="focus-actions">
        <Button variant="secondary" disabled={busy} onClick={dismissFocusRequest}>{t("Cancel")}</Button>
        <Button ref={go} variant="primary" disabled={busy || !ready} onClick={() => void start()}>{t("Start focus")}</Button>
      </div>
    </Sheet>
  );
}

/** One at a time: a start while another is running asks to end the running one first. */
function EndFirstSheet({ task, run }: { task: FocusTask | null; run: FocusRun | null }) {
  const t = useT();
  const first = useRef<HTMLButtonElement>(null);
  return (
    <Sheet label={t("End the current focus first?")} cardClassName="focus-sheet" onClose={dismissFocusRequest} initialFocus={first}>
      <h2 className="focus-heading">{t("End the current focus first?")}</h2>
      <p className="focus-sub">{t("You are already focusing on {what}. End it first, then start the new one.", { what: task?.title ? `“${displayTitle(task.title)}”` : t("nothing in particular") })}</p>
      <div className="focus-actions">
        <Button ref={first} variant="secondary" onClick={dismissFocusRequest}>{t("Not now")}</Button>
        <Button variant="primary" onClick={() => (run && run.phase !== "focus" ? endRunHere() : openFocusEnding())}>{t("End it first")}</Button>
      </div>
    </Sheet>
  );
}

/** 「做了什麼？」: one line, two places to put it. Nothing closes until the server
 *  or the offline queue has it; a failure keeps what was typed. */
function EndSheet({ running, task, endedAt, run }: { running: RunningFocus; task: FocusTask | null; endedAt: string; run: FocusRun | null }) {
  const t = useT();
  const [note, setNote] = useState("");
  const [toDiary, setToDiary] = useState(true);
  const [toTask, setToTask] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // One key for this sheet: a resend of the same attempt is the same write, a new attempt after a refusal is new.
  const [attemptKey, setAttemptKey] = useState(() => randomUUID());
  const field = useRef<HTMLInputElement>(null);
  const hasTask = !!running.task_id;

  async function finish(withNote: boolean) {
    setBusy(true); setFailure(null);
    const sentence = withNote ? note.trim() : "";
    const asked = { note: sentence !== "", diary: sentence !== "" && toDiary, task: sentence !== "" && toTask && hasTask };
    try {
      const result = await endFocusWith({ note: sentence, toDiary: asked.diary, toTask: asked.task, attemptKey });
      addToast(result.status === "queued" ? writeErrors.queuedMessage() : focusWrittenMessage(asked, result.written), result.status === "queued" ? "info" : "success");
    } catch (error) {
      setFailure(writeErrors.message(error));
      // A refusal is final for this attempt; a lost answer or a dropped connection is resent under the same key.
      if (writeErrors.classify(error) === "rejected") setAttemptKey(randomUUID());
      setBusy(false);
    }
  }
  return (
    <Sheet label={t("What did you get done?")} cardClassName="focus-sheet" busy={busy} onClose={closeFocusEnding} initialFocus={field}>
      <h2 className="focus-heading">{t("What did you get done?")}</h2>
      <p className="focus-sub">
        {task?.title ? `${displayTitle(task.title)} · ` : ""}{run ? runSummaryText(runSummary(run.finishedMinutes, focusMinutesSpent(running.started_at, endedAt)))
          : t("Focused {n} min", { n: focusMinutesSpent(running.started_at, endedAt) })}
      </p>
      <TextField ref={field} value={note} maxLength={500} placeholder={t("One line is enough")} aria-label={t("What did you get done?")} disabled={busy}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && note.trim()) void finish(true); }} />
      <label className="ui-checkbox"><Checkbox checked={toDiary} disabled={busy} onChange={(event) => setToDiary(event.target.checked)} /><span>{t("Write it in today's journal")}</span></label>
      {hasTask && <label className="ui-checkbox"><Checkbox checked={toTask} disabled={busy} onChange={(event) => setToTask(event.target.checked)} /><span>{t("Write it under the task")}</span></label>}
      {failure && <FieldError>{failure}</FieldError>}
      <div className="focus-actions">
        <Button variant="secondary" disabled={busy} onClick={() => void finish(false)}>{t("Skip writing")}</Button>
        <Button variant="primary" disabled={busy} onClick={() => void finish(true)}>{t("Done")}</Button>
      </div>
    </Sheet>
  );
}
