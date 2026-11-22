// One-time repair for an inbox deleted before module tags were protected and captured into again afterwards
// (services/strandedInboxRepair.ts). Without --apply it only reports (workspace ids and counts, never text).
//
//   DATABASE_URL=… tsx scripts/repairStrandedInbox.ts            report only
//   DATABASE_URL=… tsx scripts/repairStrandedInbox.ts --apply    put the older captures on the live inbox, per workspace
//
// Not part of boot. Each move is an ordinary TAG_APPLIED by the workspace owner; running it twice moves nothing more.

const { findStrandedInboxes, moveStrandedCaptures } = await import("../src/services/strandedInboxRepair.js");
const { pool } = await import("../src/db.js");
const apply = process.argv.includes("--apply");
const found = await findStrandedInboxes();
console.log(`workspaces with older captures on a deleted inbox: ${found.length}`);
for (const f of found) console.log(`  ${f.workspaceId}: ${f.noteIds.length} captures`);
let code = 0;
if (apply) {
  for (const f of found) {
    const done = await moveStrandedCaptures(f.workspaceId);
    console.log(`  ${f.workspaceId}: moved ${done.moved}, left ${done.left.length}`);
    for (const l of done.left) console.log(`    left ${l.nodeId}: ${l.reason}`);
    if (done.left.length > 0) code = 1;
  }
}
await pool.end();
process.exit(code);
