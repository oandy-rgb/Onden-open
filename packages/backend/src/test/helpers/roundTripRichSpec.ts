// The pure half of roundTripRich.ts: the generator of what a plain round-trip world leaves out (saved views, tag
// functions, `extends`, pointers, graph positions, review progress, personal settings, RSS, typed and ink attributes).
// No database and no ids: things point at notes and tags by index like the rest of WorldSpec (roundTripArb.ts).

import fc from "fast-check";
import { FILTER_OP_NAMES } from "@onden/markdown";
import { encodeInk, type InkDocument } from "@onden/markdown/ink";
import type { WorldSpec } from "./roundTripArb.js";
import type { AppPart } from "./roundTripRich.js";

// ── The spec ─────────────────────────────────────────────────────────────────

export type ViewLayoutName = "table" | "kanban" | "calendar" | "gallery" | "canvas" | "slides" | "handwriting";
/** The layouts a tag's saved views take; slides and handwriting are tabs of a note (a tag's views refuse them). */
export const TAG_LAYOUTS: ViewLayoutName[] = ["table", "kanban", "calendar", "gallery", "canvas"];
export const NOTE_LAYOUTS: ViewLayoutName[] = [...TAG_LAYOUTS, "slides", "handwriting"];

export type ViewSpec = {
  layout: ViewLayoutName;
  filters: Array<{ field: string; op: string; value?: string }>;
  sorts: Array<{ field: string; dir: "asc" | "desc" }>;
  groupBy: string | null;
  visibleFields: string[];
  layoutConfig: Record<string, unknown>;
  pinOrder: number;
  /** Notes and tags the view names by id (a filter value, the board tab's opened and closed branches); by index like the rest
   *  of the spec. A restore has to give each the id it has in the new workspace. */
  refs: { filterNote: number | null; filterTag: number | null; treeOpen: number[]; treeClosed: number[] };
};

export type InkSpec = { key: "ink_data" | "board_ink" | "note_ink"; strokes: number; shapes: number; salt: number };
export type ExtraAttrSpec =
  | { note: number; kind: "text" | "number" | "date" | "bool"; value: string }
  | { note: number; kind: "node_ref"; target: number }
  | { note: number; kind: "ink"; ink: InkSpec }
  /** One note holding all three drawings at once (a board with a handwriting page and a 手寫 tab): which key a drawing is in must survive. */
  | { note: number; kind: "inkset"; inks: [InkSpec, InkSpec, InkSpec] };

export type RichSpec = {
  /** Reads and writes `{idea}`-style paragraph tags: the three tags the generated paragraphs may carry exist first. */
  blockTags: boolean;
  tagViews: Array<{ tag: number; view: ViewSpec }>;
  noteViews: Array<{ note: number; view: ViewSpec }>;
  functions: Array<{ tag: number; functionId: "skills"; /** null: added with no settings of its own. */ config: Record<string, unknown> | null }>;
  /** `tag` extends `target`; `target` is always an earlier tag, so there is no cycle. */
  extendsLinks: Array<{ tag: number; target: number }>;
  /** A pointer to `target` under note `under`, or at the top of the sidebar (null). */
  pointers: Array<{ target: number; under: number | null }>;
  graph: Array<{ note: number; x: number; y: number }>;
  /** Notes that are review cards (the note's own function reference since #1586), with or without progress. */
  cards: number[];
  /** Progress on a card: the note is made a card too. */
  review: Array<{ note: number; due: string }>;
  prefs: Array<{ key: "nav" | "toolbarLayout.desktop" | "splitPane.desktop"; value: unknown }>;
  rss: Array<{ title: string; url: string; intervalMinutes: number; embed: boolean; alwaysFulltext: boolean; /** Notes saved from it. */ saved: number[] }>;
  attrs: ExtraAttrSpec[];
};

/** The tags a generated paragraph may carry as `{name}` (roundTripArb.ts blockSpec). */
export const BLOCK_TAG_NAMES = ["idea", "題目", "q-1"] as const;

const view = (layouts: ViewLayoutName[], note: fc.Arbitrary<number>, tag: fc.Arbitrary<number> | null): fc.Arbitrary<ViewSpec> => fc.record({
  layout: fc.constantFrom(...layouts),
  filters: fc.array(fc.record({
    field: fc.constantFrom("title", "status", "rating", "作者", "due"),
    op: fc.constantFrom(...FILTER_OP_NAMES),
    value: fc.option(fc.constantFrom("a", "高", "3", "2026-01-01"), { nil: undefined }),
  }), { maxLength: 2 }),
  sorts: fc.array(fc.record({ field: fc.constantFrom("title", "rating", "due"), dir: fc.constantFrom("asc" as const, "desc" as const) }), { maxLength: 2 }),
  groupBy: fc.option(fc.constantFrom("status", "rating", "作者"), { nil: null }),
  visibleFields: fc.array(fc.constantFrom("title", "status", "rating", "作者", "due"), { maxLength: 3 }).map((f) => [...new Set(f)]),
  layoutConfig: fc.oneof(
    fc.constant({}),
    fc.record({ card_size: fc.constantFrom("small", "large"), show_cover: fc.boolean() }),
    fc.record({ date_field: fc.constantFrom("due", "created"), week_start: fc.constantFrom(0, 1) }),
    fc.record({ opens_first: fc.boolean(), note: fc.constantFrom("中文", "ascii") }),
  ),
  pinOrder: fc.integer({ min: 0, max: 5 }),
  refs: fc.record({
    filterNote: fc.option(note, { nil: null }),
    filterTag: tag ? fc.option(tag, { nil: null }) : fc.constant(null),
    treeOpen: fc.array(note, { maxLength: 2 }),
    treeClosed: fc.array(note, { maxLength: 2 }),
  }),
});

const day = fc.date({ min: new Date("2025-01-01"), max: new Date("2028-12-31"), noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10));
const url = fc.constantFrom("a", "b", "c", "新聞").chain((host) => fc.constantFrom("feed.xml", "rss", "atom.xml").map((p) => `https://${encodeURIComponent(host)}.example.com/${p}`));

/** What to add to a world of `noteCount` notes and `tagCount` tags. Indices are into those lists. */
export function richSpec(noteCount: number, tagCount: number): fc.Arbitrary<RichSpec> {
  const note = fc.nat({ max: Math.max(0, noteCount - 1) });
  const tag = fc.nat({ max: Math.max(0, tagCount - 1) });
  const none = <T>() => fc.constant([] as T[]);
  return fc.record({
    blockTags: fc.constant(true),
    tagViews: tagCount ? fc.array(fc.record({ tag, view: view(TAG_LAYOUTS, note, tag) }), { maxLength: 4 }) : none<RichSpec["tagViews"][number]>(),
    noteViews: fc.array(fc.record({ note, view: view(NOTE_LAYOUTS, note, tagCount ? tag : null) }), { maxLength: 4 }),
    functions: tagCount ? fc.array(fc.record({
      tag, functionId: fc.constant("skills" as const),
      config: fc.option(fc.record({ new_per_day: fc.integer({ min: 1, max: 30 }) }), { nil: null }),
    }), { maxLength: 3 }) : none<RichSpec["functions"][number]>(),
    extendsLinks: tagCount > 1 ? fc.array(fc.record({ tag: fc.integer({ min: 1, max: tagCount - 1 }), roll: fc.nat({ max: 99 }) }), { maxLength: 2 })
      .map((rolls) => rolls.map((r) => ({ tag: r.tag, target: r.roll % r.tag }))) : none<RichSpec["extendsLinks"][number]>(),
    pointers: fc.array(fc.record({ target: note, under: fc.option(note, { nil: null }) }), { maxLength: 3 }),
    graph: fc.array(fc.record({ note, x: fc.integer({ min: -500, max: 2000 }), y: fc.integer({ min: -500, max: 2000 }) }), { maxLength: 3 }),
    cards: fc.array(note, { maxLength: 3 }).map((n) => [...new Set(n)]),
    review: fc.array(fc.record({ note, due: day }), { maxLength: 3 }),
    prefs: fc.array(fc.oneof(
      fc.record({ key: fc.constant("nav" as const), value: fc.record({ order: fc.shuffledSubarray(["notes", "tasks", "review", "calendar"], { minLength: 1 }), phone: fc.integer({ min: 0, max: 3 }) }) }),
      fc.record({ key: fc.constant("toolbarLayout.desktop" as const), value: fc.record({ bar: fc.constant(null), selection: fc.shuffledSubarray(["bold", "italic", "link"], { minLength: 1 }) }) }),
      fc.record({ key: fc.constant("splitPane.desktop" as const), value: fc.record({ right: fc.constant(null), ratio: fc.constantFrom(0.3, 0.5, 0.7) }) }),
    ), { maxLength: 3 }).map((prefs) => [...new Map(prefs.map((p) => [p.key, p])).values()]),
    rss: fc.array(fc.record({
      title: fc.constantFrom("科技新聞", "Blog", "週報 feed", "Dev"), url, intervalMinutes: fc.constantFrom(15, 60, 360),
      embed: fc.boolean(), alwaysFulltext: fc.boolean(), saved: fc.array(note, { maxLength: 2 }).map((n) => [...new Set(n)]),
    }), { maxLength: 2 }).map((subs) => subs.map((s, i) => ({ ...s, title: `${s.title} ${i}`, url: `${s.url}?n=${i}` }))),
    attrs: fc.array(fc.oneof(
      fc.record({ note, kind: fc.constant("text" as const), value: fc.constantFrom("一行字", "two\nlines 兩行") }),
      fc.record({ note, kind: fc.constant("number" as const), value: fc.constantFrom("0", "-3", "2.5", "1000000") }),
      fc.record({ note, kind: fc.constant("date" as const), value: day }),
      fc.record({ note, kind: fc.constant("bool" as const), value: fc.constantFrom("true", "false") }),
      fc.record({ note, kind: fc.constant("node_ref" as const), target: note }),
      fc.record({ note, kind: fc.constant("ink" as const), ink: fc.record({
        key: fc.constantFrom("ink_data" as const, "board_ink" as const, "note_ink" as const),
        strokes: fc.integer({ min: 0, max: 3 }), shapes: fc.integer({ min: 0, max: 2 }), salt: fc.nat({ max: 999 }),
      }) }),
      fc.record({ note, kind: fc.constant("inkset" as const), inks: fc.tuple(
        ...(["ink_data", "board_ink", "note_ink"] as const).map((key) => fc.record({
          key: fc.constant(key), strokes: fc.integer({ min: 0, max: 3 }), shapes: fc.integer({ min: 0, max: 2 }), salt: fc.nat({ max: 999 }),
        })),
      ) as fc.Arbitrary<[InkSpec, InkSpec, InkSpec]> }),
    ), { maxLength: 6 }),
  });
}

/** `view` without the references to trashed notes (a view naming a note in the trash is not what these properties are about). */
const liveRefs = (view: ViewSpec, live: (note: number) => boolean): ViewSpec => ({
  ...view, refs: { ...view.refs, filterNote: view.refs.filterNote !== null && live(view.refs.filterNote) ? view.refs.filterNote : null, treeOpen: view.refs.treeOpen.filter(live), treeClosed: view.refs.treeClosed.filter(live) },
});

/** Spec entries that name a trashed (or self-pointing) note are dropped: the trash and links have their own coverage,
 *  and a view or pointer of a note that is already in the trash is not what these properties are about. */
export function withoutTrashed(rich: RichSpec, trashed: boolean[]): RichSpec {
  const live = (i: number) => !trashed[i];
  return {
    ...rich,
    noteViews: rich.noteViews.filter((v) => live(v.note)).map(({ note, view }) => ({ note, view: liveRefs(view, live) })),
    tagViews: rich.tagViews.map(({ tag, view }) => ({ tag, view: liveRefs(view, live) })),
    // One pointer per (parent, target): the table is unique on it.
    pointers: rich.pointers.filter((p) => live(p.target) && (p.under === null || (live(p.under) && p.under !== p.target)))
      .filter((p, i, all) => all.findIndex((o) => o.target === p.target && o.under === p.under) === i),
    graph: rich.graph.filter((g) => live(g.note)),
    cards: rich.cards.filter(live),
    review: rich.review.filter((r) => live(r.note)),
    rss: rich.rss.map((s) => ({ ...s, saved: s.saved.filter(live) })),
    attrs: rich.attrs.filter((a) => live(a.note) && (a.kind !== "node_ref" || live(a.target))),
  };
}

/** An ink document of `strokes` strokes and `shapes` shapes, distinct per `salt` and per attribute key (so a drawing that comes back under another key shows). */
export function inkValue(ink: InkSpec): string {
  const doc: InkDocument = {
    version: 1, erased: {}, page: { width: 1000 },
    strokes: Array.from({ length: ink.strokes }, (_, i) => ({
      id: `s${ink.key}-${ink.salt}-${i}`, points: [[i, i], [i + 5, i + 9], [i + 12, i + 2]] as InkDocument["strokes"][number]["points"], color: i % 2 ? "#112233" : "#aa5500", size: 2 + i, toolId: "pen",
    })),
    ...(ink.shapes ? { shapes: Array.from({ length: ink.shapes }, (_, i) => ({ id: `h${ink.key}-${ink.salt}-${i}`, kind: i % 2 ? "ellipse" : "rectangle", start: [10 * i, 5] as [number, number], end: [60 + i, 70] as [number, number], color: "#336699", size: 2 })) } : {}),
  };
  return encodeInk(doc);
}


// ── Named losses ─────────────────────────────────────────────────────────────

const EMPTY: RichSpec = { blockTags: false, tagViews: [], noteViews: [], functions: [], extendsLinks: [], pointers: [], graph: [], cards: [], review: [], prefs: [], rss: [], attrs: [] };
const NO_REFS: ViewSpec["refs"] = { filterNote: null, filterTag: null, treeOpen: [], treeClosed: [] };
const plainView = (layout: ViewLayoutName, extra: Partial<ViewSpec> = {}): ViewSpec => ({
  layout, filters: [{ field: "status", op: "eq", value: "high" }], sorts: [{ field: "title", dir: "desc" }], groupBy: "status",
  visibleFields: ["title", "status"], layoutConfig: { card_size: "large" }, pinOrder: 2, refs: NO_REFS, ...extra,
});

/** Two tags (Alpha, Beta) and two notes with one paragraph each, plus `rich`: the smallest world a loss can be shown in. */
export function minimalWorld(rich: Partial<RichSpec>, paragraphTag: string | null = null): WorldSpec {
  const note = (title: string, tag: string | null) => ({
    title, parent: null, tags: [], attrs: [], trashed: false, media: false,
    blocks: [{ kind: "paragraph" as const, text: `${title} 的段落`, ref: null, tag }],
  });
  return {
    tags: [{ name: "Alpha", parent: null, functions: false }, { name: "Beta", parent: null, functions: false }],
    notes: [note("Note one", paragraphTag), note("Note two", null)],
    canvas: null,
    rich: { ...EMPTY, blockTags: paragraphTag !== null, ...rich },
  };
}

/** One loss a backup and restore has today, as the smallest world that shows it. `where` is where the cause is. The
 *  tests pin each as `it.fails`; when a fix lands the case turns red and the marker is deleted. */
export type RichLoss = { id: string; part: AppPart; scenario: string; expected: string; actual: string; where: string; world: WorldSpec };

export const RICH_LOSSES: RichLoss[] = [
  {
    id: "tag-views", part: "tagViews", world: minimalWorld({ tagViews: [{ tag: 0, view: plainView("table") }, { tag: 0, view: plainView("kanban", { groupBy: "rating" }) }] }),
    scenario: "A tag has two saved views (table and kanban, with filters, sort, grouping, columns and settings).",
    expected: "The restored tag shows the same two views.", actual: "The restored tag has no saved views.",
    where: "services/backupRestore.ts (~877-890): the tag's colour, schema and text are written back, `full.tag.views` is never read.",
  },
  {
    id: "note-views", part: "noteViews", world: minimalWorld({ noteViews: [{ note: 0, view: plainView("slides") }, { note: 0, view: plainView("calendar") }, { note: 1, view: plainView("gallery") }] }),
    scenario: "A note has saved views of its children: a slides tab, a calendar and (another note) a gallery.",
    expected: "The restored notes show the same views.", actual: "Only the whiteboard and handwriting tabs come back; every other view of a note is gone.",
    where: "services/backupRestore.ts whiteboardTabOf / handwritingTabOf (~319-340) and the `within` at ~1215: no other layout is written back from `full.views`.",
  },
  {
    id: "view-ids-tag", part: "tagViews", world: minimalWorld({ tagViews: [{ tag: 0, view: plainView("table", { refs: { ...NO_REFS, filterNote: 1, filterTag: 1 } }) }] }),
    scenario: "A tag's table filters on a note and on another tag.",
    expected: "After a restore into a workspace where every id is new, the filter names the restored note and tag.", actual: "The view comes back, but its filter still holds the old ids and matches nothing.",
    where: "services/backupRestore.ts withRestoredIds: a view's ids go through the restore's id map.",
  },
  {
    id: "view-ids-note-tab", part: "noteTabs", world: minimalWorld({ noteViews: [{ note: 0, view: plainView("canvas", { refs: { ...NO_REFS, filterNote: 1, treeOpen: [1], treeClosed: [0] } }) }] }),
    scenario: "A note's whiteboard tab remembers which sub-note branches were opened and closed, and filters on a note.",
    expected: "After a restore into a workspace where every id is new, the tab names the restored notes.", actual: "The tab comes back, but the branches and the filter still hold the old ids.",
    where: "services/backupRestore.ts withRestoredIds, applied where the note's views are restored.",
  },
  {
    id: "note-tab-settings", part: "noteTabs", world: minimalWorld({ noteViews: [{ note: 0, view: plainView("canvas") }, { note: 1, view: plainView("handwriting") }] }),
    scenario: "A note has a whiteboard tab and another a handwriting tab, each with a name, grouping, columns and a pin order.",
    expected: "The tabs come back as they were.", actual: "The tab comes back, but only its name and layout settings; grouping, columns, filters and pin order are reset.",
    where: "services/backupRestore.ts whiteboardTabOf (~319) returns only name and layoutConfig; addWhiteboardTab / addNoteLayoutTab (boardStore.ts ~184-203) write the rest empty.",
  },
  {
    id: "tag-functions", part: "tagFunctions", world: minimalWorld({ functions: [{ tag: 0, functionId: "skills", config: { new_per_day: 7 } }] }),
    scenario: "A tag refers to a function with settings of its own.",
    expected: "The restored tag refers to the same functions with the same settings.", actual: "The restored tag has no function.",
    where: "services/backupArchive.ts (~341): the archive has no function_refs at all (the tag's schema is saved, its refs are separate rows); nothing in backupRestore.ts writes them.",
  },
  {
    id: "tag-extends", part: "tagExtends", world: minimalWorld({ extendsLinks: [{ tag: 1, target: 0 }] }),
    scenario: "Tag Beta extends tag Alpha.",
    expected: "The restored Beta extends the restored Alpha.", actual: "The restored Beta extends nothing: the schema is written back with the old tag id, which does not exist in the new workspace.",
    where: "services/backupRestore.ts (~883): `full.tag.schema` goes to changeTagSchema unmapped, `schema.extends` holds source-workspace tag ids.",
  },
  {
    id: "tag-functions-inherited", part: "tagFunctions", world: minimalWorld({ functions: [{ tag: 0, functionId: "skills", config: { new_per_day: 3 } }], extendsLinks: [{ tag: 1, target: 0 }] }),
    scenario: "Alpha has the skills function; Beta extends Alpha, so Beta's page lists it too.",
    expected: "Both tags list the function after a restore.", actual: "Neither lists it (functions are not in the archive, `extends` is unmapped).",
    where: "services/backupArchive.ts (~341) and services/backupRestore.ts (~883), as the two cases above.",
  },
  {
    id: "pointers", part: "pointers", world: minimalWorld({ pointers: [{ target: 0, under: 1 }, { target: 1, under: null }] }),
    scenario: "The sidebar has a pointer to Note one under Note two, and a pointer to Note two at the top.",
    expected: "Both pointers are in the restored sidebar.", actual: "No pointer comes back.",
    where: "services/backupArchive.ts readSidecarRows (~230): note_pointers is never read; no sidecar field holds it.",
  },
  {
    id: "graph-positions", part: "graph", world: minimalWorld({ graph: [{ note: 0, x: 120, y: -40 }, { note: 1, x: 900, y: 450 }] }),
    scenario: "Two notes were dragged to places in the global graph.",
    expected: "The restored graph keeps the places.", actual: "No graph position comes back (counted in the report as skipped positions).",
    where: "services/backupRestore.ts (~1000): a position's `surface` is looked up among restored note ids; the surface \"graph\" is none, so it is skipped.",
  },
  {
    id: "empty-attribute", part: "attributes", world: minimalWorld({ attrs: [{ note: 0, kind: "text", value: "" }] }),
    scenario: "A note has a text attribute whose value is empty.",
    expected: "The restored note still has the attribute (empty).", actual: "The attribute is gone. Whether an empty value should be kept is the owner's call.",
    where: "services/backupRestore.ts attribute restore (restoredAttribute); not traced to a line.",
  },
];
