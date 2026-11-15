// An attribute is written in one place (services/attributeChange.ts), so every
// change carries its event: it syncs to other devices and undoes. The other
// files that write node_attributes directly are listed here with why the row
// is not an ordinary attribute change. A new writer fails this test until it
// goes through recordAttributeChange or is added below with its reason.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..");

const RAW_WRITERS: Record<string, string> = {
  "services/attributeChange.ts": "the one attribute writer",
  "services/eventRestore/attributes.ts": "an undo writes the exact earlier row and records its own inverse event",
  "services/siteConfig.ts": "the hidden Site Config row in the system space",
  "services/tasksStore.ts": "a task row's fields, recorded by the caller's TASK_* event (tasks sync through TASK_* events)",
  "services/standaloneTasks.ts": "a standalone task's _task_* fields, written in its own NODE_CREATED transaction (as tasksStore does for a hosted task)",
  "modules/importers/shared/identity.ts": "the import stamp (_import_*): a derived index, never user content",
  "services/blockNodes.ts": "the _auto_tag marker on a tag a {…} block tag created: derived from the note's text in its own save",
  "services/boardStore.ts": "a board's sections: layout, recorded by the board's own event like card positions",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

describe("where node_attributes rows are written", () => {
  it("only recordAttributeChange writes an attribute; every other writer is listed with its reason", () => {
    const writing = sourceFiles(SRC)
      .filter((path) => /(INSERT INTO|UPDATE|DELETE FROM)\s+node_attributes\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).split("\\").join("/"))
      .sort();
    expect(writing).toEqual(Object.keys(RAW_WRITERS).sort());
  });
});
