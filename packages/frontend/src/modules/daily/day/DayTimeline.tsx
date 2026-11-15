// The day as a vertical timeline in real proportion: an hour is always the same
// height, so a gap between two things stays an empty stretch. Items that start
// at a time sit where they belong (overlaps side by side); a red line marks now.
// Past items are a soft solid, coming ones an outline. The day's edges come from
// dayWindow, so a day that starts at 04:00 or crosses a daylight-saving change
// still lines up.
//
// With `foldEmpty`, two or more empty whole hours in a row (nothing in them, not "now", the hour
// before it or the eight coming up) are one line, 「12:00–16:00 空著 · 展開」 (foldEmptyHours); opening one lasts
// until the day is left. Positions go through foldLayout, so everything that is placed or
// measured (blocks, now, draft, pointer) agrees on where a minute is. A folded stretch is never
// a dead zone: (1) a task dragged over the timeline, or a block being moved or stretched, opens
// every fold for as long as the drag lasts (a block stays where it is on screen), so the drop lands
// on a real hour; (2) a plan slot (once drawn, or made by the ＋ button)
// keeps its own hours open; (3) the fold row itself is a button that opens it. A long press on
// it does not start drawing; drawn or dragged across it, a pointer reads the stretch evenly.

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from "react";
import { Timer } from "lucide-react";
import { Button, Pressable } from "../../../components/ui";
import { requestFocus } from "../../../lib/focus";
import { formatLineTime, layoutDayItems, type DayItem } from "@onden/markdown";
import { useT } from "../../../lib/i18n";
import { clockLabel, dayWindow } from "../../../lib/dayWindow";
import { foldEmptyHours, foldLayout, type BlockSpan, type FoldLayout } from "./foldEmptyHours";
import { classNames } from "../../../lib/utils";
import { itemTimeText, itemTitle } from "./dayItemText";
import { dragCarriesTask, droppedTaskId } from "../../../lib/taskDrag";
import { taskRefById, useTaskRefs } from "../../../lib/taskRefs";
import { slotAt, slotDrawn, type PlacedSlot } from "./timelineSlots";
import { itemSpan } from "./timelineDrag";
import { useBlockDrag } from "./useBlockDrag";
import { useLongPressDraw, type DrawnRange } from "./useLongPressDraw";
import { AllDayStrip, ExternalBlocks } from "./external/ExternalDayParts";
import type { ExternalEvent } from "../../../lib/externalCalendars";

/** Pixels per hour. */
export const HOUR_PX = 56;
// Geometry goes to day.css as custom properties (--top, --h, --lane).
const px = (minutes: number) => (minutes * HOUR_PX) / 60;
/** A folded stretch is one row this tall. */
const FOLD_PX = 36;
/** A block is never drawn shorter than this (day.css), so lanes are decided on it too. */
const MIN_BLOCK_PX = 24;
const MIN_BLOCK_MINUTES = (MIN_BLOCK_PX * 60) / HOUR_PX;
/** The hour label hides when "now" is this close to it (its time pill would cover it). */
const HOUR_LABEL_CLEARANCE_MINUTES = 12;
/** Keep "now" at least this far above the bottom edge while the user has not scrolled. */
const NOW_BOTTOM_MARGIN_PX = 80;


type Props = {
  date: string;
  items: readonly DayItem[];
  nowMs: number;
  onOpen: (item: DayItem) => void;
  /** Scroll to now (or to the first item on another day) when the day opens. */
  autoScroll?: boolean;
  /** Fold empty stretches of two hours or more into one line each. */
  foldEmpty?: boolean;
  /** The focus records (what was really done) go in a narrow lane of their own at the right edge, beside
   *  what was planned and the calendar's events, instead of among them. */
  focusLane?: boolean;
  /** Absent: the timeline only shows. Present: an empty stretch can be tapped (or, on a phone,
   *  held and drawn) to plan something there, and an untimed task can be dropped on an hour. */
  plan?: {
    onSlot: (slot: PlacedSlot) => void;
    /** May return the write: the slot then stays unfolded until it settles. */
    onDropTask: (taskId: string, slot: PlacedSlot) => void | Promise<unknown>;
    /** Absent: planned blocks stay put. Present: a planned, open task the reader may write can be
     *  dragged to another time and its lower edge pulled; called once when the gesture is done. */
    onMoveBlock?: (taskId: string, slot: PlacedSlot) => Promise<unknown>;
  };
  /** A slot being planned: drawn as a block, and the anchor of the input that opened for it. */
  draft?: PlacedSlot | null;
  draftRef?: Ref<HTMLDivElement>;
  /** The day's events from subscribed calendars: shown beside the tasks, never moved. */
  external?: readonly ExternalEvent[];
  onOpenExternal?: (event: ExternalEvent) => void;
};

/** Presses and taps on these are the block's own, not an empty stretch's. */
const BLOCK_SELECTOR = ".day-block, .day-block-focus, .day-block-grip, .ext-block, .day-fold, .day-focus-block";

export default function DayTimeline({ date, items, nowMs, onOpen, autoScroll = true, foldEmpty = false, focusLane = false, plan, draft, draftRef, external = [], onOpenExternal }: Props) {
  const t = useT();
  const window = useMemo(() => dayWindow(date), [date]);
  // In the focus lane the records are laid out on their own (they never overlap each other the way plans do).
  const laneItems = useMemo(() => (focusLane ? items.filter((item) => item.kind === "focus") : []), [focusLane, items]);
  const mainItems = useMemo(() => (focusLane ? items.filter((item) => item.kind !== "focus") : items), [focusLane, items]);
  const { placed } = useMemo(() => layoutDayItems(mainItems, window, undefined, MIN_BLOCK_MINUTES), [mainItems, window]);
  const { placed: lanePlaced } = useMemo(() => layoutDayItems(laneItems, window, undefined, MIN_BLOCK_MINUTES), [laneItems, window]);
  const allDay = useMemo(() => external.filter((e) => e.all_day), [external]);
  const timedExternal = useMemo(() => external.filter((e) => !e.all_day), [external]);
  const openExternal = onOpenExternal ?? (() => {});
  const lengthMinutes = (window.endMs - window.startMs) / 60_000;
  const nowMinutes = (nowMs - window.startMs) / 60_000;
  const showNow = nowMinutes >= 0 && nowMinutes <= lengthMinutes;
  const wholeHours = Math.floor(lengthMinutes / 60);
  const hours = Array.from({ length: wholeHours + 1 }, (_, i) => i);
  // Folding: what is in the way (blocks as drawn, calendar events, the slot being planned), what the reader opened.
  const [openHours, setOpenHours] = useState<ReadonlySet<number>>(new Set());
  const [dragging, setDragging] = useState(false);
  // Slots whose write is not finished: `placed` still has the old time, so their hours are kept open here.
  const [held, setHeld] = useState<readonly PlacedSlot[]>([]);
  const hold = <W extends Promise<unknown> | void>(slot: PlacedSlot, work: W): W => {
    setHeld((list) => [...list, slot]);
    void Promise.resolve(work).catch(() => {}).finally(() => setHeld((list) => list.filter((x) => x !== slot)));
    return work;
  };
  // The minute a drag ends on: the anchor that keeps the dropped block where it is when the folds close again.
  const anchorRef = useRef<number | null>(null);
  const [preview, setPreview] = useState<PlacedSlot | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // Where on the day a pointer is. Read through a ref: a gesture that outlives a render (a block being
  // dragged opens the folds under it) must measure with the layout of the moment, not of its start.
  const layoutRef = useRef<FoldLayout | null>(null);
  const minutesAt = (clientY: number) => layoutRef.current!.minutesAt(clientY - (body.current?.getBoundingClientRect().top ?? 0));
  // Moving and stretching a planned block; what a screen reader hears after a key step.
  const taskRefs = useTaskRefs();
  const [said, setSaid] = useState("");
  const blocks = useBlockDrag({
    day: window, minutesAt, scroller: () => scroller.current,
    commit: (id, slot) => hold(slot, plan?.onMoveBlock?.(id, slot) ?? Promise.resolve(false)),
    onKeyStep: (slot, mode) => setSaid(t(mode === "move" ? "Moved to {time}" : "Length is now {time}", { time: formatLineTime(slot.time, slot.until) })),
  });
  const dragId = blocks.gesture?.id ?? null;
  if (blocks.gesture) anchorRef.current = blocks.gesture.slot.startMinutes;
  // A block being moved or stretched, like a task held over the timeline, has every fold open.
  const unfolded = dragging || dragId !== null;
  const folds = useMemo(() => {
    if (!foldEmpty || unfolded) return [];
    const spans: BlockSpan[] = [...placed, ...lanePlaced].map((p) => ({ startMinutes: p.topMinutes, endMinutes: p.topMinutes + p.heightMinutes }));
    for (const event of timedExternal) {
      const startMinutes = (Date.parse(event.starts_at) - window.startMs) / 60_000;
      spans.push({ startMinutes, endMinutes: Math.max((Date.parse(event.ends_at) - window.startMs) / 60_000, startMinutes + MIN_BLOCK_MINUTES) });
    }
    if (draft) spans.push(draft);
    spans.push(...held);
    return foldEmptyHours(spans, { hours: wholeHours, nowHour: showNow ? Math.floor(nowMinutes / 60) : null, open: openHours });
  }, [foldEmpty, unfolded, placed, lanePlaced, timedExternal, window, draft, held, wholeHours, showNow, nowMinutes, openHours]);
  const layout = useMemo(() => foldLayout(folds, lengthMinutes, HOUR_PX, FOLD_PX), [folds, lengthMinutes]);
  layoutRef.current = layout;
  const y = layout.y;
  // The layout as it was drawn while the folds were shut, to keep a block where it is when they open.
  const shutLayout = useRef(layout);
  if (!unfolded) shutLayout.current = layout;
  const openLayout = useRef(layout);
  if (unfolded) openLayout.current = layout;
  const placedRef = useRef(placed);
  placedRef.current = placed;
  useLayoutEffect(() => {
    const el = scroller.current;
    const top = dragId === null ? undefined : placedRef.current.find((p) => p.item.ref?.id === dragId)?.topMinutes;
    if (!el || top === undefined) return;
    // The browser cuts a scroll short at the end of the content, and with a short box it can be
    // hundreds of px short: the block would then sit below the pointer and jump hours on the first
    // move. So the missing part is made scrollable with padding for as long as the drag lasts.
    const want = el.scrollTop + layoutRef.current!.y(top) - shutLayout.current.y(top);
    el.scrollTop = want;
    const short = want - el.scrollTop;
    if (short > 0) { el.style.paddingBottom = `${short}px`; el.scrollTop = want; }
    anchorRef.current = top; // a drag that ends where it began still keeps the block in place
  }, [dragId]);
  // Folds closing after a drag: the dropped block is the anchor, so what is above it shrinking
  // does not move it. The padding of the drag goes last, once the scroll no longer needs it.
  const wasUnfolded = useRef(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    const was = wasUnfolded.current;
    wasUnfolded.current = unfolded;
    if (unfolded || !was || !el) return;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (anchor !== null) el.scrollTop += layoutRef.current!.y(anchor) - openLayout.current.y(anchor);
    el.style.paddingBottom = "";
  }, [unfolded]);
  const hourTime = (hour: number) => clockLabel(new Date(window.startMs + hour * 3_600_000).toISOString());
  // The day's last line is 24:00, not a second 00:00.
  const foldTime = (hour: number) => { const label = hourTime(hour); return hour > 0 && label === "00:00" ? "24:00" : label; };
  const userScrolled = useRef(false);

  // Only when the day changes: a tick of the clock must not drag the view back.
  const first = placed[0]?.topMinutes;
  useEffect(() => {
    const el = scroller.current;
    if (!autoScroll || !el || typeof el.scrollTo !== "function") return;
    userScrolled.current = false;
    const target = showNow ? nowMinutes : first ?? 0;
    el.scrollTo({ top: Math.max(0, y(target) - 120) });
  }, [date]); // eslint-disable-line react-hooks/exhaustive-deps -- once per day, not per tick

  // The page stays open: when the clock walks "now" out of view, ease it back —
  // unless the user has scrolled themselves (wheel, touch, scrollbar, keys).
  useEffect(() => {
    const el = scroller.current;
    if (!autoScroll || !showNow || userScrolled.current || !el || typeof el.scrollTo !== "function" || el.clientHeight === 0) return;
    if (y(nowMinutes) > el.scrollTop + el.clientHeight - NOW_BOTTOM_MARGIN_PX) {
      el.scrollTo({ top: Math.max(0, y(nowMinutes) - 120), behavior: "smooth" });
    }
  }, [nowMinutes]); // eslint-disable-line react-hooks/exhaustive-deps -- reacts to the clock only
  const markUserScrolled = () => { userScrolled.current = true; };

  // A slot opened from the keyboard button may be off screen: bring it in.
  const draftTop = draft ? y(draft.startMinutes) : null;
  useEffect(() => {
    const el = scroller.current;
    if (draftTop === null || !el || typeof el.scrollTo !== "function" || el.clientHeight === 0) return;
    if (draftTop < el.scrollTop || draftTop > el.scrollTop + el.clientHeight - MIN_BLOCK_PX * 2) el.scrollTo({ top: Math.max(0, draftTop - el.clientHeight / 3) });
  }, [draftTop]);

  const press = useLongPressDraw<HTMLDivElement>({
    enabled: !!plan,
    ignore: BLOCK_SELECTOR,
    onChange: (range: DrawnRange | null) => setPreview(range ? slotDrawn(window, minutesAt(range.startY), minutesAt(range.endY)) : null),
    onDone: (range) => plan?.onSlot(slotDrawn(window, minutesAt(range.startY), minutesAt(range.endY))),
  });
  const tap = (event: React.MouseEvent) => {
    if (!plan || (event.target as Element).closest(BLOCK_SELECTOR)) return;
    plan.onSlot(slotAt(window, minutesAt(event.clientY)));
  };
  const dragOver = (event: React.DragEvent) => {
    if (!plan || !dragCarriesTask(event)) return;
    event.preventDefault();
    setDragging(true);
    setPreview(slotAt(window, minutesAt(event.clientY)));
  };
  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    setPreview(null);
    setDragging(false);
    const id = droppedTaskId(event);
    if (!plan || !id) return;
    const slot = slotAt(window, minutesAt(event.clientY));
    anchorRef.current = slot.startMinutes;
    hold(slot, plan.onDropTask(id, slot));
  };
  const slotBlock = (slot: PlacedSlot, className: string, ref?: Ref<HTMLDivElement>) => (
    <div ref={ref} className={classNames("day-block-slot", className)} style={{ "--top": `${y(slot.startMinutes)}px`, "--h": `${Math.max(px(slot.endMinutes - slot.startMinutes) - 2, MIN_BLOCK_PX)}px` } as CSSProperties} aria-hidden="true">
      <span className="day-block-time">{formatLineTime(slot.time, slot.until)}</span>
    </div>
  );

  return (
    <div ref={scroller} className="day-timeline" data-testid="day-timeline"
      onWheel={markUserScrolled} onTouchStart={markUserScrolled} onKeyDown={markUserScrolled}
      onPointerDown={(event) => { markUserScrolled(); if (!(event.target as Element).closest(BLOCK_SELECTOR + ", .day-block-grip")) blocks.deselect(); }}>
      <p className="day-live" role="status" aria-live="polite">{said}</p>
      <AllDayStrip events={allDay} onOpen={openExternal} />
      <div ref={(el) => { body.current = el; press.ref.current = el; }} className={classNames("day-timeline-body", plan && "is-plannable", focusLane && "has-focus-lane")} style={{ "--h": `${layout.height}px` } as CSSProperties}
        data-testid="day-timeline-body" {...press.handlers} onClick={tap}
        onDragOver={dragOver} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setPreview(null); setDragging(false); } }} onDrop={drop}>
        {hours.filter((h) => !folds.some((f) => h >= f.fromHour && h < f.toHour)).map((h) => (
          <div key={h} className="day-hour" style={{ "--top": `${y(h * 60)}px` } as CSSProperties}>
            {!(showNow && Math.abs(nowMinutes - h * 60) <= HOUR_LABEL_CLEARANCE_MINUTES) && (
              <span className="day-hour-label">{foldTime(h)}</span>
            )}
          </div>
        ))}
        {folds.map((fold) => (
          <Pressable key={fold.fromHour} type="button" className="day-fold" style={{ "--top": `${y(fold.fromHour * 60)}px`, "--h": `${FOLD_PX}px` } as CSSProperties}
            onClick={() => setOpenHours((prev) => new Set([...prev, ...Array.from({ length: fold.toHour - fold.fromHour }, (_, i) => fold.fromHour + i)]))}>
            {t("{from}–{to} empty · Show", { from: foldTime(fold.fromHour), to: foldTime(fold.toHour) })}
          </Pressable>
        ))}
        <div className={classNames("day-lanes", timedExternal.length > 0 && "has-ext")}>
          {timedExternal.length > 0 && <ExternalBlocks events={timedExternal} window={window} hourPx={HOUR_PX} yOf={y} onOpen={openExternal} />}
          {placed.map(({ item, topMinutes, heightMinutes, lane, lanes }, index) => {
            const id = item.ref?.id;
            // Only an open, timed task the reader may write moves; a done task's time is a record,
            // a focus record is what happened, and neither shows a way to be dragged.
            const span = itemSpan(window, item);
            const movable = !!plan?.onMoveBlock && !!span && !!id && item.kind === "task" && item.done === false
              && (id ? taskRefById(id, taskRefs)?.task.writable === true : false);
            const live = movable && blocks.gesture?.id === id ? blocks.gesture : null;
            const top = live ? live.slot.startMinutes : topMinutes;
            const topPx = y(top);
            const height = live ? (live.slot.until ? live.slot.endMinutes - live.slot.startMinutes : heightMinutes) : heightMinutes;
            // Shorter than the drawn minimum: one compact line, the full text on hover / long press.
            const compact = height < MIN_BLOCK_MINUTES;
            const title = itemTitle(item, t);
            const blockPx = `${Math.max(px(height) - 2, MIN_BLOCK_PX)}px`;
            const hasFocus = item.kind === "task" && !!item.ref && item.done === false;
            const timeText = live ? formatLineTime(live.slot.time, live.slot.until) : itemTimeText(item);
            return (
            <Fragment key={item.ref?.id ? `${item.kind}-${item.ref.id}` : `${item.kind}-${index}-${item.at}`}>
            <Pressable
              type="button"
              className={classNames("day-block", `day-block--${item.kind}`, item.past ? "is-past" : "is-coming", item.live && "is-live", compact && "is-compact", hasFocus && "has-focus",
                movable && "is-movable", live && "is-dragging", movable && blocks.selectedId === id && "is-selected")}
              title={compact ? `${timeText} ${title}`.trim() : undefined}
              style={{ "--top": `${topPx}px`, "--h": blockPx, "--lane": lane, "--lanes": lanes } as CSSProperties}
              disabled={!item.ref} onClick={() => onOpen(item)}
              {...(movable && span && id ? {
                ...blocks.reveal(id),
                onPointerDown: blocks.press(id, span, false),
                onKeyDown: blocks.keyDown(id, span),
                onContextMenu: (event: React.MouseEvent) => { if ((event.nativeEvent as PointerEvent).pointerType !== "mouse") event.preventDefault(); },
                "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowUp Alt+Shift+ArrowDown",
                "aria-description": t("Alt + ↑ ↓ moves it by 15 minutes; Alt + Shift + ↑ ↓ changes its length"),
              } : {})}>
              <span className="day-block-time">{timeText}</span>
              <span className="day-block-title">{title}</span>
              {item.detail && !compact && height >= 45 && <span className="day-block-detail">{item.detail}</span>}
            </Pressable>
            {movable && span && id && (
              <div className={classNames("day-block-grip", blocks.revealed(id) && "is-shown", blocks.selectedId === id && "is-selected")} data-testid="day-block-grip"
                style={{ "--top": `${topPx}px`, "--h": blockPx, "--lane": lane, "--lanes": lanes } as CSSProperties} aria-hidden="true" {...blocks.reveal(id)} onPointerDown={blocks.press(id, span, true)} />
            )}
            {hasFocus && (
              <Button variant="icon" size="sm" className="day-block-focus" aria-label={t("Start focus on {title}", { title: item.title })}
                style={{ "--top": `${topPx}px`, "--h": blockPx, "--lane": lane, "--lanes": lanes } as CSSProperties}
                onClick={() => requestFocus(item.ref!.id)}><Timer size={14} aria-hidden="true" /></Button>
            )}
            </Fragment>
            );
          })}
          {draft && slotBlock(draft, "day-block-slot--draft", draftRef)}
          {preview && slotBlock(preview, "day-block-slot--preview")}
          {showNow && (
            <div className="day-now" role="separator" aria-label={t("Now")} style={{ "--top": `${y(nowMinutes)}px` } as CSSProperties}><span>{clockLabel(new Date(nowMs).toISOString())}</span></div>
          )}
        </div>
        {focusLane && (
          <div className="day-focus-lane" role="group" aria-label={t("Time actually focused")}>
            {lanePlaced.map(({ item, topMinutes, heightMinutes }, index) => {
              const title = itemTitle(item, t);
              const text = `${itemTimeText(item)} ${title}`.trim();
              return (
                <Pressable key={`${item.at}-${index}`} type="button" className={classNames("day-focus-block", item.live && "is-live")} title={text} aria-label={text}
                  style={{ "--top": `${y(topMinutes)}px`, "--h": `${Math.max(px(heightMinutes) - 2, MIN_BLOCK_PX / 2)}px` } as CSSProperties}
                  disabled={!item.ref} onClick={() => onOpen(item)} />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
