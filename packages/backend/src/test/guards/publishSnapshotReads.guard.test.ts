// The latest publish snapshot is read for a question about its notes in ONE place
// (modules/website/publishing/latestSnapshot.ts: latestSnapshotRow / storedNote).
// A file that reads a snapshot's note list (`jsonb_array_elements` over its payload)
// must be that file or one of the listed whole-site readers; a new per-note
// lookup goes through storedNote, not a fourth copy of the query.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../modules/website/publishing");
// ratchet:list publish-snapshot-readers
const WHOLE_SITE_READERS = [
  "latestSnapshot.ts", // the single-note read and the latest-snapshot source
  "servedSite.ts", // cuts the whole latest snapshot down to the served notes
  "siteRedirects.ts", // old addresses carried from one snapshot to the next
  "takenDown.ts", // records which of the latest snapshot's notes left the site
];

// ratchet:list publish-snapshot-latest-copies
const OLDER_COPIES = ["diagrams.ts", "servedSite.ts", "siteRedirects.ts", "snapshot.ts"]; // each reads it for its own shape

describe("publish snapshot reads", () => {
  it("only the listed files read a snapshot's notes out of its payload", () => {
    const readers = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => { const text = readFileSync(join(dir, f), "utf8"); return text.includes("publish_snapshots") || text.includes("latestSnapshot"); })
      .filter((f) => /jsonb_array_elements/.test(readFileSync(join(dir, f), "utf8")));
    expect(readers.filter((f) => !WHOLE_SITE_READERS.includes(f)), "use storedNote (latestSnapshot.ts) instead of a new copy of the query").toEqual([]);
  });

  it("no new copy of the latest-snapshot subquery (the listed ones are older and may only go)", () => {
    const copies = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => /FROM publish_snapshots[^`]*ORDER BY (?:p\.)?created_at DESC\s+LIMIT 1/.test(readFileSync(join(dir, f), "utf8")) && f !== "latestSnapshot.ts");
    expect(copies.filter((f) => !OLDER_COPIES.includes(f)), "use latestSnapshotRow (latestSnapshot.ts)").toEqual([]);
  });
});
