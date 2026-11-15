import { describe, expect, it } from "vitest";
import {
  BODY_MAX_H, EXPANDED_CARD_MAX_H, FOLDED_CARD_H, FOCUS_ZOOM, SECTION_ONLY_BELOW, TITLE_ONLY_BELOW,
  bodyOverflows, cardDefaultFromCompact, cardLayoutHeight, isCardFolded, readDisplaySettings,
  sectionHidesCards, showsTitleOnly, titleCanvasPx, titleOnlyMaxWidth, withCardsFolded, withDisplaySettings, withEveryCardSet,
} from "../lib/cardDisplay";
import { diffBoard } from "../lib/boardLayout";
import { boardTreePositions, computeBoardTree } from "../lib/boardTree";
import type { CanvasData, ContentNode } from "../lib/api";

const card = (nodeId: string, extra: { folded?: boolean; height?: number; width?: number; x?: number; y?: number } = {}) => ({ nodeId, x: 0, y: 0, ...extra });

describe("which cards are folded", () => {
  it("a card's own choice beats the board default, in both directions", () => {
    expect(isCardFolded({ cardDefault: "expanded", foldedIds: ["a"] }, card("a"))).toBe(true);
    expect(isCardFolded({ cardDefault: "folded", expandedIds: ["a"] }, card("a"))).toBe(false);
    expect(isCardFolded({ cardDefault: "folded", expandedIds: ["a"] }, card("b"))).toBe(true);
  });

  it("a card nobody chose for follows the default; a board that never set one is expanded", () => {
    expect(isCardFolded({}, card("a"))).toBe(false);
    expect(isCardFolded({ cardDefault: "folded" }, card("a"))).toBe(true);
  });

  it("a card folded before cards could be chosen for stays folded until the person chooses", () => {
    expect(isCardFolded({}, card("a", { folded: true }))).toBe(true);
    expect(isCardFolded({ expandedIds: ["a"] }, card("a", { folded: true }))).toBe(false);
  });
});

describe("the old 「精簡卡片」 flag", () => {
  it("on means folded cards by default; off, or never stored, means expanded ones", () => {
    expect(cardDefaultFromCompact(true)).toBe("folded");
    expect(cardDefaultFromCompact(false)).toBe("expanded");
    expect(cardDefaultFromCompact(undefined)).toBe("expanded");
    expect(readDisplaySettings({ display: { compact: true } }).cardDefault).toBe("folded");
    expect(readDisplaySettings({ display: { compact: false } }).cardDefault).toBe("expanded");
    expect(readDisplaySettings({}).cardDefault).toBeUndefined();
    // A real choice beats the old flag.
    expect(readDisplaySettings({ display: { compact: true, cardDefault: "expanded" } }).cardDefault).toBe("expanded");
  });

  it("settings round-trip through layout_config and keep its other keys; unreadable values count as unset", () => {
    const settings = { cardDefault: "folded" as const, titleOnlyFar: false, foldedIds: ["a"], expandedIds: ["b"] };
    const config = withDisplaySettings({ tree: { mode: "auto" }, opens_first: true }, settings);
    expect(config).toMatchObject({ tree: { mode: "auto" }, opens_first: true });
    expect(readDisplaySettings(config)).toEqual(settings);
    expect(readDisplaySettings({ display: { cardDefault: "huge", titleOnlyFar: "yes", foldedIds: [1, "x"] } })).toEqual({ foldedIds: ["x"] });
    expect(readDisplaySettings(null)).toEqual({});
  });
});

describe("folding cards", () => {
  it("folding or expanding several cards moves each between the two lists and touches no other card", () => {
    const start = { foldedIds: ["z"], expandedIds: ["a"] };
    const folded = withCardsFolded(start, ["a", "b"], true);
    expect(folded).toEqual({ foldedIds: ["z", "a", "b"] });
    expect(withCardsFolded(folded, ["a"], false)).toEqual({ foldedIds: ["z", "b"], expandedIds: ["a"] });
  });

  it("全部摺起來／全部展開 moves the default and drops every card's own choice, keeping the other settings", () => {
    const settings = { cardDefault: "expanded" as const, titleOnlyFar: false, foldedIds: ["a"], expandedIds: ["b"] };
    expect(withEveryCardSet(settings, "folded")).toEqual({ cardDefault: "folded", titleOnlyFar: false });
    expect(withEveryCardSet(settings, "expanded")).toEqual({ cardDefault: "expanded", titleOnlyFar: false });
  });

  it("choices are kept per board up to a bound, newest last", () => {
    const many = Array.from({ length: 600 }, (_, i) => `c${i}`);
    expect(withCardsFolded({}, many, true).foldedIds).toHaveLength(500);
    expect(withCardsFolded({}, many, true).foldedIds!.at(-1)).toBe("c599");
  });
});

describe("heights", () => {
  it("only a body taller than the limit is cut and faded", () => {
    expect(bodyOverflows(BODY_MAX_H)).toBe(false);
    expect(bodyOverflows(BODY_MAX_H + 1)).toBe(false);
    expect(bodyOverflows(BODY_MAX_H + 40)).toBe(true);
    expect(BODY_MAX_H).toBe(170);
  });

  it("a folded card is the title bar, a resized card keeps its height, other expanded cards take the cap", () => {
    expect(cardLayoutHeight({ foldedIds: ["a"] }, card("a", { height: 500 }))).toBe(FOLDED_CARD_H);
    expect(cardLayoutHeight({}, card("b", { height: 500 }))).toBe(500);
    expect(cardLayoutHeight({}, card("c"))).toBe(EXPANDED_CARD_MAX_H);
  });

  it("resetting the size (no width or height stored) goes back to the default height", () => {
    const resized = card("a", { height: 500, width: 400 });
    const { width: _w, height: _h, ...reset } = resized;
    expect(cardLayoutHeight({}, resized)).toBe(500);
    expect(cardLayoutHeight({}, reset)).toBe(EXPANDED_CARD_MAX_H);
  });
});

describe("far zoom", () => {
  it("titles only below 30%, only when the switch is on; section cards hide only well below that", () => {
    expect(showsTitleOnly(TITLE_ONLY_BELOW - 0.01, {})).toBe(true);
    expect(showsTitleOnly(TITLE_ONLY_BELOW, {})).toBe(false);
    expect(showsTitleOnly(0.1, { titleOnlyFar: false })).toBe(false);
    expect(sectionHidesCards(SECTION_ONLY_BELOW - 0.01)).toBe(true);
    expect(sectionHidesCards(0.2)).toBe(false);
    // One order: full text (>= 30%) → titles → section title only.
    expect(SECTION_ONLY_BELOW).toBeLessThan(TITLE_ONLY_BELOW);
  });

  it("a title is 13px on screen from 30% to 22% and 16px below, at every zoom", () => {
    for (const zoom of [0.29, 0.25, 0.22]) expect(titleCanvasPx(zoom) * zoom).toBeCloseTo(13, 5);
    for (const zoom of [0.21, 0.2, 0.1, 0.05]) expect(titleCanvasPx(zoom) * zoom).toBeCloseTo(16, 5);
    // No cap: at 5% the canvas size is 320px.
    expect(titleCanvasPx(0.05)).toBeCloseTo(320, 5);
  });

  it("a title may grow up to the next column to its right, never past it, and is never narrower than the card", () => {
    const cards = [
      { nodeId: "a", x: 0, y: 0, width: 260, height: 200 },
      { nodeId: "b", x: 400, y: 50, width: 260, height: 200 },
      { nodeId: "c", x: 400, y: 600, width: 260, height: 200 },
      { nodeId: "d", x: 300, y: 0, width: 100, height: 100 },
    ];
    expect(titleOnlyMaxWidth(cards[1]!, cards, 260, 200)).toBe(260 * 2);
    // d sits 300 from a's left edge: a title can reach it minus the gap, but not less than a's own width.
    expect(titleOnlyMaxWidth(cards[0]!, cards.slice(0, 3), 260, 200, 24)).toBe(400 - 24);
    expect(titleOnlyMaxWidth(cards[0]!, cards, 260, 200)).toBe(300 - 24);
    expect(titleOnlyMaxWidth({ nodeId: "e", x: 0, y: 0, width: 260, height: 200 }, [{ nodeId: "e", x: 0, y: 0 }, { nodeId: "f", x: 270, y: 0 }], 260, 200)).toBe(260);
  });

  it("zoom and display settings never change what is saved with the cards", () => {
    const board: CanvasData = { nodes: [{ nodeId: "a", x: 10, y: 20, width: 300, height: 400 }, { nodeId: "b", x: 500, y: 20 }] };
    // The same stored board whatever the display settings or zoom: nothing to save.
    expect(diffBoard(board, JSON.parse(JSON.stringify(board)))).toEqual({});
    expect(FOCUS_ZOOM).toBeCloseTo(0.9);
  });
});

describe("the tree follows the cards' heights", () => {
  const note = (id: string, parent: string | null, minute = 0): ContentNode =>
    ({ id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", parent_id: parent, hidden: false,
      updated_at: `2026-10-29T10:${String(minute).padStart(2, "0")}:00Z` }) as ContentNode;

  it("cards of mixed heights never overlap within a column", () => {
    const nodes = [note("r", null), ...Array.from({ length: 6 }, (_, i) => note(`k${i}`, "r", i + 1)), note("g", "k2")];
    const entries = computeBoardTree({ nodes, rootId: "r", depth: 2, choices: { open: [], closed: [] }, budget: 100 });
    const heights = new Map<string, number>([["k0", 44], ["k1", 500], ["k2", 44], ["k3", 232], ["k4", 90], ["k5", 44], ["g", 400]]);
    const heightOf = (id: string) => heights.get(id) ?? EXPANDED_CARD_MAX_H;
    const at = boardTreePositions(entries, heightOf);
    const boxes = [...at].map(([id, p]) => ({ id, x: p.x, y: p.y, h: heightOf(id) }));
    for (const a of boxes) for (const b of boxes) {
      if (a.id >= b.id || a.x !== b.x) continue;
      expect(a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} and ${b.id} overlap`).toBe(true);
    }
  });
});
