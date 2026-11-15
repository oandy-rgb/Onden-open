// Empty stretches of one day's timeline, folded into one line each (「12:00–16:00 空著 · 展開」).
// Pure. Minutes are counted from the day's window start, as everywhere on the timeline; an "hour"
// is the whole-hour cell [h*60, h*60+60) of that window. A stretch folds when it is two or more
// whole hours in a row with no block touching them. "Now", the hour before it and the hours coming
// up (where the day is planned) stay open.

/** What a block covers: minutes after the window's start (as drawn, so a short block counts as long as its minimum). */
export type BlockSpan = { startMinutes: number; endMinutes: number };

/** A folded stretch: whole hours `fromHour` up to (not including) `toHour`. */
export type FoldRange = { fromHour: number; toHour: number };

/** At least this many empty hours in a row fold. */
export const MIN_FOLD_HOURS = 2;
/** The hours before the one holding "now" that never fold. */
const BEFORE_NOW_HOURS = 1;
/** The hours after it that never fold: what is coming up is where a plan goes, so it is in view without a tap. */
export const AFTER_NOW_HOURS = 8;

type Options = {
  /** Whole hours in the window (23 or 25 on a daylight-saving day). */
  hours: number;
  /** The hour holding "now", or null when the day shown is not today. */
  nowHour: number | null;
  /** Hours the reader opened: never folded again while they stay on this day. */
  open?: ReadonlySet<number>;
};

export function foldEmptyHours(blocks: readonly BlockSpan[], { hours, nowHour, open }: Options): FoldRange[] {
  const keep = (hour: number) =>
    open?.has(hour) === true
    || (nowHour !== null && hour >= nowHour - BEFORE_NOW_HOURS && hour <= nowHour + AFTER_NOW_HOURS)
    || blocks.some((b) => b.startMinutes < hour * 60 + 60 && Math.max(b.endMinutes, b.startMinutes + 1) > hour * 60);
  const folds: FoldRange[] = [];
  let from = -1;
  for (let hour = 0; hour <= hours; hour += 1) {
    const empty = hour < hours && !keep(hour);
    if (empty && from < 0) from = hour;
    if (!empty && from >= 0) {
      if (hour - from >= MIN_FOLD_HOURS) folds.push({ fromHour: from, toHour: hour });
      from = -1;
    }
  }
  return folds;
}

/** The vertical layout of a day with some stretches folded: each fold is one row of `foldPx`. */
export type FoldLayout = {
  /** Offset in px of a minute after the window's start; inside a fold it is spread over the fold's row. */
  y: (minutes: number) => number;
  /** The minute at an offset in px (the inverse of `y`). */
  minutesAt: (offsetPx: number) => number;
  /** Height of the whole day in px. */
  height: number;
};

export function foldLayout(folds: readonly FoldRange[], lengthMinutes: number, hourPx: number, foldPx: number): FoldLayout {
  const perMinute = hourPx / 60;
  // The day as pieces from top to bottom: open stretches at full scale, each fold squeezed into one row.
  type Piece = { from: number; to: number; top: number; px: number };
  const pieces: Piece[] = [];
  let minute = 0;
  let top = 0;
  const add = (to: number, px: number) => {
    if (to <= minute) return;
    pieces.push({ from: minute, to, top, px });
    top += px;
    minute = to;
  };
  for (const fold of folds) {
    add(fold.fromHour * 60, (fold.fromHour * 60 - minute) * perMinute);
    add(fold.toHour * 60, foldPx);
  }
  add(lengthMinutes, (lengthMinutes - minute) * perMinute);
  const height = top;
  return {
    height,
    y: (minutes) => {
      if (minutes <= 0) return minutes * perMinute;
      if (minutes >= lengthMinutes) return height + (minutes - lengthMinutes) * perMinute;
      const piece = pieces.find((p) => minutes < p.to)!;
      return piece.top + ((minutes - piece.from) / (piece.to - piece.from)) * piece.px;
    },
    minutesAt: (offsetPx) => {
      if (offsetPx <= 0) return offsetPx / perMinute;
      if (offsetPx >= height) return lengthMinutes + (offsetPx - height) / perMinute;
      const piece = pieces.find((p) => offsetPx < p.top + p.px)!;
      return piece.from + ((offsetPx - piece.top) / piece.px) * (piece.to - piece.from);
    },
  };
}
