// 「最近存的段落」: the paragraphs a block link was last copied for (the ¶ menu
// and the selection bubble's 「複製區塊連結」), kept per account (lib/accountPrefStore,
// pref key "recentBlocks") so a paragraph saved on the phone is listed on the
// desktop. The editor's `((` and `[[` lists show them first (lib/blockRefSearch).
//
// An entry is the note's id and the paragraph's anchor id, never its text (except a
// copied link not yet pasted: see PendingBlockId): the text
// is read when the list is shown, so an edited paragraph shows its current words
// and one that is gone, or whose note the reader cannot see, is simply left out.

import { newBlockId } from "@onden/markdown";
import { createAccountPref } from "./accountPrefStore";
import { PREFS } from "./prefs";
import type { SyncedPrefStore } from "./syncedPrefStore";

/** A paragraph that had no anchor when its link was copied (a copied block link writes nothing until it is pasted into
 *  Onden): it is found again by what it says. */
export type PendingBlockId = { text: string; blockKind: "paragraph" | "listItem"; start: number };

export type RecentBlock = {
  /** The note's id. */
  note: string;
  /** The paragraph's anchor id; for a `pending` entry only a key that tells it from the others. */
  ref: string;
  /** When it was saved, in ms since epoch: two devices' lists merge by it. */
  at: number;
  /** Set when the paragraph had no anchor: `ref` is then no anchor id, and the paragraph is found by its words. */
  pending?: PendingBlockId;
};

export const RECENT_BLOCKS_MAX = 10;

const sameBlock = (a: RecentBlock, b: RecentBlock) => a.note === b.note && a.ref === b.ref;

/** Newest first, each paragraph once (its newest time), at most RECENT_BLOCKS_MAX. */
function tidy(entries: readonly RecentBlock[]): RecentBlock[] {
  const out: RecentBlock[] = [];
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    if (!out.some((kept) => sameBlock(kept, entry))) out.push(entry);
  }
  return out.slice(0, RECENT_BLOCKS_MAX);
}

/** A stored value read back, or null when it is not a list of entries. */
export function parseRecentBlocks(value: unknown): readonly RecentBlock[] | null {
  if (!Array.isArray(value)) return null;
  const entries: RecentBlock[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { note, ref, at, pending } = item as Record<string, unknown>;
    if (typeof note !== "string" || !note || note.length > 64) return null;
    if (typeof ref !== "string" || !ref || ref.length > 64) return null;
    if (typeof at !== "number" || !Number.isInteger(at) || at <= 0) return null;
    if (pending === undefined) { entries.push({ note, ref, at }); continue; }
    const p = pending as Record<string, unknown> | null;
    if (!p || typeof p.text !== "string" || p.text.length > 300) return null;
    if (p.blockKind !== "paragraph" && p.blockKind !== "listItem") return null;
    if (typeof p.start !== "number" || !Number.isInteger(p.start) || p.start < 0) return null;
    entries.push({ note, ref, at, pending: { text: p.text, blockKind: p.blockKind, start: p.start } });
  }
  return tidy(entries);
}

/** `list` with the paragraph moved (or added) to the front. */
export function withRecentBlock(list: readonly RecentBlock[], note: string, ref: string, now: number, pending?: PendingBlockId): RecentBlock[] {
  // Never older than the entry it replaces or the newest one, so a clock that
  // went backwards still puts it first.
  const newest = list.reduce((max, entry) => Math.max(max, entry.at), 0);
  return tidy([{ note, ref, at: Math.max(now, newest + 1), ...(pending ? { pending } : {}) }, ...list]);
}

const recentBlocksPref = createAccountPref<readonly RecentBlock[]>({
  serverKey: "recentBlocks",
  follows: "account", // blocks they used lately: about their notes, not the screen
  copy: PREFS.recentBlocks,
  parse: parseRecentBlocks,
  // Both devices' lists, newest first: one saved on the other device while this
  // one was offline stays.
  merge: (theirs, mine) => tidy([...(theirs ?? []), ...mine]),
});

export const recentBlocksStore: SyncedPrefStore<readonly RecentBlock[]> = recentBlocksPref.store;
export const recentBlocksBound = recentBlocksPref.bound;

/** Put the paragraph first in 「最近存的段落」, here and on the server. `pending`: it has no anchor, find it by its words. */
export function rememberBlock(note: string, ref: string, now: number = Date.now(), pending?: PendingBlockId): void {
  recentBlocksStore.save(withRecentBlock(recentBlocksStore.get().value ?? [], note, ref, now, pending));
}

/** 「複製區塊連結」 copied a link to `block` of `note`: put it first in 「最近存的段落」 — by its anchor when it has one, else
 *  by its words, reusing the entry an earlier copy of the same words made. */
export function rememberCopiedBlock(note: string, anchorId: string | null, block: PendingBlockId): void {
  if (anchorId) return rememberBlock(note, anchorId);
  const pending = { text: block.text, blockKind: block.blockKind, start: block.start };
  const same = (recentBlocksStore.get().value ?? []).find((e) => e.note === note && e.pending?.text === pending.text && e.pending.blockKind === pending.blockKind);
  rememberBlock(note, same?.ref ?? newBlockId(), Date.now(), pending);
}
