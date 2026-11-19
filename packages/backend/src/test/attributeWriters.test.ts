// An attribute is written in one place (services/attributeChange.ts), so every
// change carries its event: it syncs to other devices and undoes. The other
// files that write node_attributes directly are listed here with why the row
// is not an ordinary attribute change. A new writer fails this test until it
// goes through recordAttributeChange or is added below with its reason.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { newNoteProof, provesNewNote } from "../services/newNoteProof.js";

const SRC = join(import.meta.dirname, "..");

const RAW_WRITERS: Record<string, string> = {
  "services/attributeChange.ts": "the one attribute writer (storeAttributeState; an undo writes the earlier row through it too)",
  "services/siteConfig.ts": "the hidden Site Config row in the system space",
  "services/tasksStore.ts": "a task's `_task_*` fields, recorded by the caller as ATTRIBUTE_SET / ATTRIBUTE_DELETED on the reserved key (modules/tasks/update.ts)",
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
      // raw SQL and the Kysely builder (PR #1856 round 5: the regex saw only the first)
      .filter((path) => /(INSERT INTO|UPDATE|DELETE FROM)\s+node_attributes\b|\.(insertInto|updateTable|deleteFrom)\(\s*["'`]node_attributes["'`]/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).split("\\").join("/"))
      .sort();
    expect(writing).toEqual(Object.keys(RAW_WRITERS).sort());
  });

  it("「不發布」 carried onto a new note is written for anyone only with a proof minted where that note was inserted, and only three places mint one", () => {
    // services/newNoteProof.ts: attributeChange.ts lets a non-person write `_published` 'false' only with a proof for that very note. A proof is
    // minted right after an INSERT of the note (round 6: a boolean let a re-import set it on an existing note).
    const MINTERS = ["services/noteCreate.ts", "services/noteDuplicate.ts", "services/templateExpander.ts"];
    const minting = sourceFiles(SRC).filter((path) => /\bnewNoteProof\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).split("\\").join("/")).filter((f) => f !== "services/newNoteProof.ts").sort();
    expect(minting).toEqual(MINTERS);
    // each proof is minted in the same function as an INSERT of a note that comes before it, and for an id that INSERT is given (round 7)
    for (const file of MINTERS) {
      const source = ts.createSourceFile(file, readFileSync(join(SRC, file), "utf8"), ts.ScriptTarget.Latest, true);
      const mints: ts.CallExpression[] = [];
      const find = (n: ts.Node) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "newNoteProof") mints.push(n); ts.forEachChild(n, find); };
      find(source);
      expect(mints.length, file).toBeGreaterThan(0);
      for (const mint of mints) {
        const id = mint.arguments[0];
        expect(id && ts.isIdentifier(id), `${file}: newNoteProof is given the inserted id by name`).toBe(true);
        let fn: ts.Node | undefined = mint.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        const inserts: ts.CallExpression[] = [];
        const collect = (n: ts.Node) => {
          // an INSERT of a note whose first column is its id
          if (ts.isCallExpression(n) && n.getStart() < mint.getStart() && /INSERT INTO content_nodes\s*\(\s*id\s*,/.test(n.arguments[0]?.getText(source) ?? "")) inserts.push(n);
          // a nested function is another function: its inserts are not this one's
          if (n !== fn && ts.isFunctionLike(n)) return;
          ts.forEachChild(n, collect);
        };
        collect(fn!);
        // ... and the proof is for the value that INSERT stores as the id (its first parameter)
        const given = inserts.some((call) => call.arguments.slice(1).some((arg) => ts.isArrayLiteralExpression(arg) && arg.elements[0] !== undefined
          && ts.isIdentifier(arg.elements[0]) && arg.elements[0].text === (id as ts.Identifier).text));
        expect(given, `${file}: newNoteProof(${(id as ts.Identifier).text}) follows, in its function, an INSERT of a note whose id is ${(id as ts.Identifier).text}`).toBe(true);
      }
    }
  });

  it("a proof cannot be made by hand: a copy of a real one, or one for another id, proves nothing", () => {
    const real = newNoteProof("note-a");
    expect(provesNewNote(real, "note-a")).toBe(true);
    expect(provesNewNote(real, "note-b")).toBe(false);
    const copy = Object.assign(Object.create(Object.getPrototypeOf(real)), real, { nodeId: "note-b" }) as typeof real;
    for (const symbol of Object.getOwnPropertySymbols(real)) Object.defineProperty(copy, symbol, { value: (real as never)[symbol] });
    expect(provesNewNote(copy, "note-b")).toBe(false);
    expect(provesNewNote({ nodeId: "note-a" } as never, "note-a")).toBe(false);
  });

  it("the publish mark has one writer: none of the other listed files names it (a person's to set or clear, storeAttributeState; PR #1856 round 4)", () => {
    for (const file of Object.keys(RAW_WRITERS).filter((f) => f !== "services/attributeChange.ts")) {
      expect(/PUBLISHED_KEY|PUBLISHED_ATTR_KEY|KEPT_OFF_SITE|["'`]_published["'`]/.test(readFileSync(join(SRC, file), "utf8")), file).toBe(false);
    }
  });
});
