// 「變成子筆記」 (a block, or a selected text) and 「展開回內文」 (docs/architecture/block-nodes.md): one online
// write each, the server does it as one restorable event. This only asks and
// says what came of it; the paragraph's `^id` and the pending edit are the
// caller's to settle first (hooks/useBlockChildNote.ts).

import { api, ApiError, type ContentNode } from "../api";
import { t } from "../i18n";
import { webCryptoSha256 } from "../hex";
import { makeOnlineOperation } from "./onlineWrite";
import type { DataCtx } from "./types";

/** The notes whose links could not be rewritten, for the person to decide on.
 *  `hidden` counts the ones they may not even see. */
export type UnwritableReferences = { notes: Array<{ id: string; title: string }>; hidden: number };

export type BlockChildOutcome =
  | { kind: "done"; noteMarkdown: string; childId: string; eventId: string; rewritten: number; left: number }
  /** Refused with nothing written: some links are in notes the person cannot edit. */
  | { kind: "unwritable"; references: UnwritableReferences }
  /** Refused or failed, and the writer told the person. */
  | { kind: "refused" };

type Answer = { note: { markdown: string }; child_id: string; event_id: string; rewritten: unknown[]; left: unknown[] };

const unwritable = (error: unknown): UnwritableReferences | null => {
  if (!(error instanceof ApiError) || error.code !== "references_unwritable") return null;
  const body = error.body as { notes?: Array<{ id: string; title: string }>; hidden_count?: number } | undefined;
  return { notes: body?.notes ?? [], hidden: body?.hidden_count ?? 0 };
};

export function makeBlockChildWriter(ctx: DataCtx) {
  const operation = makeOnlineOperation(ctx);

  async function run(noteId: string, path: string, body: unknown): Promise<BlockChildOutcome> {
    let blocked: UnwritableReferences | null = null;
    try {
      const answer = await operation(`block-child:${noteId}`, t("Moving a part into a child note needs a connection."), async (submit) => {
        const result = await submit<Answer>(path, JSON.stringify(body));
        // A retry the server had already applied answers without the result: the
        // change stands, and a reload shows it.
        if ("deduped" in result) { ctx.addToast(t("The change is saved. Refresh to load the latest details."), "info"); return null; }
        return result;
      }, undefined, (error) => (blocked = unwritable(error)) !== null);
      if (answer === null) { await ctx.refresh().catch(() => {}); return { kind: "refused" }; }
      // The note reads as the server saved it at once; the other notes and the
      // child arrive with the refreshed projection.
      ctx.setData((state) => ({ ...state, nodes: state.nodes.map((n) => (n.id === noteId ? { ...n, markdown: answer.note.markdown } : n)) }));
      await ctx.refresh().catch(() => ctx.addToast(t("The change is saved. Refresh to load the latest details."), "info"));
      return { kind: "done", noteMarkdown: answer.note.markdown, childId: answer.child_id, eventId: answer.event_id, rewritten: answer.rewritten.length, left: answer.left.length };
    } catch (error) {
      const references = blocked ?? unwritable(error);
      return references ? { kind: "unwritable", references } : { kind: "refused" };
    }
  }

  return {
    /** Put the block `^blockRef` of the note in a new child note. `leaveUnwritable`:
     *  go on although some links are in notes this person cannot edit (they stay
     *  as they are). `fallbackTitle` names a part with no words. */
    moveToChild: (noteId: string, blockRef: string, options: { leaveUnwritable?: boolean; keepIdentity?: boolean } = {}) =>
      run(noteId, `/api/nodes/${noteId}/block-to-child`, {
        block_ref: blockRef, fallback_title: t("Untitled note"), ...(options.leaveUnwritable ? { unwritable: "leave" } : {}),
        // 「獨立出去」: the paragraph keeps its task, schedule and links instead of being copied.
        ...(options.keepIdentity ? { keep_identity: true } : {}),
      }),
    /** Put the selected text of the note (offsets into the note as saved, and the
     *  text the person saw there) in a new child note: across paragraphs, or half
     *  of one. The same single event as `moveToChild`. */
    moveSelectionToChild: (noteId: string, selection: { from: number; to: number; text: string }, options: { leaveUnwritable?: boolean } = {}) =>
      run(noteId, `/api/nodes/${noteId}/block-to-child`, {
        selection, fallback_title: t("Untitled note"), ...(options.leaveUnwritable ? { unwritable: "leave" } : {}),
      }),
    /** Put the child note's text back where its `![[…]]` line is. */
    expand: (noteId: string, childId: string) => run(noteId, `/api/nodes/${noteId}/expand-child`, { child_id: childId }),
    /** 「重新指定」: point a paragraph whose place was lost at the block at `at` (an offset into `body`, the note as the
     *  person saw it). The server refuses when the note has changed since. True when it was saved. */
    async reassign(noteId: string, blockNodeId: string, at: number, body: string): Promise<boolean> {
      const digest = webCryptoSha256();
      if (!digest) return false;
      const bodyHash = await digest(body);
      try {
        await operation(`block-child:${noteId}`, t("Pointing a paragraph at a new place needs a connection."), (submit) =>
          submit(`/api/nodes/${noteId}/paragraphs/${blockNodeId}/reassign`, JSON.stringify({ at, body_hash: bodyHash })));
        return true;
      } catch { return false; }
    },
    /** Take the whole operation back (its event, with everything it caused:
     *  the child note, the rewritten links). Resolves the note as it reads now;
     *  null when it could not be undone (reported once). */
    async undo(noteId: string, eventId: string): Promise<ContentNode | null> {
      try {
        await operation(`block-child:${noteId}`, t("Undoing needs a connection."), (submit) =>
          submit(`/api/events/${eventId}/restore`, JSON.stringify({ cascade: true })));
        const restored = await api<ContentNode>(`/api/nodes/${noteId}`);
        ctx.setData((state) => ({ ...state, nodes: state.nodes.map((n) => (n.id === noteId ? { ...n, markdown: restored.markdown } : n)) }));
        await ctx.refresh().catch(() => {});
        return restored;
      } catch { return null; }
    },
  };
}
