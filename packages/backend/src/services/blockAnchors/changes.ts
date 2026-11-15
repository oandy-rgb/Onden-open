// The edit as a CodeMirror ChangeSet, so anchors move with the same mapPos the editor uses.
// The editor may send its real ChangeSet (JSON); it is trusted only after it is shown to turn the old
// body into the new one. Every other write (merge result, agent, import, restore) gets one derived by
// a line diff, then a character diff inside the changed lines — a character diff of the whole note is
// too slow for large notes (experiment §6).

import { ChangeSet, Text } from "@codemirror/state";
import { diffArrays, diffChars } from "diff";

/** What an editor save says about how the text changed (PATCH `body_change`): its ChangeSet, unverified,
 *  and which device made the edit (recorded on the anchor events, proposal §3.1). */
export type EditorBodyChange = { changes: unknown; device: string | null };

/** The request's `body_change`, or undefined when absent or not shaped like one. */
export function readEditorBodyChange(raw: unknown): EditorBodyChange | undefined {
  if (typeof raw !== "object" || raw === null || !("changes" in raw)) return undefined;
  const device = (raw as { device?: unknown }).device;
  return { changes: (raw as { changes: unknown }).changes, device: typeof device === "string" && device.length > 0 && device.length <= 64 ? device : null };
}

type Op = { from: number; to: number; insert: string };

/** Beyond this many characters in a changed block the block is replaced as a whole. */
const CHAR_DIFF_BUDGET = 4e6;

function charOps(oldText: string, newText: string): Op[] {
  const parts = diffChars(oldText, newText);
  const ops: Op[] = [];
  let o = 0;
  let cur: Op | null = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const len = p.value.length;
    if (!p.added && !p.removed) {
      // A short equal stretch between two edits is one typed edit, not two.
      if (cur && len < 4 && i + 1 < parts.length) { cur.insert += p.value; cur.to = o + len; } else cur = null;
      o += len;
      continue;
    }
    if (!cur) { cur = { from: o, to: o, insert: "" }; ops.push(cur); }
    if (p.removed) { o += len; cur.to = o; } else cur.insert += p.value;
  }
  return ops;
}

/** A ChangeSet turning `before` into `after` (not necessarily the minimal one). */
export function deriveChangeSet(before: string, after: string): ChangeSet {
  if (before === after) return ChangeSet.empty(before.length);
  const split = (t: string) => t.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const parts = diffArrays(split(before), split(after));
  const ops: Op[] = [];
  let ao = 0, bo = 0, ha = -1, hb = -1;
  const close = () => {
    if (ha < 0) return;
    const oldH = before.slice(ha, ao), newH = after.slice(hb, bo);
    if (oldH.length * newH.length > CHAR_DIFF_BUDGET) ops.push({ from: ha, to: ao, insert: newH });
    else for (const c of charOps(oldH, newH)) ops.push({ from: c.from + ha, to: c.to + ha, insert: c.insert });
    ha = -1;
  };
  for (const p of parts) {
    const len = p.value.reduce((n: number, l: string) => n + l.length, 0);
    if (!p.added && !p.removed) { close(); ao += len; bo += len; continue; }
    if (ha < 0) { ha = ao; hb = bo; }
    if (p.removed) ao += len; else bo += len;
  }
  close();
  return ChangeSet.of(ops, before.length);
}

/**
 * The editor's ChangeSet if (and only if) it turns `before` into `after`; otherwise null.
 * The editor's word is never taken for the text: a stale offline queue or an old client can send
 * a ChangeSet for another version.
 */
export function verifiedEditorChanges(json: unknown, before: string, after: string): ChangeSet | null {
  try {
    const cs = ChangeSet.fromJSON(json);
    if (cs.length !== before.length || cs.newLength !== after.length) return null;
    const applied = cs.apply(Text.of(before.split("\n"))).toString();
    return applied === after ? cs : null;
  } catch {
    return null;
  }
}
