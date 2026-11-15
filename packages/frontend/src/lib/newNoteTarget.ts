// 「新筆記放在」: where a new note goes from the sidebar's ＋ (components/CreateSheet).
// Stored per account as one pref; none = no choice made (the personal space's
// top level). Quick capture does not use it: where a capture goes is its own
// setting (modules/capture/captureDestination).
//   • a note: stored as its id (the original format — old values read as this);
//   • the top level of a space other than the personal one: `space:<id>`.
//     The personal space's top level is the default, so choosing it stores none.
// A note under a note always takes that note's space (the database keeps them
// equal), so only a top-level target carries a space.
import type { ContentNode } from "./api";
import { capabilitiesFor } from "./capabilities";
import { PREFS, getPref, removePref, setPref } from "./prefs";
import type { Space } from "./spaces";
import { isSystemNode } from "./systemNodes";
import { isRetiredBoardKind } from "./whiteboardNote";
import { isTag } from "@onden/markdown/contract";

export type NewNoteTarget = { kind: "note"; noteId: string } | { kind: "space"; spaceId: string };

const SPACE_PREFIX = "space:";

export function getNewNoteTarget(): NewNoteTarget | null {
  const stored = getPref(PREFS.quickCaptureTarget);
  if (!stored) return null;
  if (stored.startsWith(SPACE_PREFIX)) {
    const spaceId = stored.slice(SPACE_PREFIX.length);
    return spaceId ? { kind: "space", spaceId } : null;
  }
  return { kind: "note", noteId: stored };
}

export function setNewNoteTarget(target: NewNoteTarget | null): void {
  if (!target) removePref(PREFS.quickCaptureTarget);
  else setPref(PREFS.quickCaptureTarget, target.kind === "note" ? target.noteId : `${SPACE_PREFIX}${target.spaceId}`);
}

/** The spaces a new top-level note may go in, the personal space first: not the
 *  system space, not one where this person only reads. */
export function writableSpaces(spaces: readonly Space[]): Space[] {
  const caps = capabilitiesFor(false, [...spaces], true);
  return spaces
    .filter((s) => s.kind !== "system" && caps.canMoveInto(s))
    .sort((a, b) => Number(b.kind === "personal") - Number(a.kind === "personal"));
}

/** The remembered space, while it is still writable and there is a choice to
 *  make (two or more writable spaces); null otherwise. */
export function rememberedSpace(spaces: readonly Space[], target: NewNoteTarget | null): Space | null {
  if (target?.kind !== "space") return null;
  const writable = writableSpaces(spaces);
  return writable.length < 2 ? null : writable.find((s) => s.id === target.spaceId) ?? null;
}

/** The space a top-level note goes in now, or null when there is nothing to
 *  choose (fewer than two writable spaces, or the list is not loaded: the
 *  server files it in the personal space). A remembered space that is gone or
 *  no longer writable reads as the personal space. */
export function topLevelSpace(spaces: readonly Space[], target: NewNoteTarget | null): Space | null {
  const writable = writableSpaces(spaces);
  if (writable.length < 2) return null;
  return rememberedSpace(spaces, target) ?? writable.find((s) => s.kind === "personal") ?? writable[0]!;
}

/** The target to store for a space's top level: the personal space is the default. */
export function spaceTarget(space: Pick<Space, "id" | "kind">): NewNoteTarget | null {
  return space.kind === "personal" ? null : { kind: "space", spaceId: space.id };
}

/** A note can hold new notes: a plain note, not a tag definition, a board or a
 *  system row. The server still checks that the person may write under it. */
export function canHoldNewNotes(n: ContentNode): boolean {
  return !isTag(n) && !isRetiredBoardKind(n) && !isSystemNode(n);
}
