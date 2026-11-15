// The `[[links]]` of restored notes (services/backupRestore.ts, last batch).
//
// Notes are restored one after another, and a note in the trash is restored as a
// live note first and deleted after. Deriving each note's links as it is written
// therefore resolves `[[Title]]` against whatever exists at that moment: a live
// note and its trashed twin both carry the title, so the link finds both. The
// links are set once, when everything is in place:
//   * a backup that recorded them (`wikilinks` on the note, format 2) gets exactly
//     those edges back — the links as the source had them, which for a note in
//     the trash are the ones it kept when it was deleted;
//   * an older backup did not: a live note's links are derived again from its body
//     by the one rule (wikilinkEdges.ts syncWikilinkEdges), and a note in the
//     trash keeps none to a live note (what it pointed at when deleted is unknown;
//     pointing at a same-named live twin would be a guess).

import { db } from "../dbKysely.js";
import { syncWikilinkEdges } from "./wikilinkEdges.js";

export type RestoredLinks = {
  /** The restored note. */
  id: string;
  deleted: boolean;
  /** Where its `[[links]]` pointed in the source, as ids here; undefined = not recorded. */
  targets: string[] | undefined;
};

export async function settleWikilinkEdges(workspaceId: string, notes: RestoredLinks[]): Promise<void> {
  for (const note of notes) {
    if (note.targets) {
      await db.deleteFrom("node_edges").where("workspace_id", "=", workspaceId).where("source_node_id", "=", note.id).where("origin", "=", "wikilink").execute();
      for (const target of new Set(note.targets)) {
        if (target === note.id) continue;
        const exists = await db.selectFrom("content_nodes").select("id").where("id", "=", target).where("workspace_id", "=", workspaceId).executeTakeFirst();
        if (!exists) continue;
        await db.insertInto("node_edges").values({
          workspace_id: workspaceId, source_node_id: note.id, target_node_id: target, edge_type: "knowledge_link", status: "active", origin: "wikilink",
        }).onConflict((conflict) => conflict.doNothing()).execute();
      }
    } else if (note.deleted) {
      await db.deleteFrom("node_edges").where("workspace_id", "=", workspaceId).where("source_node_id", "=", note.id).where("origin", "=", "wikilink")
        .where("target_node_id", "in", db.selectFrom("content_nodes").select("id").where("deleted_at", "is", null)).execute();
    } else {
      const row = await db.selectFrom("content_nodes").select("markdown").where("id", "=", note.id).executeTakeFirst();
      await syncWikilinkEdges(workspaceId, note.id, row?.markdown ?? "");
    }
  }
}
