// Moving block identity out of the text, one note at a time (docs/architecture/proposals/block-anchors-2026-11-01.md
// §11; migration 180 adds the progress column `content_nodes.anchor_form`).
//
// Before: a paragraph was known by an `^id` written in its note's body. After: by its anchor (the anchor table), and the
// body carries no mark. This file is the one place that reads old marks out of existing notes:
//
//   convertBlockIds   every note with anchor_form = 0: each `^id` becomes an anchor of the SAME id on the block that
//                     carried it, and the mark leaves the text. The note is saved like any edit (updateNode: version,
//                     merge, event, derived state) by the system job's actor, with `keepUpdatedAt` so no "recent"
//                     list is reordered. Restartable and idempotent: a converted note has no mark to find, a crash
//                     rolls the note's own transaction back, and the next pass takes it again.
//   revertBlockIds    the way back (proposal §11.3): writes each valid anchor's `^id` into the text again and sets
//                     anchor_form to 0; the anchors are not touched, so converting again finds the same ids.
//
// What keeps the data: `block_nodes.block_ref` has always been the id the block was known by, and it stays — the
// anchor takes that id, so the row, its task, review schedule, tags, citations and every `[[Note#^id]]` link keep
// working without being rewritten. Where that id cannot be the anchor's (another note's anchor has it already, or an
// id is repeated in one note) the block gets a new id and its row follows it; those are counted in the report.
//
// What it will not guess: a note whose text cannot be shown to read as the same blocks without its marks
// (@onden/markdown stripLegacyIds refuses: a hashtag block that exists only through its `^id`, a body too long to
// read) is marked anchor_form = 2 and listed in the report for a person.
//
// The actor is passed in: the system job (services/blockMarkerRepair.ts) is the only caller that makes one.

import { randomUUID } from "node:crypto";
import { stripLegacyIds, writeLegacyIds, type LegacyIdRefusal } from "@onden/markdown";
import { sql } from "kysely";
import { db } from "../dbKysely.js";
import { log } from "../logger.js";
import type { ActorCtx } from "../types.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { anchorHolderNote, freeAnchorId, noteAnchorRanges, renameAnchor, type AdoptAnchor } from "./blockAnchors/index.js";
import { BodyConflictError, updateNode } from "./nodeUpdate.js";
import { restoreBlockLinks } from "./blockLinkRewrite.js";
import { walkNotes, type JobScope } from "./blockPass.js";

export type LeftAlone = {
  workspaceId: string; noteId: string;
  reason: LegacyIdRefusal | "note_changed" | "write_failed";
};
export type ConversionReport = {
  notesConverted: number; anchorsMade: number;
  /** Ids that could not stay as written (taken by another note's anchor, or repeated): the block got a new one. */
  idsChanged: number;
  left: LeftAlone[];
};

const NOTE_EVENT = { uiContext: "system.block_id_migration", cascadeLabel: "block-id-migration.cascade", backupPrefix: "NODE_UPDATED" } as const;

/** One note's conversion, in its own transaction. */
async function convertNote(
  actor: ActorCtx, workspaceId: string, noteId: string, batch: string,
): Promise<{ made: number; changed: number } | { left: LeftAlone["reason"] } | null> {
  return withEventTransaction(workspaceId, async () => {
    const note = await db.selectFrom("content_nodes").select(["markdown", "anchor_form"])
      .where("workspace_id", "=", workspaceId).where("id", "=", noteId).where("deleted_at", "is", null).where("node_type", "=", "content")
      .forUpdate().executeTakeFirst();
    if (!note || note.anchor_form !== 0) return null;
    const mark = (form: 1 | 2) => db.updateTable("content_nodes").set({ anchor_form: form })
      .where("workspace_id", "=", workspaceId).where("id", "=", noteId).execute();

    const out = stripLegacyIds(note.markdown);
    if ("refused" in out) { await mark(2); return { left: out.refused }; }
    if (out.anchors.length === 0) { await mark(1); return { made: 0, changed: 0 }; }

    // Which id each block ends up with, and what already holds it.
    const rows = new Map((await db.selectFrom("block_nodes").select(["id", "block_ref", "anchor_id"])
      .where("workspace_id", "=", workspaceId).where("note_id", "=", noteId).execute()).map((r) => [r.block_ref, r]));
    const own = new Set((await noteAnchorRanges(workspaceId, noteId)).map((a) => a.id));
    const adopt: AdoptAnchor[] = [];
    let changed = 0;
    for (const a of out.anchors) {
      if (a.repeat) { changed++; continue; } // a second block with the id: the note's sync gives it an anchor of its own
      const text = out.markdown.slice(a.from, a.to);
      const row = rows.get(a.id);
      let id = a.id;
      const holder = await anchorHolderNote(workspaceId, id);
      if (holder !== null && holder !== noteId) {
        // Another note's anchor has this id (ids were unique per note, anchors are per workspace): this block takes a new one.
        id = await freeAnchorId(workspaceId);
        changed++;
        if (row) await db.updateTable("block_nodes").set({ block_ref: id, anchor_id: id }).where("id", "=", row.id).execute();
        adopt.push({ anchorId: id, text, at: a.from, kind: "new" });
        continue;
      }
      if (holder === null && row?.anchor_id && row.anchor_id !== id && own.has(row.anchor_id)) {
        // The row already had a shadow anchor (made while `^id` was still the identity): it takes the id the row is known by.
        const shadow = row.anchor_id;
        if (await renameAnchor(workspaceId, noteId, shadow, id)) {
          await db.updateTable("block_nodes").set({ anchor_id: id }).where("id", "=", row.id).execute();
          own.delete(shadow); own.add(id);
          adopt.push({ anchorId: id, text, at: a.from, kind: "return" });
          continue;
        }
      }
      adopt.push({ anchorId: id, text, at: a.from, kind: holder !== null ? "return" : "new" });
    }

    try {
      await updateNode(workspaceId, noteId, { markdown: out.markdown }, {
        actor, baseMarkdown: note.markdown, onConflict: "refuse", keepUpdatedAt: true, adoptAnchors: adopt,
        event: { ...NOTE_EVENT, txMeta: { conversion_batch: batch } },
        within: async () => { await mark(1); },
      });
    } catch (error) {
      if (error instanceof BodyConflictError) return { left: "note_changed" as const };
      throw error;
    }
    return { made: adopt.filter((x) => x.kind === "new").length, changed };
  });
}

/** Every note still holding `^id` marks, converted. Call from the system job only. */
export async function convertBlockIds(actor: ActorCtx, scope: JobScope = {}): Promise<ConversionReport> {
  const report: ConversionReport = { notesConverted: 0, anchorsMade: 0, idsChanged: 0, left: [] };
  // A note without a `^` anywhere has nothing to convert; so are the rows that are not notes. Marked per workspace, in
  // that workspace's event transaction (a flag, not a change: no event, no new version, `updated_at` untouched).
  const workspaces = await db.selectFrom("content_nodes").select("workspace_id").distinct().where("anchor_form", "=", 0)
    .$if(scope.workspaceId !== undefined, (qb) => qb.where("workspace_id", "=", scope.workspaceId!)).execute();
  for (const { workspace_id: workspaceId } of workspaces) {
    await withEventTransaction(workspaceId, async () => {
      await db.updateTable("content_nodes").set({ anchor_form: 1 }).where("workspace_id", "=", workspaceId).where("anchor_form", "=", 0)
        .where((eb) => eb.or([eb("node_type", "<>", "content"), sql<boolean>`position('^' IN markdown) = 0`])).execute();
    });
  }
  await walkNotes(scope, sql<boolean>`anchor_form = 0`, async (workspaceId, noteId, batch) => {
    const done = await convertNote(actor, workspaceId, noteId, batch);
    if (done === null) return;
    if ("left" in done) { report.left.push({ workspaceId, noteId, reason: done.left }); return; }
    report.notesConverted++; report.anchorsMade += done.made; report.idsChanged += done.changed;
  }, (workspaceId, noteId, error) => {
    report.left.push({ workspaceId, noteId, reason: "write_failed" });
    log.error("block-id-migration", "could not convert a note", { workspaceId, noteId, err: error });
  });
  if (report.notesConverted > 0 || report.left.length > 0) {
    // Counts only; the notes left are in the report this returns (a person decides those).
    log.info("block-id-migration", "pass done", { notes: report.notesConverted, anchors: report.anchorsMade, idsChanged: report.idsChanged, left: report.left.length });
    for (const l of report.left) log.warn("block-id-migration", "left as it is", { ...l });
  }
  return report;
}

export type RevertReport = { notesReverted: number; left: Array<{ workspaceId: string; noteId: string; reason: "anchors_not_placeable" | "note_changed" | "write_failed" }> };

/** The way back: the valid anchors' `^id`s written into converted notes, which then count as unconverted again, and
 *  every bound part link `[[筆記/段落開頭]]` written as `[[筆記#^id]]` (the older app reads only that). */
export async function revertBlockIds(actor: ActorCtx, scope: JobScope = {}): Promise<RevertReport> {
  const report: RevertReport = { notesReverted: 0, left: [] };
  const todo = await db.selectFrom("content_nodes as n").select(["n.workspace_id", "n.id"])
    .where("n.node_type", "=", "content").where("n.deleted_at", "is", null)
    .where((eb) => eb.or([eb("n.anchor_form", "=", 1), eb.exists(eb.selectFrom("block_link_bindings as l").select("l.note_id").whereRef("l.note_id", "=", "n.id"))]))
    .$if(scope.workspaceId !== undefined, (qb) => qb.where("n.workspace_id", "=", scope.workspaceId!))
    .orderBy("n.workspace_id").orderBy("n.id").execute();
  const batch = randomUUID();
  for (const { workspace_id: workspaceId, id: noteId } of todo) {
    try {
      const reason = await withEventTransaction(workspaceId, async () => {
        const note = await db.selectFrom("content_nodes").select(["markdown", "anchor_form"])
          .where("workspace_id", "=", workspaceId).where("id", "=", noteId).where("deleted_at", "is", null)
          .forUpdate().executeTakeFirst();
        if (!note) return null;
        const converted = note.anchor_form === 1;
        let markdown = note.markdown;
        if (converted) {
          const anchors = await noteAnchorRanges(workspaceId, noteId);
          const written = writeLegacyIds(note.markdown, anchors);
          // Valid anchors are all marks the old text needs; if none could be written (or the set did not read back),
          // the note is not turned back on a guess.
          if (anchors.length > 0 && written.written.length === 0) return "anchors_not_placeable" as const;
          markdown = written.markdown;
        }
        markdown = await restoreBlockLinks(workspaceId, noteId, markdown);
        const unconvert = () => db.updateTable("content_nodes").set({ anchor_form: 0 }).where("workspace_id", "=", workspaceId).where("id", "=", noteId).execute();
        try {
          if (markdown !== note.markdown) {
            await updateNode(workspaceId, noteId, { markdown }, {
              actor, baseMarkdown: note.markdown, onConflict: "refuse", keepUpdatedAt: true,
              event: { uiContext: "system.block_id_revert", cascadeLabel: "block-id-migration.cascade", backupPrefix: "NODE_UPDATED", txMeta: { conversion_batch: batch } },
              within: async () => { if (converted) await unconvert(); },
            });
          } else if (converted) {
            await unconvert();
          }
        } catch (error) {
          if (error instanceof BodyConflictError) return "note_changed" as const;
          throw error;
        }
        return "done" as const;
      });
      if (reason === null) continue;
      if (reason === "done") report.notesReverted++;
      else report.left.push({ workspaceId, noteId, reason });
    } catch (error) {
      report.left.push({ workspaceId, noteId, reason: "write_failed" });
      log.error("block-id-migration", "could not revert a note", { workspaceId, noteId, err: error });
    }
  }
  if (report.notesReverted > 0 || report.left.length > 0) {
    log.info("block-id-migration", "revert pass done", { notes: report.notesReverted, left: report.left.length });
  }
  return report;
}
