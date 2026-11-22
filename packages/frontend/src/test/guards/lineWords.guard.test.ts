// @vitest-environment node
// Guard: which words make a line a task or a card is decided by the server (backend services/lineWords.ts) and
// reaches the editor on `workspace.line_words` (lib/lineWords). The frontend keeps no rule of its own for it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { entryHint } from "../../../../../scripts/entrypointsCatalog.mjs";
import { SRC, findUses, sourceFiles } from "./sources";

const files = [...sourceFiles("components"), ...sourceFiles("hooks"), ...sourceFiles("lib"), ...sourceFiles("modules"),
  ...sourceFiles("pages"), ...sourceFiles("settings")];

describe("the words of a task line are the server's, from lib/lineWords", () => {
  it("nothing derives a line word from the tag list or keeps a table of them", () => {
    expect(findUses(files, /moduleLineWord|ALT_LINE_WORD/, []), entryHint("line-words")).toEqual([]);
  });

  it("modules no longer declare a lineWord of their own", () => {
    expect(readFileSync(`${SRC}/modules/types.ts`, "utf8")).not.toMatch(/\blineWord\??:/);
  });
});
