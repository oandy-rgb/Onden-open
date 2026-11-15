// D9 privacy redaction for the published payload: inert wikilinks to
// unpublished nodes, scrubbed unpublished parents, and the published tag list.
// Extracted verbatim from the former publish route.

import { embedMatches, formatInkRegion, nodeRefId, aliasLinksBySlug, linkNamesNote, type FrozenQueryBlock, splitWikilink, scanWikilinks, wikilinkTarget, parseInkRegion } from "@onden/markdown";
import { q } from "../../../db.js";
import { takeDownDesign } from "./siteRows.js";
import { nodeAliasesSql } from "../../../services/wikilinkEdges.js";
import { liveNodeSql, tagNodeSql } from "../../../spine/nodeSql.js";

// D9: a published page's [[wikilink]] to a NON-published node would otherwise
// print that private node's TITLE as link text (and link to a 404). Neutralize
// at serve time: keep links whose target IS in the published set; for a target
// that is NOT published, drop the title — use the author's explicit alias if one
// was given (`[[Target|public label]]`), else redact to "(private)". This closes
// the "inert links to unpublished" leak in both the /api/site JSON and the
// rendered /site HTML (which renders from this same markdown).
//
// "Names a published note" is the app's one link rule (@onden/markdown
// linkNamesNote: title, slug or one of the note's `aliases`), the rule the
// wikilink edges follow, so a link that has a backlink also stays a link here.
//
// A link that names a node by id (`[[onden://node/<id>|label]]`, how a note
// links or embeds a task; @onden/markdown nodeRef) names no title, slug or
// alias, so it is always inert here — the id never reaches the site, and
// tasks are never published. publishRedaction.property pins it.
/** A wikilink that was made inert: its target as written, and what readers see instead. */
type InertLink = { target: string; shownAs: string };

/** A published note as the link rule reads it. `aliases` comes from
 *  publishedAliases(); it is not part of the published payload. */
export type PublishedName = { title?: unknown; slug?: unknown; aliases?: readonly string[] };

/** Whether a link target names one of `published`, memoised per target (one
 *  resolver serves every note of a payload). */
function publishedResolver(published: ReadonlyArray<PublishedName>): (target: string) => boolean {
  const notes = published.map((n) => ({
    title: String(n.title ?? ""),
    slug: n.slug == null ? null : String(n.slug),
    aliases: n.aliases ?? [],
  }));
  const seen = new Map<string, boolean>();
  return (target) => {
    const key = target.toLowerCase();
    let hit = seen.get(key);
    if (hit === undefined) {
      hit = notes.some((note) => linkNamesNote(target, note));
      seen.set(key, hit);
    }
    return hit;
  };
}

function inertWith(markdown: string, isPublished: (target: string) => boolean, onInert?: (link: InertLink) => void): string {
  if (typeof markdown !== "string" || !markdown.includes("[[")) return markdown;
  let out = "", last = 0;
  for (const m of scanWikilinks(markdown)) {
    // The note part only, as edges resolve it: `#Heading` and `#^block`
    // point inside the note. `[[#Heading]]` stays in this note.
    const target = wikilinkTarget(m.body);
    if (target === "" || isPublished(target)) continue;                    // published → keep
    const alias = splitWikilink(m.body).alias?.trim();
    // inert: alias or redacted. A quoted region of a drawing (`|ink=頁@x,y,w,h`) is no label: it never shows.
    const shownAs = alias && !parseInkRegion(alias) ? alias : "(private)";
    onInert?.({ target, shownAs });
    // An embed (`![[…]]`) of it reads the same, without its `!`.
    const start = m.start > 0 && markdown[m.start - 1] === "!" ? m.start - 1 : m.start;
    out += markdown.slice(last, start) + shownAs;
    last = m.end;
  }
  return last === 0 ? markdown : out + markdown.slice(last);
}

export function inertUnpublishedWikilinks(
  markdown: string,
  published: ReadonlyArray<PublishedName>,
  onInert?: (link: InertLink) => void,
): string {
  if (typeof markdown !== "string" || !markdown.includes("[[")) return markdown;
  return inertWith(markdown, publishedResolver(published), onInert);
}

/** The `aliases` attribute of each node in `ids` (wikilinkEdges reads them the same way). */
export async function publishedAliases(ids: readonly unknown[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const list = ids.filter((id): id is string => typeof id === "string" && id !== "");
  if (list.length === 0) return out;
  const rows = await q<{ id: string; aliases: string[] }>(
    `SELECT n.id::text AS id, ${nodeAliasesSql("n")} AS aliases
       FROM content_nodes n WHERE n.id = ANY($1::uuid[])`,
    [list],
  );
  for (const r of rows.rows) if (r.aliases.length > 0) out.set(r.id, r.aliases);
  return out;
}

/** Option 3 (user decision 2026-10-19): a published body's [[link]] that
 *  names a published note by one of its aliases is rewritten to name it by
 *  its served slug, keeping the visible text and any #fragment
 *  (@onden/markdown aliasLinksBySlug), so the site, its GitHub Pages copy and
 *  the zip open it while no alias is published — an alias no link uses stays
 *  private. `aliases` (publishedAliases) is read on the server only. A link
 *  to an unpublished note is redaction's (redactPayloadNodes). */
export function linkAliasesBySlug(
  nodes: Array<{ id?: unknown; title?: unknown; slug?: unknown; markdown?: unknown }>,
  aliases: ReadonlyMap<string, string[]>,
): void {
  const rewrite = aliasLinksBySlug(nodes.map((n) => ({
    id: String(n.id), title: String(n.title ?? ""), slug: String(n.slug ?? ""), aliases: aliases.get(String(n.id)),
  })));
  for (const n of nodes) if (typeof n.markdown === "string") n.markdown = rewrite(n.markdown, String(n.id));
}

/** The published nodes as the link rule reads them: each with its aliases. */
export function publishedNames(
  nodes: ReadonlyArray<{ id?: unknown; title?: unknown; slug?: unknown }>,
  aliases?: ReadonlyMap<string, string[]>,
): PublishedName[] {
  return nodes.map((n) => ({ title: n.title, slug: n.slug, aliases: aliases?.get(String(n.id)) }));
}

/** A quoted area of a note named by id (`![[onden://node/<id>|ink=…]]`, what the app writes when a title could not
 *  say which note) names a note that IS published by its slug instead, so the site resolves it as it does every
 *  link; one naming an unpublished note is left for the ordinary rule (inert). */
function nameRegionEmbedsBySlug(markdown: string, slugById: ReadonlyMap<string, string>): string {
  if (!markdown.includes("|ink=") || !markdown.includes(NODE_REF_MARK)) return markdown;
  let out = "", last = 0;
  for (const m of embedMatches(markdown)) {
    const id = m.inkRegion ? nodeRefId(m.target) : null;
    const slug = id ? slugById.get(id) : undefined;
    const region = m.inkRegion && formatInkRegion(m.inkRegion);
    if (!slug || !region || /[[\]|#\n]/.test(slug)) continue;
    out += markdown.slice(last, m.start) + `![[${slug}|${region}]]`;
    last = m.end;
  }
  return last === 0 ? markdown : out + markdown.slice(last);
}
const NODE_REF_MARK = "onden://node/";

/** `onInert` hears each link made inert, with the node it was in (the publish
 *  preview lists them). `aliases` (publishedAliases) lets a link that names a
 *  published note by one of its aliases stay a link. */
export function redactPayloadNodes(
  nodes: unknown,
  onInert?: (node: { id?: unknown; title?: unknown }, link: InertLink) => void,
  aliases?: ReadonlyMap<string, string[]>,
): void {
  if (!Array.isArray(nodes)) return;
  const pub = nodes as Array<{ id?: unknown; title?: unknown; slug?: unknown; markdown?: unknown }>;
  const isPublished = publishedResolver(publishedNames(pub, aliases));
  const slugById = new Map(pub.flatMap((n) => (typeof n.id === "string" && typeof n.slug === "string" && n.slug ? [[n.id.toLowerCase(), n.slug] as const] : [])));
  for (const n of pub) {
    if (typeof n.markdown === "string") n.markdown = nameRegionEmbedsBySlug(n.markdown, slugById);
    if (typeof n.markdown === "string") n.markdown = inertWith(n.markdown, isPublished, onInert && ((link) => onInert(n, link)));
  }
}

/** Takedown (servedSite.applyTakedown, and purgedContent for a stored snapshot): a frozen list names only pages that
 *  are still on the site — a listed note unpublished, trashed or made
 *  private since the publish leaves every list at once, as its page does —
 *  and the text a row carries (a table's cells, a block row's label) is made
 *  inert again against the pages still served, as the page text is. */
export function keepServedQueryRows(
  nodes: ReadonlyArray<{ id?: unknown; title?: unknown; slug?: unknown; query_blocks?: unknown }>,
  aliases?: ReadonlyMap<string, string[]>,
): void {
  const served = new Set(nodes.map((n) => n.id));
  const names = publishedNames(nodes, aliases);
  const inert = (text: string) => inertUnpublishedWikilinks(text, names);
  for (const node of nodes as Array<{ query_blocks?: unknown }>) {
    if (!Array.isArray(node.query_blocks)) continue;
    node.query_blocks = (node.query_blocks as FrozenQueryBlock[]).map((block) => ({
      ...block,
      rows: (Array.isArray(block.rows) ? block.rows : []).filter((row) => served.has(row.id)).map((row) => ({
        ...row,
        // Only a block row's title is typed text; a note row's is a page title.
        ...(row.note !== undefined && typeof row.title === "string" ? { title: inert(row.title) } : {}),
        ...(Array.isArray(row.values) ? { values: row.values.map((value) => typeof value === "string" ? inert(value) : value) } : {}),
      })),
    }));
  }
}

/** The ONE publishing rule for tags: the site shows a tag only when it is a
 *  live tag the owner has not hidden. Hiding is for tags only (the user's
 *  decision, D104): a hidden tag keeps every function inside the app but is
 *  never on the site — no chip on a page, no tag page. Every published
 *  tag query (chips below, the served site's takedown in servedSite.ts)
 *  filters with this, nothing else. */
export function siteShowsTagSql(alias: string): string {
  return `${tagNodeSql(alias)} AND ${liveNodeSql(alias)} AND ${alias}.hidden = false`;
}

/** Each node's shown tag titles (node_tags rows of tags siteShowsTagSql
 *  allows, with or without fields), deduped, in the order applied. The chips,
 *  the tag pages and the date rule (frames.date_tags) all read this one set. */
async function shownTagTitles(ids: string[]): Promise<Map<string, string[]>> {
  const labelRows = await q<{ node_id: string; title: string }>(
    `SELECT nt.node_id, t.title
     FROM node_tags nt
     JOIN content_nodes t ON t.id = nt.tag_id
       AND ${siteShowsTagSql("t")}
     WHERE nt.node_id = ANY($1)
     ORDER BY nt.created_at, t.title, t.id`,
    [ids],
  );
  const byNode = new Map<string, string[]>();
  for (const row of labelRows.rows) {
    const list = byNode.get(row.node_id) ?? [];
    if (!list.includes(row.title)) list.push(row.title);
    byNode.set(row.node_id, list);
  }
  return byNode;
}

// The tag source for the published payload: each node carries `tags` = its
// shown tag titles (shownTagTitles), deduped, hidden tags left out. Components
// read this ONE list and never parse markdown. A `#word` written in the text
// is not a tag (T10, user decision 2026-10-16), so it is not listed.
export async function attachPublishedTags(
  nodes: Array<{ id: string; tags?: string[] }>,
): Promise<void> {
  if (nodes.length === 0) return;
  const byNode = await shownTagTitles(nodes.map((n) => n.id));
  for (const n of nodes) n.tags = byNode.get(n.id) ?? [];
}

/** Serve-time takedown of a snapshot's tag chips: a node keeps only the
 *  frozen tags it still shows now (a tag hidden, removed or trashed since the
 *  Publish leaves at once). Only removes — a tag applied after the snapshot
 *  waits for the next Publish. */
export async function keepShownTags(nodes: Array<{ id?: unknown; tags?: unknown }>): Promise<void> {
  const ids = nodes.flatMap((n) => typeof n.id === "string" ? [n.id] : []);
  if (ids.length === 0) return;
  const byNode = await shownTagTitles(ids);
  for (const n of nodes) {
    if (!Array.isArray(n.tags)) continue;
    const now = new Set(typeof n.id === "string" ? byNode.get(n.id) ?? [] : []);
    n.tags = n.tags.filter((name) => typeof name === "string" && now.has(name));
  }
}

// D9: parent_id rides along for tree/breadcrumb components, but a parent that
// isn't itself in the published set must not leak — even as an opaque id.
export function scrubUnpublishedParents(nodes: unknown): void {
  if (!Array.isArray(nodes)) return;
  const pub = nodes as Array<{ id?: unknown; parent_id?: unknown }>;
  const ids = new Set(pub.map((n) => n.id).filter(Boolean));
  for (const n of pub) {
    if (n.parent_id != null && !ids.has(n.parent_id)) n.parent_id = null;
  }
}

/** `payload` (a stored snapshot already without the notes deleted for good) with every [[link]] to a page it no longer holds made
 *  inert again — in page text, the excerpt and field values of home and tag page rows, and the cells
 *  and block labels of frozen query lists — the same rules servedSite.applyTakedown runs at serve time (NodeHooks.snapshotPurged),
 *  so a gone note's title stays in no stored copy. Edits `payload` in place. */
export async function scrubStoredSnapshot({ payload: out }: { payload: Record<string, unknown> }): Promise<void> {
  const nodes = Array.isArray(out.nodes) ? out.nodes as Array<{ id?: unknown; title?: unknown; slug?: unknown; markdown?: unknown }> : [];
  const aliases = await publishedAliases(nodes.map((n) => n.id));
  redactPayloadNodes(nodes, undefined, aliases);
  keepServedQueryRows(nodes, aliases);
  const presentation = out.presentation as { design?: Record<string, unknown> } | null | undefined;
  const design = presentation?.design;
  if (design && typeof design === "object") {
    const names = publishedNames(nodes, aliases);
    const keptTags = new Set([...Object.keys((design.tag_pages ?? {}) as object), ...Object.keys((design.tag_names ?? {}) as object)]);
    presentation!.design = takeDownDesign(design, new Set(nodes.map((n) => String(n.id))), keptTags, {
      pages: new Map(nodes.map((n) => [String(n.id), { title: String(n.title ?? ""), markdown: String(n.markdown ?? "") }])),
      redact: (text) => inertUnpublishedWikilinks(text, names),
    });
  }
}

