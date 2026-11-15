// Old part links → new ones, and back (docs/architecture/proposals/block-anchors-batch3-inventory-2026-11-07.md §切換設計 2).
//
// `[[筆記#^id]]` named a paragraph by the `^id` written in its note. The id is now the paragraph's anchor id, so those
// links keep resolving — and this job writes them the way the app writes a part link now, `[[筆記/段落開頭]]`, with
// the binding (`block_link_bindings`: the link as written → the anchor id) saved beside the text. The paragraph is
// still found by identity; the words after the `/` are only what people read.
//
// Run by the same system job as the `^id` conversion (services/blockMarkerRepair.ts), after it, as that job's actor:
// one note per transaction, a plain edit (updateNode: version, event, derived state) that leaves `updated_at` alone,
// restartable and idempotent (a rewritten link has no `#^` left; a note with none is not read again).
//
// What it will not guess — each is left as it was and counted in the report:
//   target_not_found  the anchor id is not an anchor (the note it was in was not converted, or the paragraph is gone)
//   target_not_valid  the anchor is `maybe` or `lost`: no certain place whose words could be written
//   other_space       the paragraph is in another space: its first words would be shown to readers of this note
//   no_words          the paragraph has no words (a picture, a code block)
//   unsafe_title      the note that holds the paragraph has a title that cannot sit inside `[[…]]`
// The way back (restoreBlockLinks, run by revertBlockIds) writes every bound part link as `[[筆記#^id]]` again.

import { oldPartLinkIds, restorePartLinks, writePartLinks, oldPartLinkWords, blockExcerptOf, blockLinkText, bindingKey, noteNamer, linkPathReadings } from "@onden/markdown";
import { sql } from "kysely";
import { db } from "../dbKysely.js";
import { log } from "../logger.js";
import type { ActorCtx } from "../types.js";
import { walkNotes, type JobScope } from "./blockPass.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { anchorsByIds, recordLinkBound } from "./blockAnchors/index.js";
import { BodyConflictError, updateNode } from "./nodeUpdate.js";

export type LinkLeftReason = "target_not_found" | "target_not_valid" | "other_space" | "no_words" | "unsafe_title" | "note_changed" | "write_failed";
export type LinkRewriteLeft = { workspaceId: string; noteId: string; reason: LinkLeftReason; links: number };
export type LinkRewriteReport = { notesRewritten: number; linksRewritten: number; left: LinkRewriteLeft[] };

const NOTE_EVENT = { uiContext: "system.block_link_rewrite", cascadeLabel: "block-link-rewrite.cascade", backupPrefix: "NODE_UPDATED" } as const;
/** Characters a note title cannot carry into `[[…]]`. */
const UNSAFE_TITLE = /[[\]|#^\r\n]/;

type Bound = { key: string; anchorId: string; holderId: string };

async function rewriteNote(actor: ActorCtx, workspaceId: string, noteId: string, batch: string): Promise<{ rewritten: number; left: Map<LinkLeftReason, number> } | null> {
  return withEventTransaction(workspaceId, async () => {
    const note = await db.selectFrom("content_nodes").select(["markdown", "space_id"])
      .where("workspace_id", "=", workspaceId).where("id", "=", noteId).where("deleted_at", "is", null).where("node_type", "=", "content")
      .forUpdate().executeTakeFirst();
    if (!note) return null;
    const ids = [...new Set(oldPartLinkIds(note.markdown))];
    if (ids.length === 0) return null;

    const anchors = await anchorsByIds(workspaceId, ids);
    const holderIds = [...new Set([...anchors.values()].map((a) => a.noteId))];
    const holders = new Map((holderIds.length === 0 ? [] : await db.selectFrom("content_nodes").select(["id", "title", "slug", "markdown", "space_id"])
      .where("workspace_id", "=", workspaceId).where("id", "in", holderIds).where("deleted_at", "is", null).where("node_type", "=", "content").execute())
      .map((h) => [h.id, h]));
    const taken = new Map((await db.selectFrom("block_link_bindings").select(["link_text", "anchor_id"])
      .where("workspace_id", "=", workspaceId).where("note_id", "=", noteId).execute()).map((b) => [b.link_text, b.anchor_id]));

    const left = new Map<LinkLeftReason, number>();
    const refuse = (reason: LinkLeftReason) => { left.set(reason, (left.get(reason) ?? 0) + 1); return null; };
    const bound: Bound[] = [];
    // The same link written twice gets the same words and the one binding.
    const decided = new Map<string, { note: string; words: string } | null>();
    const out = writePartLinks(note.markdown, (link) => {
      const memo = `${link.note}\0${link.id}`;
      if (decided.has(memo)) return decided.get(memo)!;
      const decision = (() => {
        const anchor = anchors.get(link.id);
        const holder = anchor ? holders.get(anchor.noteId) : undefined;
        if (!anchor || !holder) return refuse("target_not_found");
        if (anchor.status !== "valid") return refuse("target_not_valid");
        if (holder.space_id !== note.space_id) return refuse("other_space");
        const words = oldPartLinkWords(blockLinkText(blockExcerptOf(holder.markdown.slice(anchor.from, anchor.to))));
        if (words === "") return refuse("no_words");
        // The note part: as the person wrote it when it names the note that holds the paragraph, else that note's title.
        const namesHolder = link.note === "" ? holder.id === noteId : noteNamer({ id: holder.id, title: holder.title, slug: holder.slug })(link.note);
        const notePart = namesHolder ? link.note : holder.title;
        if (!namesHolder && UNSAFE_TITLE.test(holder.title)) return refuse("unsafe_title");
        for (let n = 1; n < 50; n++) {
          const text = n === 1 ? words : `${words} ${n}`;
          const key = bindingKey(`${notePart}/${text}`);
          const have = taken.get(key);
          if (have === undefined) { taken.set(key, link.id); bound.push({ key, anchorId: link.id, holderId: holder.id }); return { note: notePart, words: text }; }
          if (have === link.id) return { note: notePart, words: text };
        }
        return refuse("no_words");
      })();
      decided.set(memo, decision);
      return decision;
    });
    if (out.count === 0) return { rewritten: 0, left };
    try {
      await updateNode(workspaceId, noteId, { markdown: out.markdown }, {
        actor, baseMarkdown: note.markdown, onConflict: "refuse", keepUpdatedAt: true,
        event: { ...NOTE_EVENT, txMeta: { conversion_batch: batch } },
        within: async () => {
          for (const b of bound) {
            await db.insertInto("block_link_bindings").values({ workspace_id: workspaceId, note_id: noteId, link_text: b.key, anchor_id: b.anchorId }).onConflict((oc) => oc.doNothing()).execute();
            await recordLinkBound(workspaceId, noteId, b.anchorId, b.holderId, actor);
          }
        },
      });
    } catch (error) {
      if (error instanceof BodyConflictError) return { rewritten: 0, left: new Map([["note_changed", out.count]]) };
      throw error;
    }
    return { rewritten: out.count, left };
  });
}

/** Every converted note that still holds an old part link, rewritten. Call from the system job only. */
export async function rewriteOldBlockLinks(actor: ActorCtx, scope: JobScope = {}): Promise<LinkRewriteReport> {
  const report: LinkRewriteReport = { notesRewritten: 0, linksRewritten: 0, left: [] };
  // A note whose own `^id` marks are not converted yet waits (its text may still change shape).
  await walkNotes(scope, sql<boolean>`anchor_form <> 0 AND position('#^' IN markdown) > 0`, async (workspaceId, noteId, batch) => {
    const done = await rewriteNote(actor, workspaceId, noteId, batch);
    if (done === null) return;
    if (done.rewritten > 0) { report.notesRewritten++; report.linksRewritten += done.rewritten; }
    for (const [reason, links] of done.left) report.left.push({ workspaceId, noteId, reason, links });
  }, (workspaceId, noteId, error) => {
    report.left.push({ workspaceId, noteId, reason: "write_failed", links: 0 });
    log.error("block-link-rewrite", "could not rewrite a note's links", { workspaceId, noteId, err: error });
  });
  if (report.notesRewritten > 0 || report.left.length > 0) {
    // Counts only; the notes left are in the report this returns (a person decides those).
    log.info("block-link-rewrite", "pass done", { notes: report.notesRewritten, links: report.linksRewritten, left: report.left.length });
  }
  return report;
}

/** The way back, for one note inside the caller's transaction: every part link of `markdown` that has a binding is
 *  written as `[[筆記#^id]]`, naming the note that holds the paragraph (as written when it names it). Returns the new
 *  text; `markdown` itself when nothing is bound. */
export async function restoreBlockLinks(workspaceId: string, noteId: string, markdown: string): Promise<string> {
  const bindings = await db.selectFrom("block_link_bindings").select(["link_text", "anchor_id"])
    .where("workspace_id", "=", workspaceId).where("note_id", "=", noteId).execute();
  if (bindings.length === 0) return markdown;
  const anchors = await anchorsByIds(workspaceId, bindings.map((b) => b.anchor_id));
  const holderIds = [...new Set([...anchors.values()].map((a) => a.noteId))];
  const holders = holderIds.length === 0 ? [] : await db.selectFrom("content_nodes").select(["id", "title", "slug"])
    .where("workspace_id", "=", workspaceId).where("id", "in", holderIds).execute();
  const holderOf = new Map([...anchors].map(([id, a]) => [id, holders.find((h) => h.id === a.noteId)]));
  const anchorOf = new Map(bindings.map((b) => [b.link_text, b.anchor_id]));
  return restorePartLinks(markdown, (target) => {
    const id = anchorOf.get(bindingKey(target));
    const holder = id ? holderOf.get(id) : undefined;
    if (!id || !holder) return null;
    // `[[/words]]` is the note itself; `[[Name/words]]` names a note by what was written (the longest name that names the holder).
    const reading = linkPathReadings(target).find((r) => r.note === "" ? holder.id === noteId : noteNamer({ id: holder.id, title: holder.title, slug: holder.slug })(r.note));
    return { note: reading ? reading.note : holder.title, id };
  }).markdown;
}
