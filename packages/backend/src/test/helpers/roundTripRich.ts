// The parts of a workspace the plain round-trip world (roundTripArb.ts) leaves out and a person would miss after a
// backup and restore: saved views on tags and notes (table, kanban, calendar, gallery, the slides tab, the whiteboard tab,
// the handwriting tab, with their settings), functions a tag refers to (with and without settings, passed on through
// `extends`), tag `extends`, the sidebar pointers, paragraph tags and anchors, review progress, personal settings, RSS
// subscriptions and the notes saved from them, graph positions, and attributes of every type, ink included.
//
// Three things, none of them a table dump:
//   richSpec      (roundTripRichSpec.ts) the generator (no database, no ids; things point at notes and tags by index like the rest of WorldSpec)
//   buildRich     writes a RichSpec through the services the app uses (views, functions, tag schema, pointers, graph)
//   readApp       reads a workspace back the way the app does — the sync bootstrap the client starts from, the views
//                 lists, the tag block list, the RSS source list, the review state — and turns every id into the
//                 title or tag path it names, so two workspaces can be compared by what a person sees.
//
// Additive to roundTripWorld.ts: a world with no `rich` part builds and reads exactly as before.

import { isUuid, legacyIdsIn } from "@onden/markdown";
import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { buildBootstrap } from "../../services/sync/index.js";
import { createNoteView } from "../../services/noteViews.js";
import { createTagView, listTagViews } from "../../services/tagViews.js";
import { listNoteViews } from "../../services/noteViews.js";
import { addFunction, functionsOf, setFunctionConfig } from "../../services/functionRefs.js";
import { patchTagSchema } from "../../services/tagWrites.js";
import { createPointer } from "../../services/pointers.js";
import { moveGraphPosition } from "../../services/boardWrites.js";
import { setNodeAttribute } from "../../services/attributeWrites.js";
import { tagBlocks } from "../../services/blockNodes.js";
import { subscriptionList } from "../../modules/rss/subscriptions.js";
import { readPref, writePref, type PrefKey } from "../../services/actorPrefs.js";
import { readReviewState } from "../../modules/review/state.js";
import { noteIsCard, setNoteCard } from "../../modules/review/cards.js";
import { seedQ } from "./seedQ.js";
import { inkValue, type RichSpec, type ViewSpec } from "./roundTripRichSpec.js";

type Built = { ws: string; actor: ActorCtx; noteIds: string[]; tagIds: string[] };

/** Write `rich` into a world already built (notes and tags exist; nothing is in the trash yet). */
export async function buildRich(rich: RichSpec, { ws, actor, noteIds, tagIds }: Built): Promise<void> {
  // Tag schema `extends` first, so a function added to the target is passed on and a restore has to map the ids.
  for (const link of rich.extendsLinks) {
    const tagId = tagIds[link.tag]!;
    const current = (await q<{ extends: unknown }>(`SELECT tag_schema->'extends' AS extends FROM content_nodes WHERE id = $1`, [tagId])).rows[0]?.extends;
    const have = Array.isArray(current) ? current as string[] : [];
    const target = tagIds[link.target]!;
    if (have.includes(target)) continue;
    await patchTagSchema({ actor, workspaceId: ws, tagId, uiContext: "test.roundtrip", patch: { extends: [...have, target] } });
  }
  for (const fn of rich.functions) {
    const { refId } = await addFunction({ actor, workspaceId: ws, holder: { kind: "node", id: tagIds[fn.tag]! }, functionId: fn.functionId });
    if (fn.config) await setFunctionConfig({ actor, workspaceId: ws, refId, config: fn.config });
  }
  const names = new Map<string, number>();
  const nameOf = (holder: string, v: ViewSpec) => { const n = (names.get(holder) ?? 0) + 1; names.set(holder, n); return `${v.layout} ${n}`; };
  // The ids a view names (a note or tag in a filter, the board tab's opened and closed branches) are written as the app writes them.
  const create = (v: ViewSpec, holder: string) => ({
    name: nameOf(holder, v), layout: v.layout, sorts: v.sorts, group_by: v.groupBy, visible_fields: v.visibleFields, pin_order: v.pinOrder,
    filters: [
      ...v.filters,
      ...(v.refs.filterNote === null ? [] : [{ field: "x_node_ref", op: "eq", value: noteIds[v.refs.filterNote]! }]),
      ...(v.refs.filterTag === null ? [] : [{ field: "tag", op: "eq", value: tagIds[v.refs.filterTag]! }]),
    ],
    layout_config: v.layout === "canvas" && (v.refs.treeOpen.length || v.refs.treeClosed.length)
      ? { ...v.layoutConfig, tree: { mode: "auto", depth: 2, open: v.refs.treeOpen.map((i) => noteIds[i]!), closed: v.refs.treeClosed.map((i) => noteIds[i]!) } }
      : v.layoutConfig,
  });
  for (const { tag, view } of rich.tagViews) await createTagView(actor, ws, tagIds[tag]!, create(view, tagIds[tag]!) as never);
  for (const { note, view } of rich.noteViews) await createNoteView(actor, ws, noteIds[note]!, create(view, noteIds[note]!) as never);

  for (const p of rich.pointers) await createPointer(actor, ws, { targetId: noteIds[p.target]!, parentId: p.under === null ? null : noteIds[p.under]! });
  for (const g of rich.graph) await moveGraphPosition(actor, ws, noteIds[g.note]!, { surface: "graph", x: g.x, y: g.y, width: null, height: null, color: null, folded: false } as never);

  const attrs = rich.attrs.flatMap((a) => a.kind === "inkset" ? a.inks.map((ink) => ({ note: a.note, kind: "ink" as const, ink })) : [a]);
  for (const a of attrs) {
    const nodeId = noteIds[a.note]!;
    const key = a.kind === "ink" ? a.ink.key : `x_${a.kind}`;
    const attribute = a.kind === "ink" ? { key, value: inkValue(a.ink), value_type: "text" as const }
      : a.kind === "node_ref" ? { key, value: noteIds[a.target]!, value_type: "node_ref" as const }
      : { key, value: a.value, value_type: a.kind };
    await setNodeAttribute({ workspaceId: ws, actor, nodeId, attribute: attribute as never });
  }

  // Review progress, personal settings and subscriptions: the rows the app's own screens write (a graded card, a saved
  // setting, a subscribed feed), written as the backup tests do because grading and subscribing need the clock and the network.
  for (const n of new Set([...rich.cards, ...rich.review.map((r) => r.note)])) await setNoteCard(actor, noteIds[n]!, true);
  for (const r of rich.review) await seedQ(`INSERT INTO review_states (workspace_id, node_id, actor_id, state) VALUES ($1, $2, $3, $4) ON CONFLICT (node_id, actor_id) DO NOTHING`, [ws, noteIds[r.note], actor.id, JSON.stringify({ due: r.due })]);
  for (const p of rich.prefs) await writePref(actor, p.key as PrefKey, p.value);
  const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [actor.id])).rows[0]!.id;
  for (const [i, sub] of rich.rss.entries()) {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO rss_subscriptions (workspace_id, space_id, title, url, created_by_actor_id, fetch_interval_minutes, embed, always_fulltext)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text`,
      [ws, personal, sub.title, sub.url, actor.id, sub.intervalMinutes, sub.embed, sub.alwaysFulltext])).rows[0]!.id;
    for (const n of sub.saved) {
      // A note saved from a feed keeps where it came from (modules/rss/sources.ts `_rss_source`).
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, '_rss_source', $3, 'text', 'ui') ON CONFLICT DO NOTHING`, [ws, noteIds[n], id]);
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, '_rss_guid', $3, 'text', 'ui') ON CONFLICT DO NOTHING`, [ws, noteIds[n], `guid-${i}-${n}`]);
    }
  }
}

// ── Reading back, as the app does ────────────────────────────────────────────

export type ShownView = { layout: string; name: string; filters: unknown; sorts: unknown; groupBy: unknown; visibleFields: unknown; layoutConfig: unknown; pinOrder: unknown };
export type AppSnapshot = {
  /** By tag path: what the tag page and the tag settings show. */
  tags: Array<{
    path: string;
    /** Paths of the tags it extends. */
    extends: string[];
    /** The functions it refers to itself, with the settings each holds (functionsOf: the tag's settings page). */
    functions: Array<{ id: string; from: string; config: unknown }>;
    /** The functions the tag page lists as it has them, passed on through `extends` included: function and the tag it comes from. */
    effective: Array<{ id: string; from: string }>;
    views: ShownView[];
    /** The paragraphs that carry it: note title and the paragraph's own text. */
    blocks: Array<{ note: string; label: string }>;
  }>;
  /** By title: tabs and views, attributes of every type (system `_` keys left out, except where a note was saved from), anchors. */
  notes: Array<{
    title: string;
    views: ShownView[];
    attributes: Array<{ key: string; type: string; value: string }>;
    /** Whether the note is a review card (its own function reference). */
    card: boolean;
    savedFrom: string | null;
    /** The block ids it has: its paragraph anchors and the `^id` marks typed in its text. */
    anchors: string[];
  }>;
  /** Sidebar pointers: target and parent by title. */
  pointers: Array<{ target: string; under: string | null }>;
  graph: Array<{ note: string; x: number; y: number }>;
};
/** What a workspace move carries for the person (backupExtras.ts): not part of an ordinary restore. */
export type PersonalSnapshot = {
  review: Array<{ note: string; state: string }>;
  prefs: Array<{ key: string; value: unknown }>;
  rss: Array<{ title: string; url: string; intervalMinutes: unknown; embed: unknown; alwaysFulltext: unknown; saved: string[] }>;
};

const byJson = <T>(list: T[]): T[] => [...list].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
/** `value` with every id in it (a string that is a note or tag id, anywhere inside) read as that note's title or tag's path,
 *  so a view that names a note shows the same in two workspaces; an id nothing here has reads "(missing)". */
const named = (value: unknown, nameOf: (id: string) => string): unknown =>
  typeof value === "string" ? (isUuid(value) ? nameOf(value) : value)
    : Array.isArray(value) ? value.map((v) => named(v, nameOf))
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, named(v, nameOf)]))
    : value;
const shown = (v: Record<string, unknown>, nameOf: (id: string) => string): ShownView => ({
  layout: String(v.layout), name: String(v.name), filters: named(v.filters, nameOf), sorts: v.sorts, groupBy: v.group_by ?? null, visibleFields: v.visible_fields,
  layoutConfig: named(v.layout_config, nameOf), pinOrder: v.pin_order,
});
const IGNORED_ATTRIBUTES = /^_/;

/** `ws` as `actor` sees it. */
export async function readApp(ws: string, actor: ActorCtx): Promise<AppSnapshot> {
  const boot = await buildBootstrap(actor, ws, { slimBodies: false }) as unknown as Record<string, Array<Record<string, unknown>>>;
  const nodes = boot.nodes!.map((n) => ({ id: String(n.id), title: String(n.title), type: String(n.node_type), typedMarks: new Set(legacyIdsIn(String(n.markdown ?? ""))) }));
  const titleOf = new Map(nodes.map((n) => [n.id, n.title]));
  const catalog = boot.tags!;
  const tagById = new Map(catalog.map((t) => [String(t.id), t]));
  const pathOf = (id: string): string => {
    const t = tagById.get(id);
    return t ? (t.parent_id && tagById.has(String(t.parent_id)) ? `${pathOf(String(t.parent_id))}/${String(t.name)}` : String(t.name)) : "(missing tag)";
  };
  const nameOf = (id: string) => titleOf.get(id) ?? (tagById.has(id) ? pathOf(id) : "(missing)");

  const tags: AppSnapshot["tags"] = [];
  for (const t of catalog) {
    const id = String(t.id);
    if (t.reserved_key || t.deleted_at) continue;
    const views = (await listTagViews(actor, ws, id) ?? []) as Array<Record<string, unknown>>;
    const blocks = (await tagBlocks(actor, ws, id, { limit: 200, offset: 0 } as never)).rows.map((b) => ({ note: b.note_title, label: b.label ?? "" }));
    tags.push({
      path: pathOf(id),
      extends: ((t.schema_extends as string[] | undefined) ?? []).map(pathOf).sort(),
      functions: byJson(((await functionsOf(actor, { kind: "node", id })) ?? []).filter((f) => f.instance === "").map((f) => ({ id: f.functionId, from: pathOf(f.sourceTagId), config: f.config }))),
      effective: byJson(((t.functions as Array<{ id: string; source_tag_id: string }> | undefined) ?? []).map((f) => ({ id: f.id, from: pathOf(f.source_tag_id) }))),
      views: views.map((v) => shown(v, nameOf)),
      blocks: byJson(blocks as Array<{ note: string; label: string }>),
    });
  }

  const attrRows = boot.attributes ?? [];
  const anchors = boot.note_anchors ?? [];
  const notes: AppSnapshot["notes"] = [];
  for (const n of nodes.filter((x) => x.type !== "class_tag")) {
    const views = (await listNoteViews(actor, ws, n.id) ?? []) as Array<Record<string, unknown>>;
    const own = attrRows.filter((a) => a.node_id === n.id);
    notes.push({
      title: n.title,
      views: views.map((v) => shown(v, nameOf)),
      attributes: byJson(own.filter((a) => !IGNORED_ATTRIBUTES.test(String(a.key))).map((a) => ({
        key: String(a.key), type: String(a.value_type), value: a.value_type === "node_ref" ? nameOf(String(a.value)) : String(a.value),
      }))),
      card: await noteIsCard(actor, n.id),
      savedFrom: own.some((a) => a.key === "_rss_source") ? "rss" : null,
      anchors: // A `^id` typed into a body and the anchor a restore makes of it are the same block reference, and the restore takes the
      // mark out of the text (so the place moves): the ids of both are compared, not the places.
      [...new Set([...n.typedMarks, ...anchors.filter((a) => a.note_id === n.id).map((a) => String(a.anchor_id))])].sort(),
    });
  }

  return {
    tags: tags.sort((a, b) => (a.path < b.path ? -1 : 1)),
    notes: notes.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)),
    pointers: byJson((boot.pointers ?? []).map((p) => ({ target: nameOf(String(p.target_id)), under: p.parent_id ? nameOf(String(p.parent_id)) : null }))),
    graph: byJson((boot.graph_positions ?? []).map((g) => ({ note: nameOf(String(g.nodeId ?? g.node_id)), x: Number(g.x), y: Number(g.y) }))),
  };
}

/** The person's own state a workspace move carries: review progress, settings, subscriptions (and notes saved from them). */
export async function readPersonal(ws: string, actor: ActorCtx): Promise<PersonalSnapshot> {
  const titles = new Map((await q<{ id: string; title: string }>(`SELECT id::text, title FROM content_nodes WHERE workspace_id = $1`, [ws])).rows.map((r) => [r.id, r.title]));
  const review: PersonalSnapshot["review"] = [];
  for (const id of titles.keys()) {
    const state = await readReviewState({ kind: "node", id }, actor.id);
    if (state !== undefined) review.push({ note: titles.get(id)!, state });
  }
  const prefs: PersonalSnapshot["prefs"] = [];
  for (const key of ["nav", "toolbarLayout.desktop", "splitPane.desktop"] as PrefKey[]) {
    const value = await readPref(actor, key);
    if (value !== null) prefs.push({ key, value });
  }
  const list = await subscriptionList(actor, ws) as unknown as { sources: Array<{ id: string; title: string; url: string; fetch_interval_minutes: unknown; embed: unknown; always_fulltext: unknown }> };
  const saved = (await q<{ source: string; node_id: string }>(`SELECT value AS source, node_id::text FROM node_attributes WHERE workspace_id = $1 AND key = '_rss_source'`, [ws])).rows;
  const rss = list.sources.map((s) => ({
    title: s.title, url: s.url, intervalMinutes: s.fetch_interval_minutes, embed: s.embed, alwaysFulltext: s.always_fulltext,
    saved: saved.filter((r) => r.source === s.id).map((r) => titles.get(r.node_id) ?? "(missing)").sort(),
  }));
  return { review: byJson(review), prefs: byJson(prefs), rss: byJson(rss) };
}

// ── Comparing ────────────────────────────────────────────────────────────────

/** The kinds of thing a person would miss, so a loss is named by what it is and a test can say which kinds it holds. */
export const APP_PARTS = [
  "tagViews", "noteViews", "noteTabs", "reviewCards", "tagFunctions", "tagExtends", "pointers", "graph", "anchors", "blockTags", "attributes", "ink",
] as const;
export type AppPart = typeof APP_PARTS[number];
const INK_KEYS = new Set(["ink_data", "board_ink", "note_ink"]);
const NOTE_TAB_LAYOUTS = new Set(["canvas", "handwriting"]);

/** Each part of `a` as a value two workspaces can be compared by. */
export function appParts(a: AppSnapshot): Record<AppPart, unknown> {
  return {
    tagViews: a.tags.map((t) => [t.path, t.views]),
    noteViews: a.notes.map((n) => [n.title, n.views.filter((v) => !NOTE_TAB_LAYOUTS.has(v.layout))]),
    noteTabs: a.notes.map((n) => [n.title, n.views.filter((v) => NOTE_TAB_LAYOUTS.has(v.layout))]),
    reviewCards: a.notes.map((n) => [n.title, n.card]),
    tagFunctions: a.tags.map((t) => [t.path, t.functions, t.effective]),
    tagExtends: a.tags.map((t) => [t.path, t.extends]),
    pointers: a.pointers,
    graph: a.graph,
    anchors: a.notes.map((n) => [n.title, n.anchors]),
    blockTags: a.tags.map((t) => [t.path, t.blocks]),
    attributes: a.notes.map((n) => [n.title, n.attributes.filter((x) => !INK_KEYS.has(x.key))]),
    ink: a.notes.map((n) => [n.title, n.attributes.filter((x) => INK_KEYS.has(x.key))]),
  };
}

/** The parts of `want` and `got` that differ, with both sides; `only` limits the comparison. */
export function appDifferences(want: AppSnapshot, got: AppSnapshot, only: readonly AppPart[] = APP_PARTS): Partial<Record<AppPart, { want: unknown; got: unknown }>> {
  const a = appParts(want), b = appParts(got);
  const out: Partial<Record<AppPart, { want: unknown; got: unknown }>> = {};
  for (const part of only) if (JSON.stringify(a[part]) !== JSON.stringify(b[part])) out[part] = { want: a[part], got: b[part] };
  return out;
}
