// Who may see a note moves with its `hidden` flag, its space and (for a
// collection row) its collection membership. Every such write must tell
// modules (the published site), in its transaction: mutate({
// visibilityChanged }) / nodeVisibilityCommitted, or spaceAudienceCommitted
// for a space move (spine/nodeHooks.ts). This scan fails when a file
// writes one without any of those (unless listed in QUIET with why), so a new
// path cannot quietly leave a page on the site.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..");

/** A literal `UPDATE content_nodes SET … hidden =` or `… space_id =`, or a
 *  tag membership write (a collection row joining or leaving it). */
const WRITES = /UPDATE\s+content_nodes\s+SET[^`]*\b(hidden|space_id)\s*=|(INSERT INTO|DELETE FROM)\s+node_tags\b/;
/** Membership writers that tell elsewhere, or write rows no site serves. */
const QUIET: Record<string, string> = {
  "services/tagMembershipWrites.ts": "its TAG_APPLIED / TAG_REMOVED (services/tagMembershipWrites.ts) declare visibilityChanged",
  "services/siteConfig.ts": "tags the hidden Site Config row in the system space; never served as content",
  "services/tagMerge.ts": "links #target only to notes in the trash, which no site serves; restoring one tells (services/nodeTrash.ts)",
  "services/standaloneTasks.ts": "tags a standalone task with #task as it is created; tasks are not published",
  "services/tasksStore.ts": "tags a task row with #task; tasks are not published",
};
/** Writers that build the column list at run time (set("hidden", …), the
 *  undo's scalar fields): checked by name. */
const DYNAMIC_WRITERS = ["services/nodeUpdate.ts", "services/eventRestore/restore.ts"];
const TELLS = /visibilityChanged|nodeVisibilityCommitted|spaceAudienceCommitted/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

describe("who writes a note's visibility tells modules", () => {
  it("every file writing hidden or space_id declares or fires the visibility hook", () => {
    const writers = sourceFiles(SRC).filter((path) => {
      const rel = relative(SRC, path).split("\\").join("/");
      return DYNAMIC_WRITERS.includes(rel) || WRITES.test(readFileSync(path, "utf8"));
    });
    expect(writers.length).toBeGreaterThanOrEqual(DYNAMIC_WRITERS.length + 3); // the scan still finds the literal writers
    const silent = writers.filter((path) => !TELLS.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).split("\\").join("/"))
      .filter((rel) => !(rel in QUIET));
    expect(silent).toEqual([]);
  });
});
