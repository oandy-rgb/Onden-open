// `![[drawing]]` embeds on the published site (grammar: @onden/markdown
// embeds.ts). The site shows an embedded drawing as a picture, and an embed
// of anything that isn't on the site as an inert placeholder — the same rule
// as an unpublished [[link]] (redaction.ts), so nothing private leaks.
//
// Two steps, so that a takedown still applies at once (model B,
// docs/architecture/site-render-model.md):
//   - publish (prepareDrawingEmbeds, from buildCandidate, after redaction and
//     the alias→slug rewrite): each published drawing that a published note
//     embeds is frozen into the snapshot as its picture (`drawing_svg` on the
//     drawing's node, @onden/markdown inkToSvg; an embed of a region of a page,
//     `![[x|ink=頁@x,y,w,h]]`, freezes only that part, `drawing_regions`, under the same
//     publish rule: the strokes of a note that is not published are never carried), and an embed that reaches it
//     only through an alias names it by its served slug instead
//     (`![[X.excalidraw]]` → `![[<slug>|X]]`), as aliasLinksBySlug does for
//     links, so no alias is published. Embeds of anything unpublished were
//     already made inert by redaction (redaction.ts drops their `!`);
//   - serve (serveDrawingEmbeds, from applyTakedown after the takedown filter
//     and redaction, and from the publish preview): an embed of a drawing
//     still on the site becomes an image of its frozen picture, one of a note
//     still on the site a link to it, and anything else the placeholder.
//     `drawing_svg` (and `drawing_regions`) is then dropped from the served nodes. The bodies of the
//     embeds that became links stay on the node as `embeds`, so a page can tell
//     "embeds a passage of this note" from "links to this note" (the
//     "Linked from" list); they are the node's own text, naming only pages
//     that are still on the site.
// The served markdown is plain Markdown (`![name](data:image/svg+xml…)`), so
// the site, the share link, the zip export and the static host all render it
// without knowing about embeds. Pages resolve as the site resolves links
// (@onden/markdown servedLinkTarget), so `![[name.excalidraw]]` names the
// imported drawing titled `name`.

import { embedLabel, embedMatches, formatInkRegion, servedLinkTarget, type EmbedMatch, type ServedPage } from "@onden/markdown";
import { inkRegionToSvg, inkToSvg } from "@onden/markdown/ink";
import { q } from "../../../db.js";
import { db } from "../../../dbKysely.js";

type EmbedNode = { id?: unknown; title?: unknown; slug?: unknown; markdown?: unknown; drawing_svg?: string; /** Pictures of the regions of this drawing that published notes quote, by region text (formatInkRegion). */ drawing_regions?: Record<string, string>; embeds?: string[] };

const pageOf = (n: EmbedNode, aliases?: readonly string[]): ServedPage => ({
  id: String(n.id), title: String(n.title ?? ""), slug: String(n.slug ?? ""), ...(aliases ? { aliases } : {}),
});

/** The `ink_data` of the notes among `ids` that hold their own handwriting: a
 *  note that is not a PDF (a PDF's envelope is drawn on its pages, not on its
 *  own). The one query behind both "a drawing embedded elsewhere" (here) and
 *  "a handwriting note's own pages" (handwritingPages.ts). */
export async function handwritingInkRows(workspaceId: string, ids: readonly string[]): Promise<Array<{ node_id: string; value: string }>> {
  if (ids.length === 0) return [];
  const rows = await q<{ node_id: string; value: string }>(
    `SELECT a.node_id::text, a.value FROM node_attributes a
      WHERE a.workspace_id = $1 AND a.node_id = ANY($2::uuid[]) AND a.key = 'ink_data'
        AND NOT EXISTS (SELECT 1 FROM node_attributes p WHERE p.node_id = a.node_id AND p.key = 'pdf_url')`,
    [workspaceId, ids],
  );
  return rows.rows;
}

/** An inert picture a Markdown image can carry inline (the renderers let
 *  data:image through on src, and an <img> never runs an SVG's script). */
const svgDataUri = (svg: string): string => `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;

/** What a reader sees instead of an embed of something not on the site: the
 *  author's label, else "(private)" — redaction.ts's rule for links. */
const placeholder = (m: EmbedMatch) => m.label ?? "(private)";

/** Characters that would end or split an embed body. */
const LINK_SYNTAX = /[[\]|#\n]/;

function rewriteEmbeds(markdown: string, replace: (m: EmbedMatch) => string | null): string {
  let out = "", last = 0;
  for (const m of embedMatches(markdown)) {
    const next = replace(m);
    if (next === null) continue;
    out += markdown.slice(last, m.start) + next;
    last = m.end;
  }
  return last === 0 ? markdown : out + markdown.slice(last);
}

/** Publish step, over the published set after redaction: freeze the picture
 *  of each published drawing a published note embeds (`drawing_svg` on the
 *  drawing's node) and name it, in the embed, by what the served site
 *  resolves without aliases. `aliases` (publishedAliases) are read here only;
 *  none is written to the payload. Mutates `nodes`. */
export async function prepareDrawingEmbeds(
  workspaceId: string,
  nodes: EmbedNode[],
  aliases?: ReadonlyMap<string, string[]>,
): Promise<void> {
  const withAliases = nodes.map((n) => pageOf(n, aliases?.get(String(n.id))));
  const bare = nodes.map((n) => pageOf(n));
  const found = new Map<EmbedNode, Array<{ m: EmbedMatch; page: ServedPage }>>();
  const embedded = new Set<string>();
  for (const n of nodes) {
    if (typeof n.markdown !== "string" || !n.markdown.includes("![[")) continue;
    for (const m of embedMatches(n.markdown)) {
      if (!m.target) continue; // `![[#^id]]`: this note
      const page = servedLinkTarget(m.target, withAliases, String(n.id));
      if (!page) continue; // redaction already made embeds of unpublished notes inert
      embedded.add(page.id);
      found.set(n, [...(found.get(n) ?? []), { m, page }]);
    }
  }
  if (embedded.size === 0) return;
  const rows = await handwritingInkRows(workspaceId, [...embedded]);
  const svgs = new Map(rows.map((r) => [r.node_id, inkToSvg(r.value)]));
  const rawOf = new Map(rows.map((r) => [r.node_id, r.value]));
  // The text boxes laid on a quoted page come along (the pictures do not: an SVG shown as an image loads no other file).
  const textRows = [...found.values()].some((hits) => hits.some(({ m }) => m.inkRegion))
    ? (await db.selectFrom("node_attributes").select(["node_id", "value"])
      .where("workspace_id", "=", workspaceId).where("node_id", "in", [...embedded]).where("key", "=", "page_text").execute())
      .map((r) => ({ node_id: String(r.node_id), value: r.value }))
    : [];
  const textOf = new Map(textRows.map((r) => [r.node_id, r.value]));
  for (const n of nodes) {
    const svg = svgs.get(String(n.id));
    if (svg) n.drawing_svg = svg;
  }
  // A quoted region is its own picture, frozen next to the whole drawing's.
  for (const hits of found.values()) {
    for (const { m, page } of hits) {
      const text = m.inkRegion && formatInkRegion(m.inkRegion);
      const raw = rawOf.get(page.id);
      const owner = nodes.find((n) => String(n.id) === page.id);
      if (!m.inkRegion || !text || !raw || !owner) continue;
      const picture = inkRegionToSvg(raw, m.inkRegion, { text: textOf.get(page.id) ?? null });
      if (picture.kind === "picture") owner.drawing_regions = { ...owner.drawing_regions, [text]: picture.svg };
    }
  }
  // An embed the served site would not resolve without aliases names the
  // drawing by its served slug (else its title), keeping what readers see.
  for (const [n, hits] of found) {
    const fromId = String(n.id);
    const byStart = new Map(hits.map((h) => [h.m.start, h.page]));
    n.markdown = rewriteEmbeds(n.markdown as string, (m) => {
      const page = byStart.get(m.start);
      if (!page || !svgs.get(page.id)) return null;
      if (servedLinkTarget(m.target, bare, fromId)?.id === page.id) return null;
      const name = [page.slug, page.title].find((x) => x && !LINK_SYNTAX.test(x) && servedLinkTarget(x, bare, fromId)?.id === page.id);
      const tail = (m.inkRegion && formatInkRegion(m.inkRegion)) || embedLabel(m);
      return name === undefined ? null : `![[${name}|${tail}]]`;
    });
  }
}

/** A Markdown image of a frozen drawing. The alt is the embed's label with
 *  brackets escaped; the picture is an inert data: image (the renderers let
 *  data:image through on src, and an <img> never runs an SVG's script). */
function drawingImage(m: EmbedMatch, svg: string): string {
  const alt = embedLabel(m).replace(/([[\]\\])/g, "\\$1");
  return `![${alt}](${svgDataUri(svg)})`;
}

/** Serve step, over the nodes still on the site (after redaction): an embed
 *  of a drawing among them becomes its picture, of another of them a link,
 *  of anything else the placeholder; `drawing_svg` is removed from every
 *  node. Resolves as the site does, without aliases. Mutates `nodes`. */
export function serveDrawingEmbeds(nodes: EmbedNode[]): void {
  const pages = nodes.map((n) => pageOf(n));
  const svgOf = new Map(nodes.map((n) => [String(n.id), n.drawing_svg]));
  const regionsOf = new Map(nodes.map((n) => [String(n.id), n.drawing_regions]));
  for (const n of nodes) {
    delete n.embeds;
    if (typeof n.markdown !== "string" || !n.markdown.includes("![[")) continue;
    const linked: string[] = [];
    n.markdown = rewriteEmbeds(n.markdown, (m) => {
      if (!m.target) return null;
      const page = servedLinkTarget(m.target, pages, String(n.id));
      if (!page) return placeholder(m);
      if (m.inkRegion) {
        // A quoted region: its frozen picture, or (page gone, nothing in it) nothing — never the whole drawing.
        const picture = regionsOf.get(page.id)?.[formatInkRegion(m.inkRegion) ?? ""];
        return picture ? drawingImage(m, picture) : m.label ?? "";
      }
      const svg = svgOf.get(page.id);
      if (svg) return drawingImage(m, svg);
      linked.push(m.body);
      return `[[${m.body}]]`; // a note on the site: a link to it, until the site shows notes in place
    });
    if (linked.length > 0) n.embeds = [...new Set(linked)];
  }
  for (const n of nodes) { delete n.drawing_svg; delete n.drawing_regions; }
}
