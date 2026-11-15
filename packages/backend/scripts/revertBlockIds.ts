// The way back of the block-anchor switch-over (proposal block-anchors-2026-11-01.md §11.3): writes each converted
// note's anchors back into its text as `^id` marks and sets its anchor_form to 0. Run it BEFORE putting the older image
// back (the older app reads `^id` from the text); block_anchors is left as it is, so converting again finds the same ids.
//
//   DATABASE_URL=… tsx scripts/revertBlockIds.ts
//
// Each note is saved like any edit by the system job, restartable and idempotent. Notes it could not turn back are
// listed (counts and workspace/note ids for the operator, never text). Exit code 1 when any note was left.

const { revertBlockIdMarks } = await import("../src/services/blockMarkerRepair.js");
const { pool } = await import("../src/db.js");
const report = await revertBlockIdMarks();
console.log(`turned back: ${report.notesReverted} notes; left as they were: ${report.left.length}`);
for (const l of report.left) console.log(`  ${l.workspaceId} ${l.noteId} ${l.reason}`);
await pool.end();
process.exit(report.left.length > 0 ? 1 : 0);
