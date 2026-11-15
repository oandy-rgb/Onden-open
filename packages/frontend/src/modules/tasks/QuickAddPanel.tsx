// Quick-add task, the content: type one line, see what it will become, press Enter.
//
// "明天下午3點 交報告 #學校" → title 交報告, tomorrow 15:00, tag 學校. The reading
// (packages/markdown taskParse) is shown as chips under the box; tapping a chip takes that
// reading back and its words return to the title. A piece that looked like a date or time but was not
// understood is pointed at ("這段沒看懂") and must be rewritten or kept in the title on purpose.
// Typing # or @ lists tags / notes (quickAddSuggest). With two or more writable spaces a 「放在」 row names
// the space (and, optionally, a note in it).
//
// Two homes draw this panel: QuickAddSheet (anywhere, Enter adds and the box clears for the next one) and
// the 日子 timeline's slot (modules/daily TimelinePlanner: given `slot`, it adds the length and clock
// of the slot and the existing tasks that can go there, and one add closes it). Nothing here decides how
// the task is stored: createQuickTask does (and scheduleTaskAt, via `onSchedule`, for an existing one).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Lock, Users, X } from "lucide-react";
import { parseTaskInput, type TaskSpanKind } from "@onden/markdown/task-parse";
import { addToast, useNode, useOnline, useSelectedId, useTaskRows, useAllNodes } from "../../lib/appStore";
import { useCapabilities } from "../../lib/capabilities";
import { newNotePlaceGroups, type PlaceChoice } from "../../lib/placeGroups";
import { spaceLabel, useSpaces } from "../../lib/spaces";
import { PlacePicker } from "../../components/PlacePicker";
import { defaultTaskSpace, lastTaskSpaceId, rememberTaskSpace } from "./quickAddPlace";
import { writeErrors } from "../../lib/data";
import { getLocale, t } from "../../lib/i18n";
import { isEnterKey, isEscapeKey, isImeComposing } from "../../lib/keys";
import { dayAndClock } from "../../lib/localDate";
import { Button, Pressable, SheetHeader, TextField, useInlinePopover } from "../../components/ui";
import { SnippetText } from "../../components/SnippetText";
import { stepActive } from "../../lib/listNav";
import { noteNamed } from "../../lib/noteNamed";
import { createQuickTask, type QuickTaskSaved } from "./createQuickTask";
import type { QuickAddTarget } from "./openQuickAddTask";
import { placementLabel, quickTaskFromReading, quickTaskInSlot, readMention, readingChips, slotWithReading, doubtfulRanges, dayLabel, type SlotStart } from "./quickAddTask";
import { applySuggestion, mentionWord, suggestToken, SuggestList, useSuggestItems, type SuggestItem } from "./quickAddSuggest";
import { SlotTaskList, SlotTimeFields, type SlotTimes } from "./QuickAddSlot";
import { tasksForSlot, type SlotTaskChoice } from "./slotTasks";
import { formatLineTime } from "@onden/markdown";
import "./QuickAddTask.css";
import { displayTitle } from "../../lib/noteLabel";

type Added = { id: number; title: string; place: string; saved: QuickTaskSaved };
/** The words that name a note the task was asked to go into, and that no note answers to. */
type Missing = { name: string };
type Ignored = { kind: TaskSpanKind | "doubtful"; text: string };

/** What the person picked in 「放在」: a space, and a note in it (null = the space's default note). */
type Picked = { spaceId: string; note: { id: string; title: string } | null };

export type QuickAddPanelProps = {
  into?: QuickAddTarget | null;
  /** In a timeline slot: its day, start and end. The task starts there unless the words say otherwise. */
  slot?: SlotStart;
  /** A day the task starts on unless the words name another ("明天"); left out, the words alone decide (a day of 今天 on a page that shows one). */
  day?: string;
  /** Slot only: plans an existing task into the slot (with its 復原); true when it was written. */
  onSchedule?: (taskId: string, date: string, times: SlotTimes) => Promise<boolean>;
  /** Slot only: a task was added or planned, so the slot is done. */
  onDone?: () => void;
  onClose: () => void;
  /** Called with true while a request is in flight (the sheet will not close under it). */
  onBusyChange?: (busy: boolean) => void;
};

export default function QuickAddPanel({ into = null, slot, day, onSchedule, onDone, onClose, onBusyChange }: QuickAddPanelProps) {
  const online = useOnline();
  const nodes = useAllNodes();
  const tasks = useTaskRows();
  const openNoteSpaceId = useNode(useSelectedId())?.space_id ?? null;
  const { spaces } = useSpaces(online);
  const caps = useCapabilities(online);
  // 「＋ 任務」 from a note's info panel starts with that note as the place.
  const [picked, setPicked] = useState<Picked | null>(into?.spaceId ? { spaceId: into.spaceId, note: { id: into.id, title: into.title } } : null);
  const [picking, setPicking] = useState(false);
  // Decided once per open: the open note's space is where the person was, not where they are by the second task.
  const startSpace = useMemo(() => defaultTaskSpace(spaces, openNoteSpaceId, lastTaskSpaceId()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spaces]);
  const groups = useMemo(() => newNotePlaceGroups(nodes, spaces, caps), [nodes, spaces, caps]);
  const space = startSpace && (spaces.find((s) => s.id === picked?.spaceId) ?? startSpace);
  const pickedNote = space && picked?.spaceId === space.id ? picked.note : null;
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [mentioned, setMentioned] = useState<{ word: string; note: { id: string; title: string } } | null>(null);
  const [ignored, setIgnored] = useState<Ignored[]>([]);
  const [added, setAdded] = useState<Added[]>([]);
  const [busy, setBusyState] = useState(false);
  const [missing, setMissing] = useState<Missing | null>(null);
  const [slotTimes, setSlotTimes] = useState<SlotTimes | null>(slot ? { time: slot.time, until: slot.until } : null);
  const sending = useRef(false);
  const textNow = useRef(text);
  textNow.current = text;
  const counter = useRef(0);
  const keepAdded = 5; // how many just-added lines stay under the box
  const nextCaret = useRef<number | null>(null);
  const setBusy = (value: boolean) => { setBusyState(value); onBusyChange?.(value); };

  const { today, nowTime } = useMemo(() => {
    return dayAndClock();
    // the clock is read when the text changes: a time that passes while typing is judged at Enter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // "@名稱" says which note the task is written into; the rest is read as usual.
  const mention = useMemo(() => readMention(text), [text]);
  const reading = mention?.rest ?? text;
  const parsed = useMemo(
    () => parseTaskInput(reading, { today, nowTime, locale: getLocale(), ignore: ignored }),
    [reading, today, nowTime, ignored],
  );
  const chips = useMemo(() => readingChips(parsed, reading, today, { inSlot: !!slot }), [parsed, reading, today, slot]);

  // ── the # / @ list ──
  const token = useMemo(() => suggestToken(text, caret), [text, caret]);
  const items = useSuggestItems(token);
  const listOpen = !!token && items.length > 0 && !composing && !dismissed;
  const list = useInlinePopover<HTMLInputElement>({ open: listOpen, onClose: () => setDismissed(true), placement: "bottom-start" });
  const inputRef = list.anchor;
  useEffect(() => { setActive(0); setDismissed(false); }, [token?.trigger, token?.query]);

  const change = (value: string, at = value.length) => {
    setText(value);
    setCaret(at);
    setMissing(null);
    // a taken-back reading is forgotten once its words are no longer in the box
    setIgnored((list) => list.filter((i) => value.includes(i.text)));
    setMentioned((m) => (m && value.includes(`@${m.word}`) ? m : null));
  };

  // After choosing from the list the caret goes behind the inserted word.
  useEffect(() => {
    if (nextCaret.current === null) return;
    inputRef.current?.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = null;
  }, [text, inputRef]);

  const choose = (item: SuggestItem) => {
    if (!token) return;
    const next = applySuggestion(text, token, item);
    nextCaret.current = next.caret;
    change(next.text, next.caret);
    if (item.note) setMentioned({ word: mentionWord(item.note.title), note: item.note });
    inputRef.current?.focus();
  };

  // ── the slot ──
  const slotNow: SlotStart | null = slot && slotTimes ? { date: slot.date, ...slotTimes } : null;
  const placed = slotNow ? slotWithReading(parsed, slotNow) : null;
  const slotTyped = !!slot && parsed.time !== null;
  const existing = useMemo(
    () => (slot ? tasksForSlot(tasks, parsed.title, placed?.date ?? slot.date, today) : []),
    [slot, tasks, parsed.title, placed?.date, today],
  );

  /** The reading with the page's day put in, when the words name no day of their own. */
  const dayReading = (reading: typeof parsed) => {
    // Words that name a day, 「某天」 or 「隨時」 are the person's: the page's day only fills in when none was said.
    const said = reading.when_stated || reading.spans.some((span) => span.kind === "someday" || span.kind === "anytime");
    return day && !slot && !said ? { ...reading, when_date: day, someday: false, anytime: false } : reading;
  };
  const submit = useCallback(async () => {
    if (sending.current || !parsed.title || parsed.doubtful.length > 0) return;
    sending.current = true;
    setBusy(true);
    const submitted = text;
    try {
      // A named note must exist: a task is never sent somewhere else instead.
      // `into` without a space (it could not seed 「放在」) is still where the task goes.
      let note = into && !into.spaceId ? into : null;
      if (mention) {
        // A note chosen from the list is known by its id; typed words are looked up by name.
        note = mentioned && mentioned.word === mention.name ? mentioned.note : await noteNamed(mention.name, () => true);
        if (!note) { setMissing({ name: mention.name }); return; }
      }
      // @ names the note; else the 放在 note, else the chosen space's default note.
      const reading = dayReading(parsed);
      const base = slotNow ? quickTaskInSlot(parsed, slotNow, note ?? pickedNote) : quickTaskFromReading(reading, note ?? pickedNote);
      const { saved, noteTitle } = await createQuickTask({ ...base, ...(space ? { spaceId: space.id } : {}) });
      if (space) rememberTaskSpace(space.id);
      const place = placementLabel(dayReading(parsed), today, noteTitle);
      setAdded((rows) => [{ id: ++counter.current, title: parsed.title, place: space && !note ? `${place} · ${spaceLabel(space)}` : place, saved }, ...rows].slice(0, keepAdded));
      if (slot) { onDone?.(); return; }
      // keep anything typed while the request ran
      if (textNow.current === submitted) { setText(""); setCaret(0); setIgnored([]); setMentioned(null); }
    } catch (e) {
      writeErrors.report(e, addToast);
    } finally {
      sending.current = false;
      setBusy(false);
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, text, today, day, mention, mentioned, pickedNote, space, into, slotNow?.date, slotNow?.time, slotNow?.until]);

  const planExisting = async ({ task }: SlotTaskChoice) => {
    if (!placed || !onSchedule || sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      if (await onSchedule(task.id, placed.date, { time: placed.time, until: placed.until })) onDone?.();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const pickPlace = ({ spaceId, parentId }: PlaceChoice) => {
    const note = parentId ? groups.flatMap((g) => g.entries).find((e) => e.parentId === parentId) : null;
    if (spaceId) setPicked({ spaceId, note: note ? { id: note.parentId, title: note.title } : null });
    setPicking(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return;
    if (listOpen) {
      const next = stepActive(event.key, active, items.length);
      if (next !== null) { event.preventDefault(); setActive(next); return; }
      if (isEnterKey(event) || event.key === "Tab") { event.preventDefault(); choose(items[Math.min(active, items.length - 1)]!); return; }
      if (isEscapeKey(event)) { event.preventDefault(); event.stopPropagation(); setDismissed(true); return; }
    }
    if (isEnterKey(event)) { event.preventDefault(); void submit(); }
  };

  if (picking && space) {
    return (
      <>
        <SheetHeader title={t("Put it in…")} onClose={() => setPicking(false)} />
        <PlacePicker groups={groups} current={{ spaceId: space.id, parentId: pickedNote?.id ?? null }} currentMark="chosen"
          searchLabel={t("Search places…")} topLabel={t("Default place for tasks")} onPick={pickPlace} onClose={() => setPicking(false)} />
        <Button onClick={() => setPicking(false)}>{t("Back")}</Button>
      </>
    );
  }

  return (
    <>
      <SheetHeader title={slot ? t("Plan a time") : t("Add a task")} onClose={onClose} />

      {day && !slot && !parsed.when_stated && <p className="quick-add-slot-when">{dayLabel(day, today)}</p>}
      {placed && <p className="quick-add-slot-when">{dayLabel(placed.date, today)} · {formatLineTime(placed.time, placed.until)}</p>}

      <div className="quick-add-row">
        <TextField
          ref={inputRef}
          className="quick-add-input"
          type="text"
          value={text}
          autoFocus
          onChange={(e) => change(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(e) => { setComposing(false); setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length); }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={listOpen}
          aria-controls={listOpen ? "quick-add-suggest" : undefined}
          aria-autocomplete="list"
          placeholder={slot ? t("What will you do?") : t("e.g. Tomorrow 3pm hand in the report #school")}
          aria-label={t("Task")}
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="sentences"
        />
        <Button variant="primary" className="quick-add-submit" disabled={!parsed.title || parsed.doubtful.length > 0 || busy} onClick={() => void submit()}>{t("Add it")}</Button>
      </div>
      {listOpen && <SuggestList anchorState={list} items={items} active={Math.min(active, items.length - 1)} onChoose={choose} />}

      {slot && slotTimes && <SlotTimeFields times={slotTimes} disabled={slotTyped || busy} onChange={setSlotTimes} />}
      {slotTyped && placed && <p className="quick-add-hint">{t("The time you typed replaces the slot: {time}", { time: formatLineTime(placed.time, placed.until) })}</p>}

      {space && (
        <Button className="quick-add-place" disabled={busy || !!mention} onClick={() => setPicking(true)}
          title={mention ? t("The note after @ decides where it goes") : undefined}>
          <span className="quick-add-place-label">{t("Put it in")}</span>
          <span className="quick-add-place-name">
            {space.kind === "personal" ? <Lock size={13} aria-hidden="true" /> : <Users size={13} aria-hidden="true" />}
            {spaceLabel(space)}{pickedNote ? <> › <span className="quick-add-place-note">{displayTitle(pickedNote.title)}</span></> : null}
          </span>
          <ChevronRight size={14} aria-hidden="true" />
        </Button>
      )}

      {text.trim() && (
        <section className="quick-add-preview" aria-label={t("It will become")}>
          <span className="quick-add-preview-label">{t("It will become")}</span>
          <p className={parsed.title ? "quick-add-preview-title" : "quick-add-preview-title is-empty"}>
            <SnippetText snippet={{ text: displayTitle(parsed.title), ranges: parsed.title ? doubtfulRanges(parsed.title, parsed.doubtful) : [] }} markClassName="quick-add-doubt-mark" />
          </p>
          <ul className="quick-add-chips">
            {mention && <li><span className="quick-add-chip">{t("Write into {note}", { note: mention.name })}</span></li>}
            {slot && !slotTyped && placed && <li><span className="quick-add-chip">{formatLineTime(placed.time, placed.until)}</span></li>}
            {chips.map((chip) => (
              <li key={chip.key}>
                {chip.ignore ? (
                  <Pressable
                    type="button"
                    className="quick-add-chip is-removable"
                    aria-label={t("Take back “{reading}”", { reading: chip.label })}
                    onClick={() => { const ig = chip.ignore!; setIgnored((rows) => [...rows, ig]); inputRef.current?.focus(); }}
                  >
                    {chip.label}<X size={12} aria-hidden="true" />
                  </Pressable>
                ) : (
                  <span className="quick-add-chip">{chip.label}</span>
                )}
              </li>
            ))}
          </ul>
          {parsed.doubtful.map((piece) => (
            <p key={`${piece.start}:${piece.text}`} className="quick-add-doubt" role="alert">
              <span>{t("Didn't understand this part: “{piece}”. Rewrite it, or keep it in the title.", { piece: piece.text })}</span>
              <Button size="sm" onClick={() => { setIgnored((rows) => [...rows, { kind: "doubtful", text: piece.text }]); inputRef.current?.focus(); }}>{t("Keep in title")}</Button>
            </p>
          ))}
        </section>
      )}
      {missing && <p className="quick-add-hint" role="alert">{t("No note called “{name}”. Check the name after @, or take it out to use today's diary.", { name: missing.name })}</p>}
      {!text.trim() && <p className="quick-add-hint">{t("Try: tomorrow 3pm · every week · by Friday · #tag · @note")}</p>}

      {slot && <SlotTaskList choices={existing} today={today} typed={!!parsed.title.trim()} busy={busy} onPick={(choice) => void planExisting(choice)} />}

      {added.length > 0 && (
        <ul className="quick-add-added" aria-live="polite" aria-label={t("Just added")}>
          {added.map((a) => (
            <li key={a.id}>
              <span className="quick-add-added-title">{a.title}</span>
              <span className="quick-add-added-place">
                {a.saved === "saved" ? t("Added to {place}", { place: a.place }) : `${writeErrors.queuedMessage()} · ${a.place}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
