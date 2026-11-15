// The note-history screen's data and state, as pure functions: one point per
// stored version plus "now" at the right end, what the slider shows at a given
// position, and the hold-to-see-now comparison.

import { dateIdAt } from "../localDate";
import { summarizeChange, type ChangeSummary } from "@onden/markdown";

export type HistoryMarker = "before_agent" | "restored" | `published:${number}`;
export type AuthorKind = "human" | "agent" | "system";

/** One row of `GET /api/nodes/:id/versions`. The last four fields come from the
 *  server when it sends them; otherwise they are worked out here. */
export type NoteHistoryVersion = {
  id: string;
  title: string;
  markdown: string;
  changed_at: string;
  actor_name: string | null;
  actor_type: string | null;
  saves?: number;
  summary?: ChangeSummary;
  markers?: string[];
  restored_from?: string | null;
  actor_kind?: AuthorKind;
};

export type TimelinePoint = {
  /** The stored version's id; null for "now". */
  versionId: string | null;
  /** The note's title at this point. */
  title: string;
  /** The title one step earlier; null for the first version. */
  previousTitle: string | null;
  body: string;
  /** The body one step earlier; "" for the first version. */
  previousBody: string;
  changedAt: string | null;
  authorKind: AuthorKind;
  authorName: string | null;
  summary: ChangeSummary;
  markers: HistoryMarker[];
  restoredFrom: string | null;
};

export function authorKindOf(v: Pick<NoteHistoryVersion, "actor_kind" | "actor_type">): AuthorKind {
  if (v.actor_kind) return v.actor_kind;
  if (v.actor_type === "ai_agent" || v.actor_type === "agent") return "agent";
  return v.actor_type === "system" ? "system" : "human";
}

function knownMarkers(markers: string[] | undefined): HistoryMarker[] {
  return (markers ?? []).filter((m): m is HistoryMarker => m === "before_agent" || m === "restored" || /^published:\d+$/.test(m));
}

/** Oldest first; the last point is the note as it is now (the newest version
 *  itself when the text has not moved since). `versionsNewestFirst`
 *  is the server's order. */
export function buildTimeline(versionsNewestFirst: NoteHistoryVersion[], currentMarkdown: string, currentTitle: string): TimelinePoint[] {
  const oldestFirst = [...versionsNewestFirst].reverse();
  const points: TimelinePoint[] = oldestFirst.map((v, i) => {
    const previousBody = oldestFirst[i - 1]?.markdown ?? "";
    return {
      versionId: v.id, title: v.title, previousTitle: oldestFirst[i - 1]?.title ?? null, body: v.markdown, previousBody, changedAt: v.changed_at,
      authorKind: authorKindOf(v), authorName: v.actor_name,
      summary: v.summary ?? summarizeChange(previousBody, v.markdown),
      markers: knownMarkers(v.markers), restoredFrom: v.restored_from ?? null,
    };
  });
  const last = oldestFirst[oldestFirst.length - 1];
  // The note is as the newest version left it: that version is "now", no
  // second point for the same text and title.
  if (last && last.markdown === currentMarkdown && last.title === currentTitle) return points;
  points.push({
    versionId: null, title: currentTitle, previousTitle: last?.title ?? null, body: currentMarkdown, previousBody: last?.markdown ?? "", changedAt: null,
    authorKind: "human", authorName: null,
    summary: summarizeChange(last?.markdown ?? "", currentMarkdown), markers: [], restoredFrom: null,
  });
  return points;
}

/** The point the slider opens on: the version asked for, else the last one
 *  saved on or before `day` (workspace date), else the newest stored one, else now. */
export function initialIndex(points: TimelinePoint[], versionId?: string | null, day?: string): number {
  const asked = points.findIndex((p) => p.versionId !== null && p.versionId === versionId);
  if (asked >= 0) return asked;
  if (day) {
    for (let i = points.length - 1; i >= 0; i--) {
      const at = points[i]!.changedAt;
      if (points[i]!.versionId !== null && at && dateIdAt(new Date(at)) <= day) return i;
    }
  }
  // The last point is the pseudo-point "now" unless the newest version already is the text on screen.
  return Math.max(0, points.length - (points[points.length - 1]?.versionId === null ? 2 : 1));
}

export type ScrubState = {
  index: number;
  /** "Hold to see now" is pressed: the screen shows the present without marks. */
  holding: boolean;
  /** Which paragraph of the shown version is open in the take-back panel. */
  paragraph: number | null;
};

export type ScrubAction =
  | { type: "seek"; index: number }
  | { type: "step"; delta: number }
  | { type: "latest" }
  | { type: "hold"; pressed: boolean }
  | { type: "paragraph"; index: number | null };

export function scrubReducer(state: ScrubState, action: ScrubAction, pointCount: number): ScrubState {
  const last = Math.max(0, pointCount - 1);
  const clamp = (i: number) => Math.min(last, Math.max(0, i));
  switch (action.type) {
    case "seek": return { index: clamp(action.index), holding: false, paragraph: null };
    case "step": return { index: clamp(state.index + action.delta), holding: false, paragraph: null };
    case "latest": return { index: last, holding: false, paragraph: null };
    case "hold": return state.holding === action.pressed ? state : { ...state, holding: action.pressed };
    case "paragraph": return { ...state, paragraph: action.index };
  }
}

export type ShownBody = {
  point: TimelinePoint;
  body: string;
  /** The body to mark changes against; null when nothing is marked. */
  markAgainst: string | null;
  isNow: boolean;
  /** True while holding: the screen shows now, but the slider sits elsewhere. */
  peeking: boolean;
};

export function shown(points: TimelinePoint[], state: ScrubState): ShownBody {
  const atNow = state.index >= points.length - 1;
  const peeking = state.holding && !atNow;
  const point = points[peeking ? points.length - 1 : state.index];
  return { point, body: point.body, markAgainst: peeking || atNow ? null : point.previousBody, isNow: atNow || peeking, peeking };
}

/** The most dots the slider draws; more would run together into a line. */
export const MAX_TICKS = 48;

/** The version nearest to a place along the slider (0 = oldest end, 1 = now). */
export function nearestIndex(fraction: number, pointCount: number): number {
  const last = Math.max(0, pointCount - 1);
  if (!Number.isFinite(fraction)) return last;
  return Math.min(last, Math.max(0, Math.round(fraction * last)));
}

/** Which versions get a dot: all of them while they fit, otherwise an even sample that
 *  keeps both ends. The version being looked at always has one. Ascending, at most `max`. */
export function tickIndexes(pointCount: number, current: number, max = MAX_TICKS): number[] {
  if (pointCount <= max) return Array.from({ length: pointCount }, (_, i) => i);
  const slots = max - 1;
  const picked = new Set<number>([Math.min(pointCount - 1, Math.max(0, current))]);
  for (let k = 0; k < slots; k++) picked.add(Math.round((k * (pointCount - 1)) / (slots - 1)));
  const sorted = [...picked].sort((a, b) => a - b);
  return sorted.slice(0, max);
}
