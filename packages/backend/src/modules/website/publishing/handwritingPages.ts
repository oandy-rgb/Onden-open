// A published handwriting note draws its own handwriting on its own page.
//
// Without this the page showed the note's Markdown (usually empty) and the
// strokes appeared only where another published note embedded the drawing
// (drawingEmbeds.ts). Same two steps, so a takedown still applies at once
// (model B, docs/architecture/site-render-model.md):
//   - publish (prepareHandwritingPages, from buildCandidate, over the published
//     set): each handwriting note (ink_data that is not a PDF's) gets
//     `ink_pages`, one served address per page, top to bottom. Only nodes of
//     the published set are read, so a private note's strokes never enter the
//     snapshot. Nothing is DRAWN here: a drawing of 10 000 strokes is ~17 MB of
//     SVG and ~2 s of a blocked process, and buildCandidate runs for every
//     preview, every publish and every Share menu. A page's file is named by
//     the drawing's hash, the page's key and INK_PAGE_RENDER_VERSION, so the
//     name is known without the picture; the candidate holds a `render` per
//     file (`PageFiles`) and the payload only the addresses;
//   - store (storeHandwritingPages): each file is drawn only when it is not
//     there yet, and written as media owned by its note, so the media rule
//     (mediaAccess.canReadMedia) shows it to the note's readers and, once on
//     the site, to everyone while the note is (snapshot_media). The preview
//     stores them too (outside any transaction), so it names the same
//     addresses a publish will and shows the pictures by address, not inline;
//     the publish finds them there. Once a publish has recorded the new
//     snapshot, the pages it no longer names are forgotten
//     (forgetReplacedPages);
//   - serve (serveHandwritingPages, after the takedown filter): `ink_pages`
//     becomes plain Markdown images after the note's text (handwritingPage.ts)
//     and is dropped from the node, so the site, the feed, the share link and
//     the zip all draw it without knowing about handwriting.

import { mediaUrl, handwritingPageMarkdown } from "@onden/markdown";
import { INK_PAGE_RENDER_VERSION, inkPages } from "@onden/markdown/ink";
import { q } from "../../../db.js";
import { removeMediaFiles, storeGeneratedMedia } from "../../../services/media.js";
import { sha256Hex } from "../../../utils.js";
import { handwritingInkRows } from "./drawingEmbeds.js";

type PageNode = { id?: unknown; markdown?: unknown; ink_pages?: string[] };

/** Handwriting page files all start with this: what tells them from an upload
 *  (whose names are opaque) when a replaced one is forgotten. */
const FILE_PREFIX = "ink-";

/** The files of a candidate's handwriting pages, by media file name. `render`
 *  draws the page; it is called only for a file that is not stored yet. */
export type PageFiles = Map<string, { nodeId: string; render: () => string }>;

/** Publish step: freeze the page addresses of each handwriting note among
 *  `nodes` (the published set, after redaction) and return the files to store.
 *  `onlyNoteId`: only that note (a single note's reader view). Mutates `nodes`.
 *  Draws nothing. */
export async function prepareHandwritingPages(workspaceId: string, nodes: PageNode[], onlyNoteId?: string): Promise<PageFiles> {
  const ids = nodes.map((n) => String(n.id)).filter((id) => onlyNoteId === undefined || id === onlyNoteId);
  const files: PageFiles = new Map();
  const byNode = new Map((await handwritingInkRows(workspaceId, ids)).map((r) => [r.node_id, r.value]));
  for (const node of nodes) {
    const value = byNode.get(String(node.id));
    if (value === undefined) continue;
    const pages = inkPages(value);
    if (pages.length === 0) continue;
    const drawing = sha256Hex(value);
    node.ink_pages = pages.map((page) => {
      const filename = `${FILE_PREFIX}${sha256Hex(`${INK_PAGE_RENDER_VERSION}:${workspaceId}:${node.id}:${drawing}:${page.key}`)}.svg`;
      files.set(filename, { nodeId: String(node.id), render: page.draw });
      return mediaUrl(filename);
    });
  }
  return files;
}

/** Make the files exist and be the notes' media: drawn when absent, then
 *  recorded as uploads of their notes. Draws nothing already stored. */
export async function storeHandwritingPages(workspaceId: string, files: PageFiles, actorId: string): Promise<void> {
  for (const [filename, { nodeId, render }] of files) {
    await storeGeneratedMedia({ workspaceId, filename, render, ownerNodeId: nodeId, uploaderActorId: actorId });
  }
}

/** After a publish recorded its snapshot (`kept`: the files it names), forget
 *  the workspace's handwriting page files that no stored page names: an
 *  edited drawing's old page, a preview's never published one. Only the latest
 *  snapshot is ever served or pushed (servedSite.loadServedSite). Runs in the
 *  publish's transaction; the bytes go once it commits (removeMediaFiles). */
export async function forgetReplacedPages(workspaceId: string, kept: ReadonlySet<string>): Promise<void> {
  const rows = await q<{ filename: string }>(
    `SELECT filename FROM media_uploads WHERE workspace_id = $1 AND starts_with(filename, $2) AND right(filename, 4) = '.svg'`,
    [workspaceId, FILE_PREFIX]);
  await removeMediaFiles(workspaceId, rows.rows.map((r) => r.filename).filter((name) => !kept.has(name)));
}

/** Serve step, over the nodes still on the site: `ink_pages` becomes images
 *  after the text, then goes. Mutates `nodes`. */
export function serveHandwritingPages(nodes: PageNode[]): void {
  for (const node of nodes) {
    const pages = node.ink_pages;
    delete node.ink_pages;
    if (!Array.isArray(pages) || pages.length === 0) continue;
    const images = pages.map((src, i) => handwritingPageMarkdown(i + 1, src));
    const text = typeof node.markdown === "string" ? node.markdown.trimEnd() : "";
    node.markdown = (text ? `${text}\n\n` : "") + images.join("\n\n");
  }
}
