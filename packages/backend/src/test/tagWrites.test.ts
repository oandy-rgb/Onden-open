// A tag row and its schema are written in one place (services/tagWrites.ts),
// so every tag gets the same slug, columns and schema shape, and every schema
// change goes through one UPDATE (depth audit 2026-10-15, D1). A new
// `INSERT … class_tag` or tag_schema write elsewhere fails this test until it
// uses tagWrites or is listed below with its reason.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..");

const TAG_INSERTS: Record<string, string> = {
  "services/tagWrites.ts": "insertTagRow, the one tag insert",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

const files = () => sourceFiles(SRC).map((path) => ({
  file: relative(SRC, path).split("\\").join("/"),
  src: readFileSync(path, "utf8"),
}));

describe("where tag rows are written", () => {
  it("only tagWrites inserts a class_tag row", () => {
    const inserting = files()
      .filter(({ src }) => [...src.matchAll(/INSERT INTO content_nodes\b/g)]
        .some((m) => src.slice(m.index!, m.index! + 400).includes("'class_tag'")))
      .map(({ file }) => file)
      .sort();
    expect(inserting).toEqual(Object.keys(TAG_INSERTS).sort());
  });

  it("only tagWrites writes tag_schema", () => {
    const writing = files()
      .filter(({ src }) => /SET\s+(?:[^;`]*,\s*)?tag_schema\s*=/i.test(src))
      .map(({ file }) => file);
    expect(writing).toEqual(["services/tagWrites.ts"]);
  });
});
