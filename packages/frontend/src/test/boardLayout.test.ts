import { describe, expect, it } from "vitest";
import { BOARD_CARDS_PER_REQUEST_MAX } from "@onden/markdown";
import { diffBoard, isEmptyBoardChange, splitBoardChanges, materializeTagBoard, tagBoardMemberIds } from "../lib/boardLayout";
import type { CanvasData, ContentNode } from "../lib/api";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const before: CanvasData = {
  nodes: [{ nodeId: A, x: 0, y: 0 }, { nodeId: B, x: 300, y: 0, color: "red" }],
  sections: [{ id: "s1", title: "One", x: 0, y: 0, width: 100, height: 100 }],
};

describe("diffBoard", () => {
  it("sends only the cards that changed, so untouched cards are never rewritten (GAP-178)", () => {
    const after = { ...before, nodes: [{ nodeId: A, x: 50, y: 0 }, before.nodes[1]] };
    expect(diffBoard(before, after)).toEqual({ cards: { upsert: [{ nodeId: A, x: 50, y: 0 }] } });
  });

  it("sends only the fields that changed, so a move never carries the colour or size of an old copy (F2)", () => {
    const sized: CanvasData = { nodes: [{ nodeId: A, x: 0, y: 0, width: 400, color: "red", folded: true }] };
    expect(diffBoard(sized, { nodes: [{ ...sized.nodes[0]!, x: 9, y: 0 }] }).cards?.upsert).toEqual([{ nodeId: A, x: 9, y: 0 }]);
    expect(diffBoard(sized, { nodes: [{ ...sized.nodes[0]!, color: "blue" }] }).cards?.upsert).toEqual([{ nodeId: A, color: "blue" }]);
    expect(diffBoard(sized, { nodes: [{ nodeId: A, x: 0, y: 0, width: 400, color: "red" }] }).cards?.upsert).toEqual([{ nodeId: A, folded: false }]);
  });

  it("sends a card the old layout lacks whole", () => {
    expect(diffBoard(before, { nodes: [{ nodeId: C, x: 1, y: 2, width: 50, color: "red" }] }).cards?.upsert)
      .toEqual([{ nodeId: C, x: 1, y: 2, width: 50, color: "red" }]);
  });

  it("reports added and removed cards", () => {
    const after = { ...before, nodes: [before.nodes[0], { nodeId: C, x: 1, y: 2 }] };
    expect(diffBoard(before, after)).toEqual({ cards: { upsert: [{ nodeId: C, x: 1, y: 2 }], remove: [B] } });
  });

  it("treats a cleared style as a change and an unchanged board as no change", () => {
    const after = { ...before, nodes: [before.nodes[0], { nodeId: B, x: 300, y: 0 }] };
    expect(diffBoard(before, after).cards?.upsert).toEqual([{ nodeId: B, color: null }]);
    expect(isEmptyBoardChange(diffBoard(before, structuredClone(before)))).toBe(true);
  });

  it("diffs sections by id; an absent sections list is not a deletion", () => {
    const renamed = { ...before, sections: [{ ...before.sections![0], title: "Renamed" }, { id: "s2", title: "Two", x: 0, y: 0, width: 1, height: 1 }] };
    expect(diffBoard(before, renamed).sections?.upsert?.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(diffBoard(before, { ...before, sections: [] }).sections).toEqual({ remove: ["s1"] });
    expect(diffBoard(before, { nodes: before.nodes }).sections).toBeUndefined();
  });

  it("skips a card without a finite position", () => {
    expect(diffBoard(undefined, { nodes: [{ nodeId: A, x: Number.NaN, y: 0 }] })).toEqual({});
  });
});

describe("tag boards", () => {
  const node = (id: string, tags: string[], extra: Partial<ContentNode> = {}) =>
    ({ id, node_type: "content", label_tag_ids: tags, class_tag_ids: [], ...extra }) as unknown as ContentNode;

  it("members are the tag page's members: visible content notes carrying the tag", () => {
    const nodes = [node(A, ["t"]), node(B, ["t"], { hidden: true }), node(C, ["other"])];
    expect(tagBoardMemberIds(nodes, "t")).toEqual([A]);
  });

  it("placed members keep their place, unplaced ones line up below, former members leave the view", () => {
    const stored: CanvasData = { nodes: [{ nodeId: A, x: 100, y: 100 }, { nodeId: B, x: 400, y: 100 }], sections: [] };
    const shown = materializeTagBoard(stored, [A, C]);
    expect(shown.nodes[0]).toEqual({ nodeId: A, x: 100, y: 100 });
    expect(shown.nodes.map((c) => c.nodeId)).toEqual([A, C]);
    expect(shown.nodes[1].y).toBeGreaterThan(100);
    // Nothing to do → the same object, so callers can skip a re-render.
    expect(materializeTagBoard(shown, [A, C])).toBe(shown);
  });
});

describe("splitBoardChanges (F7)", () => {
  const cards = (n: number) => Array.from({ length: n }, (_, i) => ({ nodeId: `n${i}`, x: i, y: i }));
  it("keeps a change within the server's cap as one request", () => {
    const change = { cards: { upsert: cards(BOARD_CARDS_PER_REQUEST_MAX) } };
    expect(splitBoardChanges(change)).toEqual([change]);
  });
  it("cuts a larger change into runs, in order, nothing repeated or dropped", () => {
    const upsert = cards(BOARD_CARDS_PER_REQUEST_MAX * 2 + 1);
    const remove = Array.from({ length: BOARD_CARDS_PER_REQUEST_MAX + 1 }, (_, i) => `r${i}`);
    const parts = splitBoardChanges({ cards: { upsert, remove } });
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => (p.cards?.upsert?.length ?? 0) <= BOARD_CARDS_PER_REQUEST_MAX && (p.cards?.remove?.length ?? 0) <= BOARD_CARDS_PER_REQUEST_MAX)).toBe(true);
    expect(parts.flatMap((p) => p.cards?.upsert ?? [])).toEqual(upsert);
    expect(parts.flatMap((p) => p.cards?.remove ?? [])).toEqual(remove);
  });
});
