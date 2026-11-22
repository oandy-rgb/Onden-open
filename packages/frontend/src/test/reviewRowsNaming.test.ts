// The 「功能」 tab lists two review rows for a note with Q:/A: lines: making cards and starting a review. They carry
// different names (not both 「複習」), and the first says how many of the note's questions are already cards.
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewModule } from "../modules/review";
import { noteStructure } from "../lib/data";
import type { ContentNode } from "../lib/api";

const BODY = "Q: 甲\nA: 一\n\nQ: 乙\nA: 二\n\nQ: 丙\nA: 三";
const node = { id: "note-1", title: "講義" } as ContentNode;
const row = (id: string) => reviewModule.noteCommands!.find((command) => command.id === id)!.row!;
const children = (titles: string[]) => vi.spyOn(noteStructure, "children").mockReturnValue(titles.map((title, i) => ({ id: `c${i}`, title })) as never);
afterEach(() => vi.restoreAllMocks());

describe("the review rows of a note", () => {
  it("name the two rows differently", () => {
    const names = [row("a-extract-cards").name, row("a-review-here").name];
    expect(names[0]).toBeTruthy();
    expect(names[1]).toBeTruthy();
    expect(names[0]).not.toBe(names[1]);
  });

  it("say how many questions are already cards", () => {
    const describeIt = row("a-extract-cards").describe;
    children([]);
    expect(describeIt(node, BODY)).toBe("3 Q&A pairs in this note");
    vi.restoreAllMocks(); children(["甲"]);
    expect(describeIt(node, BODY)).toBe("3 Q&A pairs in this note, 1 already cards");
    vi.restoreAllMocks(); children(["甲", "乙", "丙", "別的子筆記"]);
    expect(describeIt(node, BODY)).toBe("All 3 Q&A pairs are already cards");
  });
});
