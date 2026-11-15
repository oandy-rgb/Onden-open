// A board through the .canvas file (lib/jsonCanvas) and through the diffs it is saved with (lib/boardLayout):
// whiteboard review 2026-11-11 (docs/archive/deep-review-board-2026-11-11.md).
//
//   1 export → import returns every card's title, text, place, size and colour, and every group's frame, title and colour
//   2 diffBoard: applying the diff of (before → after) to `before` gives `after` (the server's merge rule)
//   3 an import never produces a board the server would refuse (title/colour/size limits of PATCH /api/boards),
//     because by then the notes are already made: those are checked below
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/boardImportExport.property.test.ts

import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { NODE_TITLE_MAX } from "@onden/markdown";
import { fromJsonCanvas, toJsonCanvas, type ExportCard, type ExportSection } from "../../lib/jsonCanvas";
import { diffBoard } from "../../lib/boardLayout";
import type { CanvasData, CanvasNodeEntry, CanvasSection } from "../../lib/api";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import { encodeInk, inkToSvgFrame, type InkDocument, type InkShape, type InkStroke } from "@onden/markdown/ink";

// The server this file's export properties read: attribute values per note (what `reads.notes.attributeValues`
// answers for the keys asked) and the notes the viewer can fetch whole (`reads.notes.full`; any other id is a 403).
const world = vi.hoisted(() => ({
  attrs: new Map<string, Record<string, string>>(),
  readable: new Map<string, { id: string; title: string; markdown: string; node_type: string }>(),
  asked: [] as string[],
}));
vi.mock("../../lib/data", async (original) => {
  const data = await original<typeof import("../../lib/data")>();
  const { ApiError } = await import("../../lib/api");
  return {
    ...data,
    reads: {
      ...data.reads,
      notes: {
        ...data.reads.notes,
        attributeValues: vi.fn(async (id: string, keys: readonly string[]) => {
          world.asked.push(id);
          return Object.fromEntries(keys.map((k) => [k, world.attrs.get(id)?.[k] ?? null]));
        }),
        full: vi.fn(async (id: string) => {
          world.asked.push(id);
          const note = world.readable.get(id);
          if (!note) throw new ApiError(403, JSON.stringify({ error: "forbidden" }));
          return note;
        }),
      },
    },
  };
});
import { prepareCanvasExport } from "../../lib/canvasExport";
import { WriteActionError } from "../../lib/data";
import type { Canvas, ContentNode } from "../../lib/api";

const run = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

const hex = fc.constantFrom("#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ec4899");
const word = fc.stringMatching(/^[A-Za-z0-9一-鿿]{1,12}$/);
const line = fc.array(word, { minLength: 1, maxLength: 5 }).map((w) => w.join(" "));
const coord = fc.integer({ min: -5000, max: 5000 });
const size = fc.integer({ min: 40, max: 2000 });

const exportCards = fc.uniqueArray(
  fc.record({
    id: fc.uuid(), x: coord, y: coord, width: size, height: size,
    title: line, markdown: fc.array(line, { maxLength: 4 }).map((l) => l.join("\n\n")),
    color: fc.option(hex, { nil: undefined }),
  }),
  { selector: (c) => c.id, maxLength: 12 },
);
const exportSections = fc.array(
  fc.record({ id: fc.uuid(), x: coord, y: coord, width: size, height: size, title: line, color: fc.option(hex, { nil: undefined }) }),
  { maxLength: 4 },
);

describe("board file round trip", () => {
  it("export → import keeps every card and group", () => {
    fc.assert(fc.property(exportCards, exportSections, (cards: ExportCard[], sections: ExportSection[]) => {
      const file = JSON.parse(JSON.stringify(toJsonCanvas(cards, sections, [])));
      const back = fromJsonCanvas(file);
      expect(back.cards.map((c) => ({ key: c.key, x: c.x, y: c.y, width: c.width, height: c.height, title: c.title, markdown: c.markdown, color: c.color })))
        .toEqual(cards.map((c) => ({ key: c.id, x: c.x, y: c.y, width: c.width, height: c.height, title: c.title, markdown: c.markdown, color: c.color })));
      expect(back.sections).toEqual(sections.map((s) => ({ x: s.x, y: s.y, width: s.width, height: s.height, title: s.title, color: s.color })));
    }), run);
  });

  it("connections between cards survive; the ones to a card that is not on the board are left out of the file", () => {
    fc.assert(fc.property(exportCards, (cards) => {
      fc.pre(cards.length >= 2);
      const edges = [
        { id: "e1", source: cards[0]!.id, target: cards[1]!.id },
        { id: "e2", source: cards[0]!.id, target: "not-on-this-board" },
      ];
      const back = fromJsonCanvas(JSON.parse(JSON.stringify(toJsonCanvas(cards, [], edges))));
      expect(back.links).toEqual([{ fromKey: cards[0]!.id, toKey: cards[1]!.id }]);
    }), run);
  });
});

// The server's rule for PATCH /api/boards/:id (services/boardWrites.ts): a named card takes the fields the change
// names (null clears one), the named removals go, the rest stay.
function applyChanges(before: CanvasData, changes: ReturnType<typeof diffBoard>): CanvasData {
  const cards = new Map(before.nodes.map((c) => [c.nodeId, c]));
  for (const id of changes.cards?.remove ?? []) cards.delete(id);
  for (const c of changes.cards?.upsert ?? []) {
    const next: Record<string, unknown> = { ...cards.get(c.nodeId) };
    for (const [key, value] of Object.entries(c)) { if (value === null) delete next[key]; else if (value !== undefined) next[key] = value; }
    cards.set(c.nodeId, next as CanvasNodeEntry);
  }
  const sections = new Map((before.sections ?? []).map((s) => [s.id, s]));
  for (const id of changes.sections?.remove ?? []) sections.delete(id);
  for (const s of changes.sections?.upsert ?? []) {
    const next: Record<string, unknown> = { ...sections.get(s.id) };
    for (const [key, value] of Object.entries(s)) { if (value === null) delete next[key]; else if (value !== undefined) next[key] = value; }
    sections.set(s.id, next as CanvasSection);
  }
  return { nodes: [...cards.values()], sections: [...sections.values()] };
}
const norm = (d: CanvasData) => ({
  nodes: [...d.nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map((c) => ({ ...c, folded: !!c.folded })),
  sections: [...(d.sections ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
});
const entry = fc.record({
  nodeId: fc.integer({ min: 0, max: 9 }).map((n) => `n${n}`), x: coord, y: coord,
}, { requiredKeys: ["nodeId", "x", "y"] }).chain((base) => fc.record({
  width: fc.option(size, { nil: undefined }), color: fc.option(hex, { nil: undefined }), folded: fc.boolean(),
}).map((rest) => ({ ...base, ...(rest.width ? { width: rest.width } : {}), ...(rest.color ? { color: rest.color } : {}), ...(rest.folded ? { folded: true } : {}) } as CanvasNodeEntry)));
const layout = fc.record({
  nodes: fc.uniqueArray(entry, { selector: (c) => c.nodeId, maxLength: 10 }),
  sections: fc.uniqueArray(
    fc.record({ id: fc.integer({ min: 0, max: 5 }).map((n) => `s${n}`), x: coord, y: coord, width: size, height: size, title: line }),
    { selector: (s) => s.id, maxLength: 4 },
  ),
});

describe("board diffs", () => {
  it("applying the diff of before → after to before gives after", () => {
    fc.assert(fc.property(layout, layout, (before, after) => {
      const changes = diffBoard(before as CanvasData, after as CanvasData);
      expect(norm(applyChanges(before as CanvasData, changes))).toEqual(norm(after as CanvasData));
    }), run);
  });

  it("a diff names only what changed", () => {
    fc.assert(fc.property(layout, (data) => {
      expect(diffBoard(data as CanvasData, data as CanvasData)).toEqual({});
    }), run);
  });
});

// What PATCH /api/boards/:id refuses (routes/boards.ts): a section title over NODE_TITLE_MAX, a colour over 64
// characters. An import has made every note before it saves the board, so a refusal there leaves notes without a board.
describe("a .canvas file the server's board save would refuse", () => {
  const file = (extra: Record<string, unknown>, type: "group" | "text" = "group") => ({
    nodes: [{ id: "a", type, x: 0, y: 0, width: 100, height: 100, ...(type === "text" ? { text: "hello" } : {}), ...extra }], edges: [],
  });

  it("a group label longer than a section title can be is refused before any note is made", () => {
    // Fix direction: fromJsonCanvas checks `label` against NODE_TITLE_MAX like it does a card's heading.
    expect(() => fromJsonCanvas(file({ label: "g".repeat(NODE_TITLE_MAX + 1) }))).toThrow();
  });

  it("a colour longer than the server stores is refused or dropped before any note is made", () => {
    const parsed = (() => { try { return fromJsonCanvas(file({ color: `#${"f".repeat(80)}` }, "text")); } catch { return null; } })();
    expect(parsed === null || (parsed.cards[0]!.color ?? "").length <= 64).toBe(true);
  });

  it("a connection that ends on a group is skipped, not a reason to refuse the whole file", () => {
    // Obsidian lets an arrow end on a group, so a valid file reaches this refusal.
    const raw = {
      nodes: [
        { id: "g", type: "group", x: 0, y: 0, width: 300, height: 300, label: "G" },
        { id: "t", type: "text", x: 10, y: 10, width: 100, height: 100, text: "hi" },
      ],
      edges: [{ id: "e", fromNode: "t", toNode: "g" }],
    };
    expect(fromJsonCanvas(raw).cards).toHaveLength(1);
  });
});

// The board's export (lib/canvasExport.ts) through the real prepareCanvasExport, reads faked by `world` above.
//
//   4 the picture in the file is the board's pen layer (`board_ink`) and never the note's own handwriting
//     (`ink_data`, `note_ink`): drawn only in strokes, only in shapes, in both, or not at all (then there is no picture)
//   5 a card of a note the viewer cannot read refuses the whole export (never a partial file), and nothing of that
//     note (title, body) is in the refusal's text or anywhere in a file
//   6 every section is in the file with its frame and title; folded cards leave with their whole text (folding is how a
//     card is shown, not what it holds)
//
// Board ink colours (#aa....) and the note's own (#bb....) never overlap, so "which ink is in this picture" is read off
// the svg itself.
const boardColor = fc.integer({ min: 0, max: 0xff }).map((n) => `#aa${n.toString(16).padStart(2, "0")}00`);
const noteColor = fc.integer({ min: 0, max: 0xff }).map((n) => `#bb${n.toString(16).padStart(2, "0")}00`);
const strokeOf = (color: fc.Arbitrary<string>) => fc.record({
  id: fc.uuid(), color, points: fc.array(fc.tuple(coord, coord), { minLength: 2, maxLength: 6 }),
}).map((s): InkStroke => ({ id: s.id, color: s.color, size: 4, toolId: "pen", points: s.points as Array<[number, number]> }));
const shapeOf = (color: fc.Arbitrary<string>) => fc.record({
  id: fc.uuid(), color, kind: fc.constantFrom("rectangle", "ellipse", "line", "arrow", "triangle"),
  start: fc.tuple(coord, coord), end: fc.tuple(coord, coord),
}).map((s): InkShape => ({ id: s.id, kind: s.kind, start: s.start, end: s.end, color: s.color, size: 4 }));
/** A shape needs some extent to be drawn at all: keep generated ones apart by at least 40 units. */
const drawable = (s: InkShape) => Math.abs(s.start[0] - s.end[0]) >= 40 && Math.abs(s.start[1] - s.end[1]) >= 40;
const inkDoc = (strokes: InkStroke[], shapes: InkShape[]): InkDocument =>
  ({ version: 1, erased: {}, page: { width: 1000 }, strokes, ...(shapes.length ? { shapes } : {}) });
const boardInkMode = fc.constantFrom("none", "strokes", "shapes", "both");
const ownInkMode = fc.constantFrom("none", "ink_data", "note_ink", "both");

const exportScenario = fc.record({
  mode: boardInkMode,
  own: ownInkMode,
  boardStrokes: fc.array(strokeOf(boardColor), { minLength: 1, maxLength: 4 }),
  boardShapes: fc.array(shapeOf(boardColor).filter(drawable), { minLength: 1, maxLength: 3 }),
  ownStrokes: fc.array(strokeOf(noteColor), { minLength: 1, maxLength: 4 }),
  ownShapes: fc.array(shapeOf(noteColor).filter(drawable), { minLength: 1, maxLength: 3 }),
  cards: exportCards,
  folded: fc.array(fc.boolean(), { maxLength: 12 }),
  // how the viewer holds each card's note: whole, not at all (fetched when exported), or without its body (fetched; local title kept)
  held: fc.array(fc.constantFrom("whole", "absent", "stub"), { maxLength: 12 }),
  sections: exportSections,
});
type Scenario = typeof exportScenario extends fc.Arbitrary<infer T> ? T : never;

function setUp(sc: Scenario, unreadable: ReadonlySet<string> = new Set()) {
  world.attrs.clear(); world.readable.clear(); world.asked.length = 0;
  const own: Record<string, string> = {};
  const ownDoc = encodeInk(inkDoc(sc.ownStrokes, sc.ownShapes));
  if (sc.own === "ink_data" || sc.own === "both") own.ink_data = ownDoc;
  if (sc.own === "note_ink" || sc.own === "both") own.note_ink = ownDoc;
  const boardDoc = inkDoc(sc.mode === "shapes" ? [] : sc.boardStrokes, sc.mode === "strokes" ? [] : sc.boardShapes);
  if (sc.mode !== "none") own.board_ink = encodeInk(boardDoc);
  world.attrs.set("board", own);
  const board: Canvas = {
    id: "board", title: "Board", created_at: "", updated_at: "",
    data: {
      nodes: sc.cards.map((c, i) => ({ nodeId: c.id, x: c.x, y: c.y, width: c.width, height: c.height, ...(c.color ? { color: c.color } : {}), ...(sc.folded[i] ? { folded: true } : {}) })),
      sections: sc.sections,
    },
  };
  const nodes: ContentNode[] = [];
  sc.cards.forEach((c, i) => {
    if (unreadable.has(c.id)) return;
    const held = sc.held[i] ?? "whole";
    // The server's copy of a stub's title is older than the local one (a queued rename): the export keeps the local title.
    world.readable.set(c.id, { id: c.id, title: held === "stub" ? `old ${c.title}` : c.title, markdown: c.markdown, node_type: "content" });
    if (held === "absent") return;
    const base = { id: c.id, title: c.title, source_type: "manual", node_type: "content", slug: c.id } as const;
    nodes.push(held === "stub" && c.markdown !== "" ? { ...base, markdown: "", body_len: c.markdown.length } : { ...base, markdown: c.markdown });
  });
  return { board, nodes, boardDoc, ownDoc };
}
/** The file as it is written (JSON), without the picture layer node, so that cards are only the board's cards. */
const written = (prepared: Awaited<ReturnType<typeof prepareCanvasExport>>) => {
  const file = JSON.parse(JSON.stringify(prepared.canvas)) as ReturnType<typeof toJsonCanvas>;
  return { ...file, nodes: file.nodes.filter((n) => n.id !== "ink-layer") };
};
/** What the whole export holds: the .canvas, and the picture's svg. */
const everything = (prepared: Awaited<ReturnType<typeof prepareCanvasExport>>) => JSON.stringify(prepared);

describe("board export (prepareCanvasExport)", () => {
  beforeEach(() => { world.attrs.clear(); world.readable.clear(); world.asked.length = 0; });

  // The picture-source invariant, whole. It fails today for nearly every input: see the FINDING cases below.
  it("FINDING board-ink: the picture is the board's pen layer, never the note's own handwriting", async () => {
    await fc.assert(fc.asyncProperty(exportScenario, async (sc) => {
      const { board, nodes, boardDoc } = setUp(sc);
      const prepared = await prepareCanvasExport(board, nodes, []);
      if (sc.mode === "none") {
        expect(prepared.ink).toBeNull();
        expect(prepared.canvas.nodes.some((n) => n.type === "file")).toBe(false);
        return;
      }
      const frame = inkToSvgFrame(boardDoc)!;
      expect(prepared.ink).toEqual({ file: "Board-ink.svg", svg: frame.svg });
      expect(prepared.ink!.svg).toMatch(/#aa[0-9a-f]{2}00/);
      expect(prepared.ink!.svg).not.toMatch(/#bb[0-9a-f]{2}00/);
      const layer = prepared.canvas.nodes.at(-1)!;
      expect(layer).toMatchObject({ type: "file", file: "Board-ink.svg", x: frame.x, y: frame.y, width: frame.width, height: frame.height });
    }), run);
  });

  // The part of that invariant the defect does not reach (it reads ink_data only): a note's `note_ink` tab drawing
  // is not on the board, so without a pen layer there is no picture, with or without pen strokes in other keys.
  it("a note's note_ink drawing on a board with no pen layer gives no picture and none of its strokes", async () => {
    await fc.assert(fc.asyncProperty(exportScenario, async (sc) => {
      const { board, nodes } = setUp({ ...sc, mode: "none", own: "note_ink" });
      const prepared = await prepareCanvasExport(board, nodes, []);
      expect(prepared.ink).toBeNull();
      expect(prepared.canvas.nodes.some((n) => n.type === "file")).toBe(false);
      expect(everything(prepared)).not.toMatch(/#bb[0-9a-f]{2}00/);
    }), run);
  });

  it("the export reads the board once, and no note that is not a card on it", async () => {
    await fc.assert(fc.asyncProperty(exportScenario, async (sc) => {
      const { board, nodes } = setUp(sc);
      await prepareCanvasExport(board, nodes, []);
      // Only an absent or body-less note is fetched, and nothing but cards of this board is asked for.
      const ids = new Set(sc.cards.map((c) => c.id));
      expect(world.asked.filter((id) => id !== "board" && !ids.has(id))).toEqual([]);
      expect(world.asked.filter((id) => id === "board")).toEqual(["board"]);
    }), run);
  });

  it("a card the viewer cannot read refuses the whole export and leaks nothing of its note", async () => {
    await fc.assert(fc.asyncProperty(exportScenario, fc.nat(), async (sc, pick) => {
      fc.pre(sc.cards.length > 0);
      const hidden = sc.cards[pick % sc.cards.length]!;
      const secret = { title: `SECRET-T-${hidden.title}`, markdown: `SECRET-B-${hidden.markdown}` };
      const { board, nodes } = setUp(sc, new Set([hidden.id]));
      const error = await prepareCanvasExport(board, nodes, []).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(WriteActionError);
      const message = (error as Error).message + JSON.stringify((error as Error).cause ?? "");
      expect(message).not.toContain(secret.title);
      expect(message).not.toContain(secret.markdown);
      expect(message).not.toContain(hidden.id);
    }), run);
  });

  it("every section and every card (folded or not; held whole, absent or without its body; whole text) is in the file", async () => {
    await fc.assert(fc.asyncProperty(exportScenario, async (sc) => {
      const { board, nodes } = setUp(sc);
      const prepared = await prepareCanvasExport(board, nodes, []);
      const back = fromJsonCanvas(written(prepared));
      expect(back.sections).toEqual(sc.sections.map((s) => ({ x: s.x, y: s.y, width: s.width, height: s.height, title: s.title, color: s.color })));
      expect(back.cards.map((c) => ({ key: c.key, x: c.x, y: c.y, title: c.title, markdown: c.markdown, color: c.color })))
        .toEqual(sc.cards.map((c) => ({ key: c.id, x: c.x, y: c.y, title: c.title, markdown: c.markdown, color: c.color })));
    }), run);
  });
});

// The same defect as a minimal, named case: lib/canvasExport.ts:57 reads the `ink_data` attribute (a handwriting
// note's page) where the board's pen layer is `board_ink` (components/CanvasInkLayer.tsx, "not `ink_data`").
// Replay the generated form: PROPS_SEED=20261023 (the default) PROPS_RUNS=200 npx vitest run <this file> -t "FINDING board-ink".
describe("regressions: the board's ink is board_ink (FINDING board-ink, fix in progress on fix/board-ink-2026-11-14)", () => {
  const stroke = (id: string, color: string): InkStroke => ({ id, color, size: 4, toolId: "pen", points: [[0, 0], [40, 40]] });
  const boardInk = encodeInk(inkDoc([stroke("b", "#aa0000")], []));
  const ownInk = encodeInk(inkDoc([stroke("n", "#bb0000")], []));
  const board: Canvas = { id: "board", title: "Board", created_at: "", updated_at: "", data: { nodes: [{ nodeId: "a", x: 0, y: 0 }], sections: [] } };
  const nodes: ContentNode[] = [{ id: "a", title: "a", markdown: "body", source_type: "manual", node_type: "content", slug: "a" }];
  const exportWith = (attrs: Record<string, string>) => {
    world.attrs.clear(); world.asked.length = 0; world.attrs.set("board", attrs);
    return prepareCanvasExport(board, nodes, []);
  };

  // Scenario: the board has no pen strokes; the note itself is a handwriting page (ink_data only).
  // Expected: no picture in the export. Actual: the note's handwriting is exported as the board's picture.
  it("FINDING board-ink: a note's handwriting (ink_data) is not exported as the board's picture", async () => {
    const prepared = await exportWith({ ink_data: ownInk });
    expect(prepared.ink).toBeNull();
  });

  // Scenario: the board has pen strokes (board_ink); the note has no handwriting. Expected: the picture holds them.
  // Actual: attributeValues(board, ["ink_data"]) has nothing, so the pen layer is silently left out of the file.
  it("FINDING board-ink: a board's pen layer (board_ink) is exported", async () => {
    const prepared = await exportWith({ board_ink: boardInk });
    expect(prepared.ink?.svg).toContain("#aa0000");
  });

  // Scenario: both. Expected: only #aa0000 (board). Actual: only #bb0000 (the note's own handwriting).
  it("FINDING board-ink: with both, the picture is the board's and never the note's", async () => {
    const prepared = await exportWith({ board_ink: boardInk, ink_data: ownInk, note_ink: ownInk });
    expect(prepared.ink?.svg).toContain("#aa0000");
    expect(prepared.ink?.svg).not.toContain("#bb0000");
  });

  // FINDING board-ink-reimport (owner decides): lib/jsonCanvas.ts:69 writes the picture as a "file" node "ink-layer" and
  // lib/jsonCanvas.ts fromJsonCanvas reads every "file" node back as a note card ("Imported file reference: `Board-ink.svg`").
  // Scenario: export a board with pen strokes (the zip carries the svg), import that same .canvas.
  // Expected: the board comes back with its own cards only. Actual: one extra card (and note) for the picture.
  it.fails("FINDING board-ink-reimport: importing the board's own export does not add a card for the picture", async () => {
    const prepared = await exportWith({ board_ink: boardInk, ink_data: boardInk });
    expect(prepared.ink).not.toBeNull();
    const back = fromJsonCanvas(JSON.parse(JSON.stringify(prepared.canvas)));
    expect(back.cards.map((c) => c.key)).toEqual(["a"]);
  });
});

// Scan 08 #4: a frame is patched by the fields that changed, like a card, so two devices editing different
// fields of one frame (rename here, resize there) both keep their edit, whichever reaches the server first.
describe("frames are sent as changed fields", () => {
  const frame: CanvasSection = { id: "f", x: 0, y: 0, width: 400, height: 300, title: "Group", color: "#112233" };
  const edit = fc.oneof(
    fc.string({ minLength: 1, maxLength: 20 }).map((title) => ({ title })),
    fc.record({ x: coord, y: coord }),
    fc.record({ width: size, height: size }),
    fc.constant({ color: undefined as string | undefined }),
  );

  it("a rename and a resize from the same base both survive, in either order", () => {
    fc.assert(fc.property(edit, edit, (a, b) => {
      const mine = { ...frame, ...a };
      const theirs = { ...frame, ...b };
      const sent = [diffBoard({ nodes: [], sections: [frame] }, { nodes: [], sections: [mine] }), diffBoard({ nodes: [], sections: [frame] }, { nodes: [], sections: [theirs] })];
      const expected = { ...frame, ...a, ...b };
      for (const order of [sent, [...sent].reverse()]) {
        const after = order.reduce((board, change) => applyChanges(board, change), { nodes: [], sections: [frame] } as CanvasData);
        for (const key of Object.keys(a) as (keyof CanvasSection)[]) {
          // Both devices named this field: the later one wins, so only fields only one device touched are checked.
          if (key in b) continue;
          expect(after.sections![0]![key]).toEqual(expected[key]);
        }
        for (const key of Object.keys(b) as (keyof CanvasSection)[]) {
          if (key in a) continue;
          expect(after.sections![0]![key]).toEqual(expected[key]);
        }
      }
    }), { seed: PROPS_SEED, numRuns: PROPS_RUNS });
  });

  it("scan 08 #4: renaming a frame sends the name only, so it cannot undo a resize made elsewhere", () => {
    const renamed = { ...frame, title: "Renamed" };
    expect(diffBoard({ nodes: [], sections: [frame] }, { nodes: [], sections: [renamed] }))
      .toEqual({ sections: { upsert: [{ id: "f", title: "Renamed" }] } });
    const resized = { ...frame, x: -20, width: 600 };
    expect(diffBoard({ nodes: [], sections: [frame] }, { nodes: [], sections: [resized] }))
      .toEqual({ sections: { upsert: [{ id: "f", x: -20, y: 0, width: 600, height: 300 }] } });
  });

  it("a new frame is sent whole and clearing a colour sends null", () => {
    expect(diffBoard({ nodes: [] }, { nodes: [], sections: [frame] }).sections?.upsert?.[0]).toEqual(frame);
    const plain = { ...frame, color: undefined };
    expect(diffBoard({ nodes: [], sections: [frame] }, { nodes: [], sections: [plain] }).sections?.upsert).toEqual([{ id: "f", color: null }]);
  });
});
