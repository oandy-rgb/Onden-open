// @vitest-environment node
// Guard: "this kind of file → what is made" is decided in ONE place, lib/fileIntake (a PDF's note: lib/pdf/pdfNote).
// An entry that keeps its own list of kinds or its own `accept` would take a file another entry refuses, or make
// something else of it. Entries read the definition; they do not restate it.
import { describe, expect, it } from "vitest";
import { entryHint } from "../../../../../scripts/entrypointsCatalog.mjs";
import { findUses, sourceFiles } from "./sources";

const files = [...sourceFiles("components"), ...sourceFiles("hooks"), ...sourceFiles("lib"), ...sourceFiles("modules"),
  ...sourceFiles("pages"), ...sourceFiles("settings")];
// The entries a file comes in by: they hold no list of kinds.
const entries = files.filter((f) => /\/(components\/(OverviewEditor|MarkdownEditor)\.tsx|lib\/(createKinds|mediaInsert)\.ts|hooks\/useNodeCreation\.ts)$/.test(f));

describe("a file becomes a note in one place", () => {
  it("no other file creates a note with a pdf_url attribute", () => {
    expect(findUses(files, /key:\s*["']pdf_url["']/, ["lib/pdf/pdfNote.ts"]), entryHint("file-intake")).toEqual([]);
  });
  it("only lib/fileIntake makes a PDF note", () => {
    expect(findUses(files, /createPdfNote\(/, ["lib/pdf/pdfNote.ts", "lib/fileIntake.ts"]), entryHint("file-intake")).toEqual([]);
  });
  it("the entries do not decide what a kind of file is or becomes", () => {
    expect(findUses(entries, /mediaTypeOf\(|acceptFor\(|\.kind === "(pdf|document|image|audio|video)"|application\/pdf/), entryHint("file-intake")).toEqual([]);
  });
  it("every entry that makes a note from a file goes through makeNoteFromFile", () => {
    const users = findUses(files, /makeNoteFromFile\(/, ["lib/fileIntake.ts"]).map((u) => u.split(":")[0]);
    expect([...new Set(users)].sort()).toEqual(["components/OverviewEditor.tsx", "lib/createKinds.ts"]);
  });
});
