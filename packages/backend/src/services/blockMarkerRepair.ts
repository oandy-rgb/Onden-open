// Gives a tagged paragraph back its row when text typed under its `{…} ^id` left the marker mid-paragraph, then moves
// every remaining `^id` out of the notes' text (services/blockIdMigration.ts — the same system job, so one actor).
//
// 2026-11-07 (Android 注音): `我發現不 {複習} ^18ee1c`, Enter once, then typing — Markdown still reads one
// paragraph, whose tag line is its LAST line, so the `{…} ^id` became plain text and syncBlockNodes hid the
// paragraph's block_nodes row (tags, review card). The editor no longer lets that happen (Enter after `{…}` opens a
// new paragraph); this puts back what it already did, and keeps catching it from older clients.
//
// A candidate is certain, not guessed: a HIDDEN block node (text is in its note: detached_note_id is null) whose
// `^ref` still sits in its note's body. @onden/markdown repairSplitBlockMarker moves the marker, unchanged, to the
// paragraph's last line and checks the result parses as that block with those tags; anything it cannot show is left
// alone and reported. The change is an ordinary NODE_UPDATED by the system job, written with the note's own base so a
// newer edit is merged, never overwritten; the note keeps its `updated_at`. Re-running finds nothing to do.

import { repairSplitBlockMarker } from "@onden/markdown";
import { sql } from "kysely";
import { db } from "../dbKysely.js";
import { log } from "../logger.js";
import { systemActorFor } from "../spine/systemJobs.js";
import { BodyConflictError, updateNode } from "./nodeUpdate.js";
import { convertBlockIds, revertBlockIds, type ConversionReport, type RevertReport } from "./blockIdMigration.js";
import type { JobScope } from "./blockPass.js";
import { rewriteOldBlockLinks, type LinkRewriteReport } from "./blockLinkRewrite.js";

import { liveNodeSql } from "../spine/nodeSql.js";
export type SkippedMarker = { workspaceId: string; noteId: string; reason: "cannot_decide" | "note_changed" | "write_failed" };
export type MarkerRepairReport = { notesRepaired: number; markersRepaired: number; skipped: SkippedMarker[]; conversion: ConversionReport; links: LinkRewriteReport };

type Candidate = { workspace_id: string; note_id: string; refs: string[] };

export async function repairBlockMarkers(scope: JobScope = {}): Promise<MarkerRepairReport> {
  const candidates = (await sql<Candidate>`SELECT b.workspace_id::text, b.note_id::text, array_agg(b.block_ref ORDER BY b.block_ref) AS refs
       FROM block_nodes b JOIN content_nodes n ON n.id = b.note_id AND n.workspace_id = b.workspace_id
      WHERE b.hidden_at IS NOT NULL AND b.detached_note_id IS NULL AND ${sql.raw(liveNodeSql("n"))} AND n.node_type = 'content'
        AND position('^' || b.block_ref IN n.markdown) > 0
        ${scope.workspaceId === undefined ? sql`` : sql`AND b.workspace_id = ${scope.workspaceId}`}
      GROUP BY b.workspace_id, b.note_id`.execute(db)).rows;
  const report: MarkerRepairReport = { notesRepaired: 0, markersRepaired: 0, skipped: [], conversion: { notesConverted: 0, anchorsMade: 0, idsChanged: 0, left: [] }, links: { notesRewritten: 0, linksRewritten: 0, left: [] } };
  const actor = systemActorFor("block-marker-repair");
  for (const c of candidates) {
    const where = { workspaceId: c.workspace_id, noteId: c.note_id };
    const note = await db.selectFrom("content_nodes").select("markdown")
      .where("workspace_id", "=", c.workspace_id).where("id", "=", c.note_id).where("deleted_at", "is", null).executeTakeFirst();
    if (!note) continue;
    let fixed = note.markdown;
    let count = 0;
    for (const ref of c.refs) {
      const next = repairSplitBlockMarker(fixed, ref);
      if (next === null) continue;
      fixed = next; count++;
    }
    if (count < c.refs.length) report.skipped.push({ ...where, reason: "cannot_decide" });
    if (count === 0) continue;
    try {
      await updateNode(c.workspace_id, c.note_id, { markdown: fixed }, {
        actor, baseMarkdown: note.markdown, keepUpdatedAt: true, onConflict: "refuse",
        event: { uiContext: "system.block_marker_repair", cascadeLabel: "block-marker-repair.cascade", backupPrefix: "NODE_UPDATED" },
      });
      report.notesRepaired++; report.markersRepaired += count;
    } catch (error) {
      // A newer edit overlapped the paragraph: leave the note to the next pass rather than force it.
      const reason = error instanceof BodyConflictError ? "note_changed" : "write_failed";
      report.skipped.push({ ...where, reason });
      if (reason === "write_failed") log.error("block-marker-repair", "could not repair a note", { ...where, err: error });
    }
  }
  // After the repair, so a marker the repair put back on a paragraph's last line is converted with the rest.
  report.conversion = await convertBlockIds(actor, scope);
  // Then the links to those paragraphs: `[[筆記#^id]]` → `[[筆記/段落開頭]]` with its binding (services/blockLinkRewrite.ts).
  report.links = await rewriteOldBlockLinks(actor, scope);
  if (report.notesRepaired > 0 || report.skipped.length > 0) {
    // Counts only: the skipped notes are listed in the report this returns (a person decides those).
    log.info("block-marker-repair", "pass done", { notes: report.notesRepaired, markers: report.markersRepaired, skipped: report.skipped.length });
    for (const s of report.skipped) log.warn("block-marker-repair", "left as it is", { ...s });
  }
  return report;
}

/** The way back (proposal §11.3), run by hand from scripts/revertBlockIds.ts: `^id` marks written into converted notes. */
export function revertBlockIdMarks(scope: JobScope = {}): Promise<RevertReport> {
  return revertBlockIds(systemActorFor("block-marker-repair"), scope);
}
