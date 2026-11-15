// Searching notes has one path (lib/data/noteSearch.ts, reads.notes.search): the server first,
// this device's index when offline, a typo-tolerant match last. The sidebar and the command
// palette used to each run their own; a second door that queries /api/nodes/search or the local
// index itself brings back "same query, different notes".
//
// A failure names the file: call reads.notes.search instead.
import { describe, expect, it } from "vitest";
import { findUses, sourceFiles } from "./sources";
import { entryHint } from "../../../../../scripts/entrypointsCatalog.mjs";

describe("one note search", () => {
  const files = sourceFiles(".");
  it("only noteSearch.ts asks the server's search or the local index for notes", () => {
    const uses = findUses(files, /\/api\/nodes\/search|\blocalCopy\.search\(/, ["lib/data/noteSearch.ts"]);
    expect(uses, entryHint("note-search")).toEqual([]);
  });
});
