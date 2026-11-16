// What a reader of the published site sees, and what changes between two
// snapshot payloads (D80). One reader view feeds both the publish preview's
// diff and the candidate hash, so the two can't disagree: a hash that differs
// always has a listed change behind it, and a change nobody sees (a bumped
// updated_at, a renumbered sort_order that keeps the order) neither shows in
// the preview nor stales it.
//
// Reader-visible: a note's title, slug, markdown, parent and label tags (and
// a drawing's picture, when a published note embeds it, and its query blocks'
// frozen lists, D113); its
// place among its siblings (the site's nav, D64); the published edges it is an
// end of (Related, backlinks, nav links). Not: node_type (no template reads
// it), raw sort_order/created_at (only the order they give), updated_at — it
// moves with every edit that changes the note, so a real edit is already
// listed; a bump alone (a private attribute, a no-op save) is no change. The
// stored snapshot still freezes the confirm-time updated_at, which is what the
// site's dates, sitemap lastmod and feed pubDate then show.

import { compareText, compareTitles } from "@onden/markdown";
import { compareOrdered } from "@onden/markdown/contract";
import { sha256Hex } from "../../../utils.js";
import type { PreviewNote } from "@onden/contract";

export type PayloadNode = {
  id: string; title?: string; slug?: string; markdown?: string; parent_id?: string | null; tags?: string[];
  /** The place among siblings: a key since migration 200 (and the stamp that breaks a tie); a snapshot from before has the integer. */
  order_key?: string; order_stamp?: string; sort_order?: number; created_at?: unknown;
  /** A published drawing's picture, as the notes embedding it show it (drawingEmbeds.ts). */
  drawing_svg?: string;
  /** Pictures of the parts of it that published notes quote (drawingEmbeds.ts). */
  drawing_regions?: Record<string, string>;
  /** A handwriting note's pages, one served address each (handwritingPages.ts). */
  ink_pages?: string[];
  /** Its query blocks' frozen results (queryBlocks.ts, D113). */
  query_blocks?: unknown[];
};
export type PayloadEdge = { source_node_id: string; target_node_id: string; edge_type: string };
type Payload = Record<string, unknown>;
/** JSON with object keys sorted (jsonb doesn't keep key order), for hashing and comparing. */
function canonicalJson(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v instanceof Date) return v.toISOString();
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(canonical(value));
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
export const nodesOf = (payload: Payload): PayloadNode[] => (Array.isArray(payload.nodes) ? payload.nodes as PayloadNode[] : []);
const edgesOf = (payload: Payload): PayloadEdge[] => (Array.isArray(payload.edges) ? payload.edges as PayloadEdge[] : []);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : "");
const previewNote = (n: PayloadNode): PreviewNote => ({ id: n.id, title: n.title ?? "", slug: n.slug ?? "" });

/** One note as its reader sees it. `parent`: null when the parent isn't on
 *  the site. `links`: the published edges it is an end of, in the payload's
 *  order (the order Related lists them), as direction:type:other note. */
function readerView(node: PayloadNode, publishedIds: ReadonlySet<string>, edges: readonly PayloadEdge[]) {
  return {
    title: node.title ?? "",
    slug: node.slug ?? "",
    markdown: node.markdown ?? "",
    // Only when there is one, so a site without embedded drawings hashes as before.
    ...(node.drawing_svg ? { drawing: node.drawing_svg } : {}),
    ...(node.drawing_regions ? { drawing_regions: node.drawing_regions } : {}),
    // Named by content, so a redrawn page is a changed note.
    ...(node.ink_pages?.length ? { ink_pages: node.ink_pages } : {}),
    // Likewise only when there is one: a query block's frozen list is what
    // its readers see of it.
    ...(node.query_blocks?.length ? { query_blocks: node.query_blocks } : {}),
    parent: node.parent_id && publishedIds.has(node.parent_id) ? node.parent_id : null,
    tags: [...(node.tags ?? [])].sort(),
    links: edges.flatMap((e) => e.source_node_id === node.id ? [`out:${e.edge_type}:${e.target_node_id}`]
      : e.target_node_id === node.id ? [`in:${e.edge_type}:${e.source_node_id}`] : []),
  };
}
type ReaderView = ReturnType<typeof readerView>;

/** Whether a publish would change what readers see of one note: its text,
 *  address, parent, tags, frozen lists and links, compared as siteDiff does
 *  (`changed` or `links_changed`). Not its place among its siblings, which
 *  needs the whole site. */
export function noteViewChanged(
  was: { node: PayloadNode; ids: ReadonlySet<string>; edges: readonly PayloadEdge[] },
  now: { node: PayloadNode; ids: ReadonlySet<string>; edges: readonly PayloadEdge[] },
): boolean {
  return !same(readerView(was.node, was.ids, was.edges), readerView(now.node, now.ids, now.edges));
}

/** The whole site as readers see it: each note's view, and each parent's
 *  children in the order the site lists them — the site's nav rule
 *  (frontend lib/childOrder): order_key, then its stamp, then id; a snapshot
 *  from before order keys has sort_order then created_at, one from before D64 neither and is listed by title. */
function readerSite(payload: Payload) {
  const nodes = nodesOf(payload);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = edgesOf(payload);
  const views = new Map<string, ReaderView>(nodes.map((n) => [n.id, readerView(n, ids, edges)]));
  const ordered = nodes.some((n) => n.sort_order !== undefined && n.sort_order !== null);
  const keyed = nodes.some((n) => n.order_key);
  const children = new Map<string, PayloadNode[]>();
  for (const n of nodes) {
    const parent = views.get(n.id)!.parent ?? "";
    children.set(parent, [...(children.get(parent) ?? []), n]);
  }
  const order = new Map<string, string[]>();
  for (const [parent, list] of children) {
    const sorted = [...list].sort((a, b) => (keyed
      ? compareOrdered(a, b)
      : ordered
      ? (a.sort_order ?? 0) - (b.sort_order ?? 0) || (iso(a.created_at) && iso(b.created_at) ? compareText(iso(a.created_at), iso(b.created_at)) : 0)
      : 0) || compareTitles(a.title ?? "", b.title ?? ""));
    order.set(parent, sorted.map((n) => n.id));
  }
  return { nodes, views, order };
}

/** The site's settings as frozen into a snapshot: name, home page, design. */
const settingsOf = (title: string, payload: Payload) => ({
  title, home: payload.home_node_id ?? null, presentation: payload.presentation ?? null,
});

/** Stable across rebuilds of the same content: sha256 of what readers see —
 *  the settings, every note's reader view and the sibling order. Everything
 *  else in the payload (updated_at, raw sort_order, side_effects, edge ids)
 *  is left out, as is the event cursor, so nothing readers can't see stales
 *  a preview. */
export function readerHash(title: string, payload: Payload): string {
  const site = readerSite(payload);
  return sha256Hex(canonicalJson({
    settings: settingsOf(title, payload),
    notes: Object.fromEntries(site.views),
    order: Object.fromEntries(site.order),
  }));
}

/** Indexes (into `seq`) of one longest increasing subsequence. */
function longestIncreasing(seq: readonly number[]): Set<number> {
  const tails: number[] = []; // tails[k]: index in seq ending the best run of length k+1
  const prev = new Array<number>(seq.length).fill(-1);
  seq.forEach((v, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]!]! < v) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const keep = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) keep.add(i);
  return keep;
}

export type SiteDiff = {
  added: PreviewNote[];
  removed: PreviewNote[];
  /** Title, address, text, parent or tags. */
  changed: PreviewNote[];
  /** Same parent, another place among its siblings: the fewest notes whose
   *  move explains the new order (a note added or removed moves nothing). */
  moved: PreviewNote[];
  /** Its published links (Related, backlinks, nav links) differ. */
  links_changed: PreviewNote[];
  settings_changed: boolean;
};

/** What a publish of `next` changes for readers of `last` (null: never published). */
export function siteDiff(last: { title: string; payload: Payload } | null, next: { title: string; payload: Payload }): SiteDiff {
  const a = readerSite(last?.payload ?? {});
  const b = readerSite(next.payload);
  const kept = b.nodes.filter((n) => a.views.has(n.id));
  const moved = new Set<string>();
  for (const [parent, ids] of b.order) {
    const before = a.order.get(parent) ?? [];
    const common = ids.filter((id) => before.includes(id));
    const keep = longestIncreasing(common.map((id) => before.indexOf(id)));
    common.forEach((id, i) => { if (!keep.has(i)) moved.add(id); });
  }
  return {
    added: b.nodes.filter((n) => !a.views.has(n.id)).map(previewNote),
    removed: a.nodes.filter((n) => !b.views.has(n.id)).map(previewNote),
    changed: kept.filter((n) => {
      const { links: _x, ...was } = a.views.get(n.id)!;
      const { links: _y, ...now } = b.views.get(n.id)!;
      return !same(was, now);
    }).map(previewNote),
    moved: kept.filter((n) => moved.has(n.id)).map(previewNote),
    links_changed: kept.filter((n) => !same(a.views.get(n.id)!.links, b.views.get(n.id)!.links)).map(previewNote),
    settings_changed: !!last && !same(settingsOf(last.title, last.payload), settingsOf(next.title, next.payload)),
  };
}
