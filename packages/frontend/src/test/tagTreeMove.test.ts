import { describe, expect, it } from "vitest";
import { canMoveTagUnder, withDescendants } from "../lib/tagTree";

// proj → draft → deep ; solo is a root.
const tags = [
  { id: "proj", parent_id: null },
  { id: "draft", parent_id: "proj" },
  { id: "deep", parent_id: "draft" },
  { id: "solo", parent_id: null },
];

describe("canMoveTagUnder: a tag has one parent, so a drop MOVES it and never loops", () => {
  it("allows a root under another tag, and a child under a tag outside its own subtree", () => {
    expect(canMoveTagUnder(tags, "solo", "proj")).toBe(true);
    expect(canMoveTagUnder(tags, "deep", "solo")).toBe(true);
    expect(canMoveTagUnder(tags, "deep", "proj")).toBe(true);
  });

  it("refuses itself, its own descendants (a cycle) and the parent it already has", () => {
    expect(canMoveTagUnder(tags, "proj", "proj")).toBe(false);
    expect(canMoveTagUnder(tags, "proj", "draft")).toBe(false);
    expect(canMoveTagUnder(tags, "proj", "deep")).toBe(false);
    expect(canMoveTagUnder(tags, "draft", "proj")).toBe(false);
  });

  it("survives a catalog that already loops", () => {
    const looped = [{ id: "a", parent_id: "b" }, { id: "b", parent_id: "a" }, { id: "c", parent_id: null }];
    expect(canMoveTagUnder(looped, "c", "a")).toBe(true);
    expect(canMoveTagUnder(looped, "a", "c")).toBe(true);
  });
});

describe("withDescendants: hiding a tag takes its sub-tags out of the list too", () => {
  it("names the hidden tags and everything under them", () => {
    expect([...withDescendants(tags, new Set(["draft"]))].sort()).toEqual(["deep", "draft"]);
    expect([...withDescendants(tags, new Set(["proj"]))].sort()).toEqual(["deep", "draft", "proj"]);
    expect([...withDescendants(tags, new Set())]).toEqual([]);
  });
});
