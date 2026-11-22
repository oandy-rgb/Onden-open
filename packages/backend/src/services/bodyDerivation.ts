// What a note's stored body determines and no stamp carries — the DERIVED half of a body write (docs/architecture/proposals/own-node-transport-2026-11-22.md
// §2.12.2), ONE function for the two places it happens:
//   - a local write: services/bodySideEffects.ts applyBodyChange and services/newNoteDerived.ts finishNewNote call it after the replicated half (the anchors,
//     the paragraph rows and their tags, the task and review marks: blockNodes.ts syncBlockNodes) is written;
//   - a node that took the note by change bundle: services/receivedDerivation.ts calls it for every note whose body, anchors or paragraph rows the bundle
//     changed, after the whole bundle is written (so it reads the merged rows, attributes such as `aliases` included).
// Every input is replicated state (the stored body, the note's anchors and rows, the other notes' titles, slugs, aliases and spaces) and every output is a
// table no stamp watches (spine/syncClasses.json: node_edges rows of origin `wikilink`, note_link_index, note_block_refs, the display columns of block_nodes),
// so the node that wrote and the node that received hold the same rows (test/receivedDerivation.integration.test.ts). It writes no unit: never a row of
// UNIT_SOURCES, never a field the stamp triggers watch (the same test compares every unit and stamp before and after it on the receiving node).
import { syncWikilinkEdges } from "./wikilinkEdges.js";
import { deriveBlockRows } from "./blockNodes.js";
import { syncNoteBlockRefs } from "./noteBlockRefs.js";

/** The note's `[[links]]` (its own edges out and its link index), its paragraph rows' display columns and its anchor id index, from `markdown` (the body as stored).
 *  `retagged`: paragraph rows whose own tags the caller just changed (deriveBlockRows moves their `updated_at`). In the caller's transaction. */
export async function deriveFromBody(workspaceId: string, noteId: string, markdown: string, retagged?: ReadonlySet<string>): Promise<void> {
  await syncWikilinkEdges(workspaceId, noteId, markdown);
  await deriveBlockRows(workspaceId, noteId, markdown, retagged);
  await syncNoteBlockRefs(workspaceId, noteId, markdown);
}
