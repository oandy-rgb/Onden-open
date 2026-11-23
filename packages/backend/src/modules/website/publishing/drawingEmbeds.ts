// `![[drawing]]` embeds on the published site (grammar: @onden/markdown
// embeds.ts). The site shows an embedded drawing as a picture, and an embed
// of a note that isn't on the site as an inert placeholder — the same rule
// as an unpublished [[link]] (redaction.ts).
//
// The picture travels with the note that embeds it (owner 2026-11-20, after
// Quartz: the pictures a published note embeds are published with it, the
// privacy line is the excluded folder): a drawing in a space that does not
// publish still shows where a published note embeds it. Only the picture of
// exactly what is embedded leaves — the whole drawing for `![[drawing]]`, the
// quoted area for `![[drawing|ink=頁@x,y,w,h]]` — never its title, slug, id on
// the site, other pages or strokes outside the area; the drawing gets no page
// and no link. Who may lend a picture is publishedSet.pictureSourceIds (not
// 「不發布」, live, a space the site's owner owns) and, at publish, the
// publisher's read access. A PDF's pages are not drawn: the server has no PDF
// renderer, so an embed of a PDF note keeps the placeholder.
//
// Two steps, so that a takedown still applies at once (model B,
// docs/architecture/site-render-model.md):
//   - publish (carryEmbeddedPictures, from buildCandidate, BEFORE redaction,
//     which would make an embed of an unpublished drawing inert): each embed
//     of a drawing becomes `![label](onden-picture:<key>)` in the note's text
//     and its picture an entry of the note's `pictures` (`{ key,
//     source_node_id, svg }`), frozen as drawn now. The embed's own text (the
//     drawing's name) does not stay in the snapshot;
//   - serve (serveDrawingEmbeds, from applyTakedown after the takedown filter
//     and from the publish preview): a picture whose drawing may still lend it
//     (takenDown.servedPictureSources) becomes an inert data: image, any other
//     the author's label or the site's placeholder word; `pictures` is then
//     dropped, so no drawing id is served. An embed of a note still on the
//     site becomes a link to it, anything else the placeholder. The bodies of
//     the embeds that became links stay on the node as `embeds`, so a page can
//     tell "embeds a passage of this note" from "links to this note" (the
//     "Linked from" list); they are the node's own text, naming only pages
//     that are still on the site.
// The served markdown is plain Markdown (`![name](data:image/svg+xml…)`), so
// the site, the share link, the zip export and the static host all render it
// without knowing about embeds. Pages resolve as the site resolves links
// (@onden/markdown servedLinkTarget), so `![[name.excalidraw]]` names the
// imported drawing titled `name`.
//
// Snapshots stored before 2026-11-20 froze a published drawing's picture on
// the drawing's own node (`drawing_svg`, `drawing_regions`) and kept the
// embed; serveDrawingEmbeds still reads those until the next publish replaces
// the snapshot.

import { embedLabel, embedMatches, formatInkRegion, nodeRefId, servedLinkTarget, type EmbedMatch, type ServedPage } from "@onden/markdown";
import { inkPages, inkRegionToSvg, inkToSvg } from "@onden/markdown/ink";
import { sql } from "kysely";
import { q } from "../../../db.js";
import { db } from "../../../dbKysely.js";
import { readableAmong } from "../../../services/readPolicy.js";
import { nodeAliasesSql } from "../../../services/wikilinkEdges.js";
import type { ActorCtx } from "../../../types.js";
import { pictureSourceIds } from "./publishedSet.js";

/** One embedded picture a note carries (publish step), named in its text by `key`. */
type CarriedPicture = {
  key: string; source_node_id: string; svg: string;
  /** A whole drawing with more pages than its first: how many more (they are not drawn — the app's embed shows the
   *  first page too). Told in the publish preview; not served. */
  pages_not_shown?: number;
};

type EmbedNode = {
  id?: unknown; title?: unknown; slug?: unknown; markdown?: unknown;
  pictures?: CarriedPicture[];
  /** A snapshot from before 2026-11-20: a published drawing's picture on its own node. */
  drawing_svg?: string;
  /** The same, the quoted areas of it, by region text (formatInkRegion). */
  drawing_regions?: Record<string, string>;
  embeds?: string[];
};

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

/** Where a carried picture stands in a note's frozen text, until serveDrawingEmbeds draws it or puts the placeholder
 *  there. A scheme no renderer loads: should a copy ever skip the serve step, the sanitizer drops the address and
 *  nothing shows. */
const PICTURE_SCHEME = "onden-picture:";
const MARK_OPEN = `](${PICTURE_SCHEME}`;
const PICTURE_KEY = /^p\d{1,6}$/;

/** An embed's label as Markdown alt text: without brackets or backslashes, so it can neither end the alt early nor
 *  hide the mark's start (replacePictureMarks). */
const altOf = (label: string) => label.replace(/[[\]\\\n]/g, "");

/** `markdown` with every mark carryEmbeddedPictures wrote (`![alt](onden-picture:<key>)`) replaced by
 *  `replace(alt, key)`. Reads only those marks — no other image — and runs once over the text. */
function replacePictureMarks(markdown: string, replace: (alt: string, key: string) => string): string {
  let out = "", last = 0, at = markdown.indexOf(MARK_OPEN);
  while (at !== -1) {
    const start = markdown.lastIndexOf("![", at);
    const close = markdown.indexOf(")", at);
    const key = close === -1 ? "" : markdown.slice(at + MARK_OPEN.length, close);
    const alt = start === -1 ? "" : markdown.slice(start + 2, at);
    if (start >= last && PICTURE_KEY.test(key) && altOf(alt) === alt) {
      out += markdown.slice(last, start) + replace(alt, key);
      last = close + 1;
    }
    at = markdown.indexOf(MARK_OPEN, Math.max(last, at + 1));
  }
  return last === 0 ? markdown : out + markdown.slice(last);
}

/** The key of a drawing's first page (inkPages.ts): the page a whole-drawing embed draws, in the app and on the site. */
const FIRST_PAGE = "page";

/** A drawing an embed may name: a published page or a drawing the publisher may read. */
type DrawingRow = ServedPage & { published: boolean };

/** The drawings outside the published set that `actor` may read and that may lend their pictures
 *  (publishedSet.pictureSourceIds), each with its names: what an embed in a published note may show. Titles are
 *  read only to resolve embeds; none is written to the payload. */
async function readableDrawings(workspaceId: string, actor: ActorCtx | null, published: ReadonlySet<string>): Promise<DrawingRow[]> {
  if (!actor) return [];
  const rows = (await sql<{ id: string; title: string; slug: string; aliases: string[] }>`
    SELECT n.id::text AS id, n.title, n.slug, ${sql.raw(nodeAliasesSql("n"))} AS aliases
      FROM content_nodes n
     WHERE n.workspace_id = ${workspaceId}
       AND EXISTS (SELECT 1 FROM node_attributes a WHERE a.node_id = n.id AND a.key = 'ink_data')
       AND NOT EXISTS (SELECT 1 FROM node_attributes p WHERE p.node_id = n.id AND p.key = 'pdf_url')
     ORDER BY n.created_at ASC, n.id ASC`.execute(db)).rows.filter((r) => !published.has(r.id));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [lend, readable] = await Promise.all([pictureSourceIds(workspaceId, ids), readableAmong(actor, workspaceId, ids)]);
  return rows.filter((r) => lend.has(r.id) && readable.has(r.id)).map((r) => ({ ...r, published: false }));
}

/** Publish step, over the published set BEFORE redaction: each embed of a drawing in a published note becomes a
 *  picture the note carries (`pictures`), named in its text by a mark that holds the author's label only. An embed
 *  resolves as the site resolves links (servedLinkTarget, aliases included): a published page first, else a drawing
 *  `actor` may read and that may lend its picture; one by id (`onden://node/<id>`, a quoted area) names that note.
 *  An embed of a note that is not a drawing, of a PDF, or of an area with nothing in it is left as written: the
 *  ordinary rules (redaction, serveDrawingEmbeds) handle it. `aliases` (publishedAliases) are read here only.
 *  Mutates `nodes`. */
export async function carryEmbeddedPictures(
  workspaceId: string,
  nodes: EmbedNode[],
  actor: ActorCtx | null,
  aliases?: ReadonlyMap<string, string[]>,
): Promise<void> {
  const hosts = nodes.filter((n) => typeof n.markdown === "string" && n.markdown.includes("![["));
  if (hosts.length === 0) return;
  const published: DrawingRow[] = nodes.map((n) => ({ ...pageOf(n, aliases?.get(String(n.id))), published: true }));
  const publishedIds = new Set(published.map((p) => p.id));
  const privates = await readableDrawings(workspaceId, actor, publishedIds);
  const byId = new Map([...published, ...privates].map((p) => [p.id.toLowerCase(), p]));
  const resolve = (m: EmbedMatch, fromId: string): DrawingRow | null => {
    if (!m.target || m.blockId || m.heading) return null; // `![[#^id]]`, a passage: not a picture
    const id = nodeRefId(m.target);
    if (id) return byId.get(id) ?? null;
    return servedLinkTarget(m.target, published, fromId) ?? servedLinkTarget(m.target, privates, fromId);
  };
  const named = new Map<EmbedNode, Array<{ m: EmbedMatch; drawing: DrawingRow }>>();
  const wanted = new Set<string>();
  for (const n of hosts) {
    for (const m of embedMatches(n.markdown as string)) {
      const drawing = resolve(m, String(n.id));
      if (!drawing) continue;
      named.set(n, [...(named.get(n) ?? []), { m, drawing }]);
      wanted.add(drawing.id);
    }
  }
  if (wanted.size === 0) return;
  const inkRows = await handwritingInkRows(workspaceId, [...wanted]);
  if (inkRows.length === 0) return;
  const inkOf = new Map(inkRows.map((r) => [r.node_id, r.value]));
  // The text boxes laid on a quoted page come along (the pictures do not: an SVG shown as an image loads no other file).
  const quoted = [...named.values()].some((hits) => hits.some(({ m, drawing }) => m.inkRegion && inkOf.has(drawing.id)));
  const textOf = new Map(quoted
    ? (await db.selectFrom("node_attributes").select(["node_id", "value"])
      .where("workspace_id", "=", workspaceId).where("node_id", "in", [...inkOf.keys()]).where("key", "=", "page_text").execute())
      .map((r) => [String(r.node_id), r.value] as const)
    : []);
  const whole = new Map<string, string | null>();
  for (const [n, hits] of named) {
    const pictures: CarriedPicture[] = [];
    const keyOf = new Map<string, string>(); // one entry per distinct picture of this note
    const at = new Map<number, string>();
    for (const { m, drawing } of hits) {
      const raw = inkOf.get(drawing.id);
      if (raw === undefined) continue; // not a drawing (a note, a PDF): the ordinary rules
      const region = m.inkRegion && formatInkRegion(m.inkRegion);
      if (m.inkRegion && !region) continue;
      let svg: string | null;
      if (m.inkRegion) {
        const picture = inkRegionToSvg(raw, m.inkRegion, { text: textOf.get(drawing.id) ?? null });
        svg = picture.kind === "picture" ? picture.svg : null;
      } else {
        if (!whole.has(drawing.id)) whole.set(drawing.id, inkToSvg(raw));
        svg = whole.get(drawing.id) ?? null;
      }
      if (!svg) continue; // nothing drawn there: left as written
      const id = `${drawing.id}|${region ?? ""}`;
      let key = keyOf.get(id);
      if (!key) {
        key = `p${pictures.length + 1}`;
        keyOf.set(id, key);
        const more = m.inkRegion ? 0 : inkPages(raw).filter((page) => page.key !== FIRST_PAGE).length;
        pictures.push({ key, source_node_id: drawing.id, svg, ...(more > 0 ? { pages_not_shown: more } : {}) });
      }
      at.set(m.start, key);
    }
    if (pictures.length === 0) continue;
    n.markdown = rewriteEmbeds(n.markdown as string, (m) => {
      const key = at.get(m.start);
      return key ? `![${altOf(m.label ?? "")}](${PICTURE_SCHEME}${key})` : null;
    });
    n.pictures = pictures;
  }
}

/** What the serve step writes in place of what is not on the site: `privateText` for an embed with no label of its
 *  own (the site's language, siteWords), `drawingAlt` as the alt of a picture whose embed had no label. */
type EmbedWords = { privateText: string; drawingAlt: string };

/** Serve step, over the nodes still on the site (after redaction): each carried picture whose drawing `showsPicture`
 *  becomes an inert data: image, any other its label or `words.privateText`; an embed of a note among `nodes`
 *  becomes a link to it, of anything else the placeholder. `pictures` (and an old snapshot's `drawing_svg`,
 *  `drawing_regions`) is removed from every node. Resolves as the site does, without aliases. Mutates `nodes`. */
export function serveDrawingEmbeds(nodes: EmbedNode[], showsPicture: (drawingId: string) => boolean, words: EmbedWords): void {
  const pages = nodes.map((n) => pageOf(n));
  const svgOf = new Map(nodes.map((n) => [String(n.id), n.drawing_svg]));
  const regionsOf = new Map(nodes.map((n) => [String(n.id), n.drawing_regions]));
  const image = (alt: string, svg: string) => `![${alt || altOf(words.drawingAlt)}](${svgDataUri(svg)})`;
  for (const n of nodes) {
    delete n.embeds;
    if (typeof n.markdown !== "string") continue;
    let markdown = n.markdown;
    if (markdown.includes(PICTURE_SCHEME)) {
      const carried = new Map((n.pictures ?? []).map((p) => [p.key, p]));
      markdown = replacePictureMarks(markdown, (alt, key) => {
        const picture = carried.get(key);
        return picture && showsPicture(picture.source_node_id) ? image(alt, picture.svg) : alt || words.privateText;
      });
      n.markdown = markdown;
    }
    if (!markdown.includes("![[")) continue;
    const linked: string[] = [];
    n.markdown = rewriteEmbeds(markdown, (m) => {
      if (!m.target) return null;
      const page = servedLinkTarget(m.target, pages, String(n.id));
      if (!page) return m.label ?? words.privateText;
      if (m.inkRegion) {
        // An old snapshot's quoted region: its frozen picture, or (page gone, nothing in it) nothing — never the whole drawing.
        const picture = regionsOf.get(page.id)?.[formatInkRegion(m.inkRegion) ?? ""];
        return picture ? image(altOf(embedLabel(m)), picture) : m.label ?? "";
      }
      const svg = svgOf.get(page.id);
      if (svg) return image(altOf(embedLabel(m)), svg);
      linked.push(m.body);
      return `[[${m.body}]]`; // a note on the site: a link to it, until the site shows notes in place
    });
    if (linked.length > 0) n.embeds = [...new Set(linked)];
  }
  for (const n of nodes) { delete n.pictures; delete n.drawing_svg; delete n.drawing_regions; }
}

/** The drawings whose pictures `nodes` carry, once each. */
export function pictureSourcesOf(nodes: ReadonlyArray<EmbedNode>): string[] {
  return [...new Set(nodes.flatMap((n) => (Array.isArray(n.pictures) ? n.pictures.map((p) => p.source_node_id) : [])))];
}

type PreviewPicture = { source_id: string; node_ids: string[]; picture: string; pages_not_shown?: number };

/** Each distinct picture `nodes` carry — one per drawing and image, so two drawings that look the same (a drawing
 *  and its copy) are two rows, each with its own 「不公開」 — with the notes that show it: what the publish preview
 *  lists under 「會一起公開的圖」. `picture` is the data: address the site shows. */
export function carriedPictures(nodes: ReadonlyArray<EmbedNode>): PreviewPicture[] {
  const out = new Map<string, PreviewPicture>();
  for (const n of nodes) {
    for (const p of Array.isArray(n.pictures) ? n.pictures : []) {
      const id = `${p.source_node_id}|${p.svg}`;
      const entry = out.get(id) ?? {
        source_id: p.source_node_id, node_ids: [], picture: svgDataUri(p.svg),
        ...(p.pages_not_shown ? { pages_not_shown: p.pages_not_shown } : {}),
      };
      if (!entry.node_ids.includes(String(n.id))) entry.node_ids.push(String(n.id));
      out.set(id, entry);
    }
  }
  return [...out.values()];
}

/** The payload's list of the drawings whose pictures it carries (`picture_sources`, written by buildCandidate): a
 *  small array the takedown bookkeeping and the website module's hooks read instead of scanning every note's
 *  pictures. Each entry names its drawing as `source_node_id`, so a permanent delete drops it
 *  (purgedContent.withoutNodes). Null when there is none. */
export function pictureSourceList(nodes: ReadonlyArray<EmbedNode>): Array<{ source_node_id: string }> | null {
  const ids = pictureSourcesOf(nodes).sort();
  return ids.length > 0 ? ids.map((id) => ({ source_node_id: id })) : null;
}
