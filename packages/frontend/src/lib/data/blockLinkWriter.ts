// `[[筆記/段落開頭]]`: asking the server to anchor a part of a note and bind the link text to it, to confirm a
// doubtful anchor, and to count the links that mean a paragraph (backend services/blockLinks.ts,
// docs/architecture/proposals/block-anchors-2026-11-01.md §6–§7).
//
// The link is already written in the note when `bind` runs, and it works without the binding (it is read by its
// words, like one typed by hand), so `bind` is best effort and says nothing when it cannot: offline, the part has
// changed, the note is read-only. Nothing the person typed is lost or changed by a failure here. `confirm` is a
// person's decision and reports its failure like any write.

import { cutToGraphemes } from "@onden/markdown";
import { api } from "../api";
import { randomUUID } from "../uuid";
import { t } from "../i18n";
import { reportWriteFailure } from "./writeErrors";
import type { DataCtx } from "./types";

/** What the server made: the link as it should read between `[[` and `]]` (the words may differ from the suggestion when
 *  another paragraph of the same note already uses them). */
export type BoundPartLink = { anchorId: string; link: string; linkText: string };

export type PartToLink = {
  /** Where the person saw the part in the target note, and what it began with. */
  at: number;
  seenText: string;
  /** The words after the `/` the link was written with. */
  suggestedText: string;
};

export function makeBlockLinkWriter(ctx: DataCtx) {
  return {
    /** Anchor the part and bind the link written in `sourceNoteId` to it; null when that could not be done (the link still reads by its words). */
    async bind(sourceNoteId: string, targetNoteId: string, part: PartToLink): Promise<BoundPartLink | null> {
      if (!ctx.online) return null;
      try {
        const made = await api<{ anchor_id: string; link: string; link_text: string }>(`/api/nodes/${targetNoteId}/block-links`, {
          method: "POST", headers: { "Idempotency-Key": randomUUID() },
          body: JSON.stringify({ source_note_id: sourceNoteId, at: part.at, seen_text: cutToGraphemes(part.seenText, 2000), suggested_text: part.suggestedText }),
        });
        return { anchorId: made.anchor_id, link: made.link, linkText: made.link_text };
      } catch {
        // Refused (the part changed, a read-only note) or not reached: the link keeps reading by its words.
        return null;
      }
    },

    /** 「就是這段」: the person confirms where a doubtful anchor is. False when there was nothing left to confirm. */
    async confirm(noteId: string, anchorId: string): Promise<boolean> {
      if (!ctx.online) { ctx.addToast(t("Could not reach the server. Try again when the connection is available."), "error"); return false; }
      try {
        const answer = await api<{ confirmed: boolean }>(`/api/nodes/${noteId}/block-anchors/${anchorId}/confirm`, {
          method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: "{}",
        });
        return answer.confirmed;
      } catch (error) {
        reportWriteFailure(error, ctx.addToast);
        return false;
      }
    },

    /** How many links the reader can see mean each paragraph of the note (anchor id → count); empty when unknown. */
    async counts(noteId: string): Promise<Map<string, number>> {
      if (!ctx.online) return new Map();
      try {
        const answer = await api<{ counts: Array<{ anchor_id: string; links: number }> }>(`/api/nodes/${noteId}/block-link-counts`);
        return new Map(answer.counts.map((c) => [c.anchor_id, c.links]));
      } catch { return new Map(); }
    },
  };
}
