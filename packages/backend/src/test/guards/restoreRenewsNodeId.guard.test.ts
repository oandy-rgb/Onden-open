// Pins for docs/architecture/proposals/node-rebase-2026-11-16.md §6 ("the server's own case").
//
// A database restored from an older pg_dump gets back the `sync_node` and `sync_clock` rows it had then, so it goes on numbering its
// writes inside a range other nodes already hold (the "USN rollback" of docs/research/sync-design-vs-literature-2026-11-16.md item 1).
// Today nothing in the restore path gives it a new node id. This file reads the two scripts as text because the real restore is a
// shell script around pg_restore / psql: there is no TypeScript entry to call, and a database test cannot tell "restored" from "never
// restored" (that is the point of the problem). The drill runs the same migrate() as boot and compares tables before and after;
// it never compares or changes `sync_node`.
//
// No product code is involved. The step the proposal names (`packages/backend/scripts/renewNodeId.ts`) does not exist yet; when it does,
// the it.fails below starts to pass, vitest reports it, and whoever lands the step turns it into a plain `it`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

const RESTORE = read("scripts/restore.sh");
const DRILL = read("scripts/restore-drill.sh");
const DRILL_INVARIANTS = read("packages/backend/scripts/drillInvariants.ts");

describe("restore keeps the node id (today's behaviour, pinned)", () => {
  it("neither restore script nor the drill reads or changes the node id of the restored database", () => {
    // sync_node is part of the dump, so pg_restore brings the old node id back unchanged.
    for (const [name, text] of [["restore.sh", RESTORE], ["restore-drill.sh", DRILL]] as const) {
      expect(text, `${name} now mentions the node id: update node-rebase §6 and flip the pins below`).not.toMatch(/sync_node|node[-_ ]?id|renewNodeId/i);
    }
  });

  it("the drill compares the number of stamps (non-decreasing) but not who made them", () => {
    expect(DRILL_INVARIANTS).toMatch(/name: "write_stamps"[^\n]*non-decreasing/);
    expect(DRILL_INVARIANTS).not.toMatch(/sync_node/);
  });
});

describe("restore gives the database a new node id (node-rebase-2026-11-16.md §6; not built)", () => {
  it.fails("scripts/restore.sh runs the node-id renewal after it loads the dump and before the backend starts", () => {
    expect(RESTORE).toMatch(/renewNodeId/);
  });

  it.fails("the restore drill renews the node id on its throwaway database and checks it differs from the one in the backup", () => {
    expect(DRILL).toMatch(/renewNodeId/);
    expect(DRILL_INVARIANTS).toMatch(/node_id_renewed/);
  });
});
