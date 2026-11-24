// The plan of a bundle taken in segments (spine/stampedInbox.ts planSegments): which items must be taken in one transaction, which only after others, and what makes
// no tie at all. One test per counterexample the proposal names (own-node-transport-2026-11-22.md §2.10) and per hub that would make one segment of everything.
// Pure: no database. The ids are new every run.
import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NODE_TYPE } from "@onden/markdown/contract";
import { changesWhatIsHere, clearInbox, movesNote, planWithLeans, type NoteHere, type SegmentLimits } from "../spine/stampedInbox.js";
import { AuthorityError } from "../spine/authorityError.js";
import type { BundleItem, WireStamp } from "../spine/snapshotSql.js";

const stamp = (label: string, rowKey: string, extra: Partial<WireStamp> = {}): WireStamp =>
  ({ label, rowKey, field: "*", origin: "o", seq: 1, wall: 1, counter: 0, author: null, device: null, deleted: false, saw: {}, meta: null, heads: [], ...extra }) as WireStamp;
const row = (table: string, key: string, values: Record<string, unknown> = {}): BundleItem =>
  ({ kind: "row", table, values, texts: {}, stamps: [stamp(table, key)] }) as BundleItem;
const tomb = (table: string, key: string, extra: Partial<WireStamp> = {}): BundleItem => ({ kind: "tombstone", table, stamp: stamp(table, key, extra) }) as BundleItem;
const note = (id: string, values: Record<string, unknown> = {}) => row("content_nodes", id, { id, node_type: NODE_TYPE.content, slug: `s-${id.slice(0, 8)}`, ...values });
const id = () => randomUUID();
/** The plan alone (which segments lean on an earlier one is its own test below). */
const planSegments = (items: readonly BundleItem[], slugs: ReadonlyMap<string, NoteHere>, limits?: SegmentLimits) => planWithLeans(items, slugs, limits, () => true).segments;
const ONE: SegmentLimits = { rows: 1, bytes: 1 << 30 };
const rows = (n: number): SegmentLimits => ({ rows: n, bytes: 1 << 30 });

/** The segment each item went to, by its identity, after checking what every plan keeps: each item once, in bundle order within its segment. */
function plan(items: BundleItem[], limits: SegmentLimits, slugs = new Map<string, NoteHere>()): { at: Map<BundleItem, number>; segments: BundleItem[][] } {
  const segments = planSegments(items, slugs, limits);
  expect(segments.flat().length).toBe(items.length);
  expect(new Set(segments.flat()).size).toBe(items.length);
  for (const s of segments) expect(s.map((i) => items.indexOf(i))).toEqual(s.map((i) => items.indexOf(i)).sort((x, y) => x - y));
  return { at: new Map(segments.flatMap((s, n) => s.map((i) => [i, n] as const))), segments };
}

describe("planSegments", () => {
  it("puts every item in exactly one segment, in bundle order within it, no segment past the limit when no group is larger", () => {
    const items = Array.from({ length: 50 }, () => note(id()));
    const n = 1 + randomInt(12);
    const { segments } = plan(items, rows(n));
    for (const s of segments) expect(s.length).toBeLessThanOrEqual(n);
    expect(segments.length).toBe(Math.ceil(50 / n));
  });

  it("is the same plan for the same bundle and slugs", () => {
    const p = id();
    const items = [note(p), ...Array.from({ length: 20 }, () => note(id(), { parent_id: randomInt(2) ? p : null }))];
    expect(planSegments(items, new Map(), rows(3))).toEqual(planSegments(items, new Map(), rows(3)));
  });

  it("a child comes no earlier than its parent, wherever the bundle has them (a child made before its parent would hang for good)", () => {
    const parent = id(), child = id();
    const items = [note(child, { parent_id: parent }), note(id()), note(parent)];
    const { at } = plan(items, ONE);
    expect(at.get(items[0]!)!).toBeGreaterThanOrEqual(at.get(items[2]!)!);
  });

  it("a subtree of new notes is not one segment: each note after its parent", () => {
    const root = id();
    const ids: string[] = [root];
    const items = [note(root)];
    for (let k = 0; k < 60; k++) { const p = ids[randomInt(ids.length)]!, n = id(); ids.push(n); items.push(note(n, { parent_id: p })); }
    const { at, segments } = plan(items, rows(7));
    expect(segments.length).toBe(Math.ceil(61 / 7));
    for (const it of items.slice(1)) {
      const p = (it as Extract<BundleItem, { kind: "row" }>).values.parent_id as string;
      expect(at.get(it)!).toBeGreaterThanOrEqual(at.get(items[ids.indexOf(p)]!)!);
    }
  });

  it("two notes moved under each other (a loop) are one group", () => {
    const x = id(), y = id();
    const items = [note(x, { parent_id: y }), note(id()), note(id()), note(y, { parent_id: x })];
    const { at } = plan(items, ONE);
    expect(at.get(items[0]!)).toBe(at.get(items[3]!));
  });

  it("a note moved out of another (the stamp's meta names it) comes no earlier than that note", () => {
    const from = id(), moved = id();
    const items = [{ kind: "row", table: "content_nodes", values: { id: moved }, texts: {}, stamps: [stamp("content_nodes", moved), stamp("content_nodes", moved, { field: "parent", meta: { from } })] } as BundleItem, note(id()), note(from)];
    const { at } = plan(items, ONE);
    expect(at.get(items[0]!)!).toBeGreaterThanOrEqual(at.get(items[2]!)!);
  });

  it("a row and the tombstones of its JSON keys, a note and its anchors unit, its anchors and paragraph rows: one segment; its attribute no earlier", () => {
    const n = id(), m = id();
    const items = [note(n), note(m), row("note_anchor_places", n, { note_id: n }), row("block_anchors", "x1y2z3", { anchor_id: "x1y2z3", note_id: n }), row("block_nodes", id(), { note_id: n }),
      tomb("content_nodes.tag_schema", n, { field: "key:x" }), row("node_attributes", `${n}/status`, { node_id: n, key: "status" })];
    const { at } = plan(items, ONE);
    for (const i of items.slice(2, 6)) expect(at.get(i)).toBe(at.get(items[0]!));
    expect(at.get(items[6]!)!).toBeGreaterThanOrEqual(at.get(items[0]!)!);
    expect(at.get(items[1]!)).not.toBe(at.get(items[0]!));
  });

  it("a paragraph row that names an anchor by its anchor id (a text key, not a uuid) comes no earlier than the anchor", () => {
    const tag = id();
    const items = [row("block_nodes", id(), { anchor_id: "a1b2c3" }), note(id()), row("block_anchors", "a1b2c3", { anchor_id: "a1b2c3", note_id: tag })];
    const { at } = plan(items, ONE);
    expect(at.get(items[0]!)!).toBeGreaterThanOrEqual(at.get(items[2]!)!);
  });

  it("the workspace, its spaces and memberships: a thousand notes of one space are not one segment, and the space comes first", () => {
    const space = id(), ws = id();
    const notes = Array.from({ length: 1000 }, () => note(id(), { space_id: space, workspace_id: ws }));
    const items = [...notes, row("workspaces", ws), row("space_members", `${space}/${id()}`, { space_id: space }), row("spaces", space, { workspace_id: ws })];
    const { at, segments } = plan(items, rows(100));
    expect(segments.length).toBe(Math.ceil(items.length / 100));
    expect([at.get(items[1000]!), at.get(items[1002]!)]).toEqual([0, 0]);
    expect(at.get(items[1001]!)!).toBeGreaterThanOrEqual(at.get(items[1002]!)!);
  });

  it("a tag on many notes ties none of them together, and the tag (after the tag it is under) comes before them", () => {
    const tag = id(), parentTag = id();
    const notes = Array.from({ length: 40 }, () => id());
    const items = [...notes.map((n) => note(n)), ...notes.map((n) => row("node_tags", `${n}/${tag}`, { node_id: n, tag_id: tag })),
      row("content_nodes", tag, { id: tag, node_type: NODE_TYPE.tag, parent_id: parentTag, slug: "t" }), row("content_nodes", parentTag, { id: parentTag, node_type: NODE_TYPE.tag, slug: "p" })];
    const { at, segments } = plan(items, rows(10));
    expect(segments.length).toBe(Math.ceil(items.length / 10));
    expect(at.get(items[81]!)!).toBeLessThanOrEqual(at.get(items[80]!)!);
    for (const [k] of notes.entries()) {
      expect(at.get(items[40 + k]!)!).toBeGreaterThanOrEqual(at.get(items[80]!)!);
      expect(at.get(items[40 + k]!)!).toBeGreaterThanOrEqual(at.get(items[k]!)!);
    }
  });

  it("a tag this node holds that the bundle does not carry ties nothing either (a composite key's part is no row)", () => {
    const tag = id();
    const notes = Array.from({ length: 20 }, () => id());
    const items = [...notes.map((n) => note(n)), ...notes.map((n) => row("node_tags", `${n}/${tag}`, { node_id: n, tag_id: tag }))];
    const { segments } = plan(items, rows(4));
    expect(segments).toHaveLength(10);
  });

  it("a note this node holds that the bundle does not carry ties nothing: children of one folder here are not one segment", () => {
    const folder = id();
    expect(plan(Array.from({ length: 30 }, () => note(id(), { parent_id: folder })), rows(5)).segments).toHaveLength(6);
  });

  it("a slug handed over (a note deleted, trashed or renamed here leaves it, another arrives with it): one segment; two notes that only arrive wanting one slug are not tied (a name that gives way settles the same in any order)", () => {
    const deleted = id(), renamed = id(), takesA = id(), takesB = id(), twinA = id(), twinB = id();
    const items = [note(takesA, { slug: "foo" }), note(id()), note(id()), tomb("content_nodes", deleted), note(renamed, { slug: "new-name" }), note(id()), note(takesB, { slug: "old-name" }),
      note(twinA, { slug: "bar" }), note(id()), note(twinB, { slug: "bar" })];
    const here = new Map<string, NoteHere>([[deleted, { own: "foo", below: [], moves: true }], [renamed, { own: "old-name", below: [], moves: false }]]);
    const { at } = plan(items, ONE, here);
    expect(at.get(items[3]!)).toBe(at.get(items[0]!));
    expect(at.get(items[6]!)).toBe(at.get(items[4]!));
    expect(at.get(items[9]!)).not.toBe(at.get(items[7]!));
    expect(at.get(items[1]!)).not.toBe(at.get(items[0]!));
  });

  it("a slug held here by a note under a moved note (it can change space with it): one segment with the note that wants it; under a note that does not move: not tied", () => {
    const root = id(), still = id(), wants = id(), wantsToo = id();
    const items = [note(root), note(id()), note(wants, { slug: "deep" }), note(still), note(id()), note(wantsToo, { slug: "shallow" })];
    const here = new Map<string, NoteHere>([[root, { own: `s-${root.slice(0, 8)}`, below: ["deep"], moves: true }], [still, { own: `s-${still.slice(0, 8)}`, below: [], moves: false }]]);
    const { at } = plan(items, ONE, here);
    expect(at.get(items[2]!)).toBe(at.get(items[0]!));
    expect(at.get(items[5]!)).not.toBe(at.get(items[3]!));
  });

  it("a moved note's slug and its suffixed forms (`meeting-2`, the free one it takes when it gives way) are one group; dates and numbered titles of notes that only arrive tie nothing", () => {
    const moved = id();
    const items = [note(moved, { slug: "meeting" }), note(id()), note(id(), { slug: "meeting-2" }), note(id(), { slug: "2026-11-23" }), note(id()), note(id(), { slug: "2026-11-24" }), note(id(), { slug: "plain" }), note(id(), { slug: "plain-2" })];
    const { at } = plan(items, ONE, new Map([[moved, { own: "meeting", below: [], moves: true }]]));
    expect(at.get(items[2]!)).toBe(at.get(items[0]!));
    expect(at.get(items[5]!)).not.toBe(at.get(items[3]!));
    expect(at.get(items[7]!)).not.toBe(at.get(items[6]!));
  });

  it("a note whose text links `[[Late Target]]` comes no earlier than the note of the bundle with that title or slug (its links are worked out after that note changes, as in one piece)", () => {
    const source = id(), byTitle = id(), bySlug = id();
    const items = [{ kind: "row", table: "content_nodes", values: { id: source, slug: "src" }, texts: { body: "see [[Late Target]] and [[other-slug|that one]]" }, stamps: [stamp("content_nodes", source)] } as BundleItem,
      note(id()), note(byTitle, { title: "Late Target" }), note(id()), note(bySlug, { slug: "other-slug" })];
    const { at } = plan(items, ONE);
    expect(at.get(items[0]!)!).toBeGreaterThanOrEqual(at.get(items[2]!)!);
    expect(at.get(items[0]!)!).toBeGreaterThanOrEqual(at.get(items[4]!)!);
  });

  it("a group larger than the limit is a segment of its own, and the segments around it keep the limit", () => {
    const root = id();
    const group = [note(root), ...Array.from({ length: 12 }, (_, k) => row("block_nodes", id(), { note_id: root, n: k }))];
    const items = [note(id()), note(id()), ...group, note(id()), note(id())];
    expect(plan(items, rows(4)).segments.map((s) => s.length)).toEqual([2, 13, 2]);
  });

  it("the byte limit counts too", () => {
    const items = Array.from({ length: 10 }, () => note(id(), { markdown: "x".repeat(1000) }));
    const one = Buffer.byteLength(JSON.stringify(items[0]), "utf8");
    expect(plan(items, { rows: 1000, bytes: one * 3 }).segments).toHaveLength(4);
  });

  it("movesNote: a note gone for good, or a write of its parent, space or trash state past what this node holds; not its title, not what it holds already", () => {
    const n = id();
    const withField = (field: string, seq: number) => ({ kind: "row", table: "content_nodes", values: { id: n }, texts: {}, stamps: [stamp("content_nodes", n), stamp("content_nodes", n, { field, seq, origin: "o" })] }) as BundleItem;
    const held = (h: number) => () => h;
    expect(movesNote(tomb("content_nodes", n), held(0))).toBe(true);
    for (const f of ["parent", "space", "deleted"]) {
      expect(movesNote(withField(f, 5), held(4)), f).toBe(true);
      expect(movesNote(withField(f, 5), held(5)), f).toBe(false);
    }
    expect(movesNote(withField("title", 5), held(0))).toBe(false);
    expect(movesNote(row("node_attributes", `${n}/x`, { node_id: n }), held(0))).toBe(false);
  });

});

describe("which segments lean on an earlier one (what a rehearsal alone cannot judge)", () => {
  // held: what this node holds of origin "o" (the bundle's base); a stamp past it is new here
  const held = (seq: number) => () => seq;
  it("a child leans on the segment of the parent the bundle makes; a note that only names a row the bundle edits does not", () => {
    const ws = id(), parent = id(), child = id(), other = id();
    const workspace = { kind: "row", table: "workspaces", values: { id: ws }, texts: {}, stamps: [stamp("workspaces", ws, { seq: 0, origin: "genesis" }), stamp("workspaces", ws, { field: "confirmed:ai", seq: 5 })] } as BundleItem;
    const made = (n: string, values: Record<string, unknown>) => ({ kind: "row", table: "content_nodes", values: { id: n, node_type: NODE_TYPE.content, slug: `s-${n.slice(0, 8)}`, workspace_id: ws, ...values }, texts: {}, stamps: [stamp("content_nodes", n, { seq: 5 })] }) as BundleItem;
    const items = [workspace, made(parent, {}), made(child, { parent_id: parent }), made(other, {})];
    const { segments, leans } = planWithLeans(items, new Map(), ONE, (item) => changesWhatIsHere(item, held(1)));
    const at = (item: BundleItem) => segments.findIndex((s) => s.includes(item));
    expect(leans[at(items[2]!)], "the child, after its new parent").toBe(true);
    expect(leans[at(items[3]!)], "a note that names only the workspace, which the bundle only edits").toBe(false);
    expect(leans[at(items[1]!)], "the parent, likewise").toBe(false);
  });

  it("changesWhatIsHere: a row the bundle makes or removes, a note it moves; not a row it only edits", () => {
    const n = id();
    expect(changesWhatIsHere(row("content_nodes", n), held(0)), "made: its existence stamp is past what is held").toBe(true);
    expect(changesWhatIsHere(row("content_nodes", n), held(1)), "held already").toBe(false);
    expect(changesWhatIsHere(tomb("content_nodes", n), held(9)), "removed").toBe(true);
    const moved = { kind: "row", table: "content_nodes", values: { id: n }, texts: {}, stamps: [stamp("content_nodes", n), stamp("content_nodes", n, { field: "parent", seq: 4 })] } as BundleItem;
    expect(changesWhatIsHere(moved, held(1)), "moved").toBe(true);
    const edited = { kind: "row", table: "content_nodes", values: { id: n }, texts: {}, stamps: [stamp("content_nodes", n), stamp("content_nodes", n, { field: "title", seq: 4 })] } as BundleItem;
    expect(changesWhatIsHere(edited, held(1)), "only its title").toBe(false);
  });
});

describe("a tag a block save made", () => {
  // the mark of such a tag is derived when the tag is taken, from the paragraph's membership stamped by the same write (spine/receivedDerivation.ts
  // tagsMadeWithTheirMark): the two are one group, though the membership only names the tag (found by seed 2144791958 of the linked-texts test)
  it("is in the segment of the membership its write made, even one segment at a time; a membership of another write is only ordered after it", () => {
    const tag = id(), block = id(), other = id();
    const made = { kind: "row", table: "content_nodes", values: { id: tag, node_type: NODE_TYPE.tag, slug: "t" }, texts: {}, stamps: [stamp("content_nodes", tag, { origin: "w", seq: 7 })] } as BundleItem;
    const filler = Array.from({ length: 3 }, () => note(id()));
    const mark = { kind: "row", table: "block_node_tags", values: { block_id: block, tag_id: tag }, texts: {}, stamps: [stamp("block_node_tags", `${block}/${tag}`, { origin: "w", seq: 7 })] } as BundleItem;
    const later = { kind: "row", table: "block_node_tags", values: { block_id: other, tag_id: tag }, texts: {}, stamps: [stamp("block_node_tags", `${other}/${tag}`, { origin: "w", seq: 9 })] } as BundleItem;
    const { at } = plan([made, ...filler, mark, later], ONE);
    expect(at.get(mark)).toBe(at.get(made));
    expect(at.get(later)!).toBeGreaterThan(at.get(made)!);
  });
});

describe("only the inbox's own system job clears the inbox", () => {
  // nothing brings an inbox row back, and a bundle comes from a node, not a request: a person, a session, or a value that only looks like a system actor is
  // refused before any row is read (so no database is needed here); the inbox's own job does it in the integration tests (stampedInbox.integration.test.ts)
  it("refuses a person, a temporary session and a look-alike system actor", async () => {
    const ws = randomUUID();
    for (const actor of [
      { id: randomUUID(), name: "a person", type: "human" as const },
      { id: randomUUID(), name: "a session", type: "session" as const },
      { id: "system-change-bundle-inbox", name: "收件匣", type: "system" as const },
    ]) await expect(clearInbox(actor, ws)).rejects.toBeInstanceOf(AuthorityError);
  });
});
