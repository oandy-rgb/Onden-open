// How a paragraph's text now differs from an older one, in words a person reads
// ("now has «…» more"). Character level, from the common start and end.

export type TextChange =
  | { kind: "same" }
  | { kind: "added"; added: string }
  | { kind: "removed"; removed: string }
  | { kind: "both"; added: string; removed: string }
  | { kind: "rewritten" };

/** What `current` has that `old` lacks and the other way round. Little in
 *  common (under a third of the longer text) is a rewrite, not an edit. */
export function describeChange(old: string, current: string): TextChange {
  if (old === current) return { kind: "same" };
  const max = Math.min(old.length, current.length);
  let head = 0;
  while (head < max && old[head] === current[head]) head++;
  let tail = 0;
  while (tail < max - head && old[old.length - 1 - tail] === current[current.length - 1 - tail]) tail++;
  // Spaces at the edges of a change are shown as part of the neighbours.
  const shown = (s: string) => s.trim() || s;
  const removed = shown(old.slice(head, old.length - tail));
  const added = shown(current.slice(head, current.length - tail));
  if ((head + tail) * 3 < Math.max(old.length, current.length)) return { kind: "rewritten" };
  if (!removed) return { kind: "added", added };
  if (!added) return { kind: "removed", removed };
  return { kind: "both", added, removed };
}
