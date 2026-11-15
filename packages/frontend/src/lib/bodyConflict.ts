// A BODY_CONFLICT event (backend services/eventLog/bodyMerge.ts): two writers
// changed the same lines of a note differently. The note kept `incoming` (the
// later save); `current` is the other writer's text, which the merge left out.

export type BodyConflictRegion = {
  base: string;
  incoming: string;
  current: string;
  /** The note's line before and after `incoming` when it was saved ("" at an edge). */
  before: string;
  after: string;
};

export type BodyConflictPayload = {
  conflicts: BodyConflictRegion[];
  conflict_count: number;
  /** Too large to keep in the event: compare in version history instead. */
  truncated?: true;
};

export type BodyConflictChoice = "other" | "both";

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/** Where the kept text is in `body` now: by its surrounding lines, else by
 *  itself when it occurs once. Null when it was edited away or is ambiguous. */
export function findKeptText(body: string, region: BodyConflictRegion): number | null {
  const needle = region.before + region.incoming + region.after;
  const placed = occurrences(body, needle).filter((at) =>
    (region.before !== "" || at === 0) && (region.after !== "" || at + needle.length === body.length));
  if (placed.length === 1) return placed[0]! + region.before.length;
  if (region.incoming === "") return null;
  const alone = occurrences(body, region.incoming);
  return alone.length === 1 ? alone[0]! : null;
}

/** `body` with the conflict resolved: the other writer's text instead of the
 *  kept one, or both (kept first). Null when the kept text can't be found. */
export function resolveBodyConflict(body: string, region: BodyConflictRegion, choice: BodyConflictChoice): string | null {
  const at = findKeptText(body, region);
  if (at === null) return null;
  const { incoming, current } = region;
  const joint = incoming !== "" && current !== "" && !incoming.endsWith("\n") ? "\n" : "";
  const replacement = choice === "other" ? current : incoming + joint + current;
  return body.slice(0, at) + replacement + body.slice(at + incoming.length);
}

/** Whether a BODY_CONFLICT left out text this tab saved: the left-out
 *  (`current`) side of a region is in `ownSaved`, the text this tab last had
 *  the server accept. A payload too large to carry regions counts when the tab
 *  saved the note at all. The tab whose text won (`incoming`) is told by its
 *  own save's reply instead. */
export function leftOutOwnText(ownSaved: string | undefined, payload: BodyConflictPayload): boolean {
  if (ownSaved === undefined) return false;
  if (payload.truncated) return true;
  return payload.conflicts.some((r) => r.current.trim() !== "" && ownSaved.includes(r.current.replace(/\n$/, "")));
}
