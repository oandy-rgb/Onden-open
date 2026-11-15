// A user note is created in one place (services/noteCreate.ts), so it always
// gets its space check, slug, NODE_CREATED and derived state. Every other
// `INSERT INTO content_nodes` must be a row that is not an ordinary note, and
// is listed here with why. A new insert fails this test until it either goes
// through createNote or is added below with its reason.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..");

const NOT_NOTES: Record<string, string> = {
  "services/noteCreate.ts": "the one note insert",
  "services/tagWrites.ts": "the one tag row insert (class_tag; test/tagWrites.test.ts)",
  "services/siteConfig.ts": "the hidden Site Config row in the system space",
  "services/tasksStore.ts": "task rows: hidden, slug task-<id>, recorded by the caller's TASK_* event",
  // Both still run createNote's derived-state step (newNoteDerived.finishNewNote);
  // what each one skips:
  "services/noteDuplicate.ts": "a copy replays recorded attributes and tags instead of deriving them, deliberately without the dispatcher",
  "services/templateExpander.ts": "template children spawned inside a tag-apply cascade: cascade authority, no attribute dispatch",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

describe("where content rows are inserted", () => {
  it("only createNote inserts a user note; every other insert is a listed system row", () => {
    const inserting = sourceFiles(SRC)
      .filter((path) => /INSERT INTO content_nodes\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).split("\\").join("/"))
      .sort();
    expect(inserting).toEqual(Object.keys(NOT_NOTES).sort());
  });

  it("a file listed for tags inserts only tags, statement by statement", () => {
    for (const file of Object.keys(NOT_NOTES).filter((f) => NOT_NOTES[f]!.includes("(class_tag"))) {
      const src = readFileSync(join(SRC, file), "utf8");
      for (const m of src.matchAll(/INSERT INTO content_nodes\b/g)) {
        // The statement's VALUES (or SELECT) names the node type within a few lines.
        expect(src.slice(m.index!, m.index! + 400), `${file}: an insert that is not a class_tag`).toContain("class_tag");
      }
    }
  });
});
