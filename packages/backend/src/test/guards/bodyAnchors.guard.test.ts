// Guard: block anchors move only inside the body's write transaction, via applyBodyChange.
// Code that rewrites an existing note's body (UPDATE content_nodes SET markdown …) must go through
// services/bodySideEffects.applyBodyChange, or be on the list below. The list may only shrink:
// an entry would leave its note's anchors with a stale body hash — they are found again by their
// quoted text on the next write (blockAnchors/mapping.ts), so nothing points wrong, but a link may
// read "maybe here" until then. Today the list is empty: every other writer (agent tools, suggestions,
// task lines, import, rewind, block→child note…) calls services/nodeUpdate.updateNode, which calls
// applyBodyChange.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { seedQ } from "../helpers/seedQ.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === "test") return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.(test|generated)\.ts$/.test(name) ? [path] : [];
  });
}

/** Whether the file has an UPDATE of content_nodes that assigns markdown (SQL literal or a dynamic `set("markdown"`). */
function writesBody(text: string): boolean {
  for (const m of text.matchAll(/UPDATE\s+content_nodes(?:\s+AS\s+\w+)?\s+SET([\s\S]*?)(?:WHERE|RETURNING|`|")/g)) {
    if (/(^|[\s,])(?:\w+\.)?markdown\s*=/.test(m[1]!)) return true;
  }
  // A SET list built in code: sets.push(`markdown = $2`).
  if (/["'`]markdown\s*=\s*\$/.test(text)) return true;
  return /\bset\(\s*["']markdown["']/.test(text);
}

// ratchet:list body-write-without-anchor-move
const NOT_YET_MOVING_ANCHORS: readonly string[] = [];

// The body-writing paths the proposal names (§4.4, from the experiment report §6) and what each does today.
// Every one reaches the body through updateNode / applyBodyChange, or does not rewrite an existing body.
const PROPOSAL_WRITERS: Record<string, "via updateNode" | "applyBodyChange" | "creates notes only" | "no body write"> = {
  "services/nodeUpdate.ts": "applyBodyChange",
  "services/eventRestore/restore.ts": "applyBodyChange",
  "services/history/rewind.ts": "via updateNode",
  "services/history/agentRunUndo.ts": "via updateNode",
  "services/agentTools/updateNode.ts": "via updateNode",
  "services/agentTools/suggestEdit.ts": "no body write",
  "services/agentTools/editArgs.ts": "no body write",
  "services/aiSuggestions.ts": "via updateNode",
  "services/agentRuntime/api/tools.ts": "via updateNode",
  "services/agentRuntime/api/deliver.ts": "no body write",
  "modules/importers/markdown/note.ts": "via updateNode",
  "modules/importers/notion/database.ts": "applyBodyChange",
  "modules/rss/save.ts": "creates notes only",
  "modules/tasks/focus.ts": "via updateNode",
  "modules/tasks/placement.ts": "via updateNode",
  "modules/tasks/lines.ts": "via updateNode",
  "services/dayNotes.ts": "via updateNode",
  "services/dispatcherQueue.ts": "via updateNode",
  "services/noteDuplicate.ts": "creates notes only",
};

describe("the guard's detector", () => {
  it("sees every way the repo writes a body, and not the other columns", () => {
    expect(writesBody("await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`)")).toBe(true);
    expect(writesBody("await seedQ(`UPDATE content_nodes SET title = $2, markdown = $3, updated_at = now() WHERE id = $1`)")).toBe(true);
    expect(writesBody("`UPDATE content_nodes AS n\n   SET n.markdown = $3\n WHERE n.id = $1`")).toBe(true);
    expect(writesBody("`UPDATE content_nodes\n  SET slug = $2\n  WHERE id = $1`")).toBe(false);
    expect(writesBody("`UPDATE content_nodes SET collection_views = $3 WHERE id = $1`")).toBe(false);
    expect(writesBody("`UPDATE other_table SET markdown = $2 WHERE id = $1`")).toBe(false);
    expect(writesBody("set(\"markdown\", next)")).toBe(true);
    expect(writesBody("sets.push(`markdown = $${values.length}`);")).toBe(true);
  });

  it("a file that writes a body without the shared entry is reported", () => {
    const rogue = "async function f() { await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [id, text]); }";
    expect(writesBody(rogue) && !rogue.includes("applyBodyChange")).toBe(true);
    const careful = rogue + "\nawait applyBodyChange({});";
    expect(writesBody(careful) && !careful.includes("applyBodyChange")).toBe(false);
  });
});

describe("the write paths the proposal names (§4.4)", () => {
  for (const [file, how] of Object.entries(PROPOSAL_WRITERS)) {
    it(`${file}: ${how}`, () => {
      const text = readFileSync(join(SRC, file), "utf8");
      if (how === "applyBodyChange") expect(text).toContain("applyBodyChange");
      else if (how === "via updateNode") expect(text, "改內文要走 updateNode").toMatch(/\bupdateNode\b/);
      else expect(writesBody(text), "不該自己改既有筆記的內文").toBe(false);
      // Whatever the route, no file on the list rewrites a body behind the entry's back.
      if (how !== "applyBodyChange") expect(writesBody(text)).toBe(false);
    });
  }
});

describe("block anchors move in one place", () => {
  const writers = sources(SRC).filter((f) => writesBody(readFileSync(f, "utf8"))).map((f) => relative(SRC, f)).sort();

  it("every body-writing file calls applyBodyChange or is on the shrinking list", () => {
    const missing = writers.filter((f) => !readFileSync(join(SRC, f), "utf8").includes("applyBodyChange") && !NOT_YET_MOVING_ANCHORS.includes(f));
    expect(missing, "這些檔改了筆記內文卻沒經過 applyBodyChange（services/bodySideEffects.ts）：錨點不會跟著搬。請改走共用入口。").toEqual([]);
  });

  it("the list names only files that still write a body without the shared entry", () => {
    const stale = NOT_YET_MOVING_ANCHORS.filter((f) => !writers.includes(f) || readFileSync(join(SRC, f), "utf8").includes("applyBodyChange"));
    expect(stale, "這些檔已經改好或不再寫內文，請從清單移除。").toEqual([]);
  });

  it("only services/blockAnchors touches the block_anchors table", () => {
    const offenders = sources(SRC).map((f) => relative(SRC, f))
      .filter((f) => !f.startsWith("services/blockAnchors/") && /\bblock_anchors\b/.test(readFileSync(join(SRC, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

// The snapshot import (spine/stampedImport.ts) writes bodies too, and the detector above cannot see it: it builds its INSERT from the
// table list (spine/snapshotTables.json), so no `UPDATE content_nodes SET markdown` is in its text. It is a COPY of a workspace into an
// empty database: the note rows and the block_anchors / block_link_bindings rows travel together, exactly as the source held them
// (anchors keep the body hash they were made against), so no anchor needs to move. Named here so that stays a decision, not a blind spot.
describe("the snapshot import copies bodies and their anchors together", () => {
  it("carries the note rows and both anchor tables, from the one list the import reads", async () => {
    const { SNAPSHOT_SPECS } = await import("../../spine/snapshotTables.js");
    const carried = SNAPSHOT_SPECS.map((s) => s.table);
    for (const table of ["content_nodes", "block_anchors", "block_link_bindings"]) expect(carried, table).toContain(table);
    const text = readFileSync(join(SRC, "spine/stampedImport.ts"), "utf8");
    expect(writesBody(text), "the import writes the table list's rows; a literal body UPDATE here would bypass applyBodyChange").toBe(false);
    expect(text).toContain("SNAPSHOT_SPECS");
  });
});
