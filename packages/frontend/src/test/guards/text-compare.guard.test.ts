// @vitest-environment node
// Guard: comparing two versions of a text is components/compare's one view. Its package
// (@codemirror/merge) is imported by TextCompareView.tsx only, which is itself loaded on demand,
// and no other file writes its own line/word diff or pulls in a diff library.
import { describe, expect, it } from "vitest";
import { entryHint } from "../../../../../scripts/entrypointsCatalog.mjs";
import { findImports, findUses, sourceFiles } from "./sources";

const files = [...sourceFiles("components"), ...sourceFiles("hooks"), ...sourceFiles("lib"), ...sourceFiles("modules"),
  ...sourceFiles("pages"), ...sourceFiles("settings")];

describe("a two-version compare is components/compare's TextCompare", () => {
  it("@codemirror/merge is imported by TextCompareView.tsx only", () => {
    const outside = findImports(files, /^@codemirror\/merge/).filter((line) => !line.startsWith("components/compare/TextCompareView.tsx"));
    expect(outside, entryHint("text-compare")).toEqual([]);
  });

  it("nothing else is a diff library or a hand-written line/word diff", () => {
    expect(findImports(files, /^(diff|jsdiff|diff-match-patch|fast-diff|fast-myers-diff|diff3)$/), entryHint("text-compare")).toEqual([]);
    expect(findUses(files, /\bfunction\s+(lineDiff|wordDiff|charDiff|diffLines|diffWords|computeDiff)\b/), entryHint("text-compare")).toEqual([]);
  });

  it("the view reaches the app through a lazy import only", () => {
    const eager = findImports(files, /TextCompareView$/).filter((line) => !line.startsWith("components/compare/TextCompare.tsx"));
    expect(eager, "TextCompareView is loaded by TextCompare.tsx's lazyWithReload; import TextCompare").toEqual([]);
  });
});
