import { describe, expect, it } from "vitest";
import * as shared from "@onden/markdown";
import { pagesOf } from "./pages";
import { parseDeck } from "./slides";

// The cut into pages and the layout rule live once, in @onden/markdown, and the server's getSlides tool
// reads notes with the same functions; the files here only keep the old import paths.
describe("the slides view reads a note with the shared cut", () => {
  it("is the one pagesOf / parseDeck", () => {
    expect(pagesOf).toBe(shared.pagesOf);
    expect(parseDeck).toBe(shared.parseDeck);
  });
});
