// Markdown export (depth audit D13: moved verbatim from routes/export.ts) —
// streams every non-hidden content node into a single
// zip archive. Each node becomes `{slug}.md` — under its parent's folder,
// `課程/演算法.md` (services/vaultPath.ts, D109: the rule the folder import
// reads back) — with a small YAML
// frontmatter (title, id, slug, tags, aliases, updated_at) and a
// link-rewriting pass that turns `onden://node/<uuid>` references into
// relative `./<path>.md` links so the archive is portable to any
// markdown vault. Every exported file is made self-contained in one pass
// (@onden/markdown bundleMedia, the publish bundle's pass too): each media
// reference (`/api/media/<file>`) in it — body links and embeds, and
// frontmatter values such as a PDF note's `pdf_url` or a media field — is
// copied into an `attachments/` folder and rewritten to
// `./attachments/<file>`, so the round-trip stays lossless (import added tags
// + media; export must give them back). A relation value (a note id) is
// written as `[[Title]]`, which the importer resolves back (D91).
//
// Frontmatter goes through @onden/markdown frontmatter.ts, the same codec the
// importer reads with, and a note has exactly one block: the export fields,
// then the note's attributes (its own frontmatter keys live there), then the
// body without its stored frontmatter. The zip is streamed with backpressure
// (services/archiveStream.ts): notes are read from the database a batch at a
// time while the reader keeps up, attachments from disk as they are added.
//
// The full backup (services/backupArchive.ts) is this same vault plus what
// Markdown cannot carry; writeVault serves both.
//
// A single note's Download/Copy Markdown (exportedSingleNoteFile, D52) is the
// same file the zip holds for it, except that media links stay server paths:
// the same index (vaultIndex "export"), file names (vaultBases) and rows.

import type archiver from "archiver";
import { q } from "../db.js";
import { log } from "../logger.js";
import type { ActorCtx } from "../types.js";
import { ArchiveClosed, pacedArchive, type ArchiveSink, type PacedArchive } from "./archiveStream.js";
import { canReadMedia } from "./mediaAccess.js";
import { readableScopeSql } from "./readPolicy.js";
import { spaceScopeSql } from "../spine/spaceScope.js";
import { PUBLISHED_KEY } from "./systemAttributes.js";
import { taskHostLiveSql } from "../spine/taskIdentity.js";
import { fullTagPath } from "./tagHierarchy.js";
import { mediaFiles } from "./mediaFiles.js";
import { isPersonAuthored } from "../spine/attributeSource.js";
import { folderDepth, vaultName, vaultPaths } from "./vaultPath.js";
import { writeStandaloneTasks } from "./exportTasks.js";
import { writeLeftOutReport } from "./exportLeftOut.js";
import { exportedWithPartLinks } from "./exportPartLinks.js";
import { anchorRowsForNotes } from "./blockAnchors/index.js";
import { noteInkFiles, withInkEmbeds } from "./exportInk.js";
import { holderViewsSql } from "./functionRefSql.js";
import type { TaskListLang } from "./taskListFile.js";
import { attributeValues, bundleMedia, linkNameKey, replaceWikilinks, linkSlug, splitWikilink, wikilinkNames, encodeValues, entryFor, entryValue, CHILD_KEY_PREFIX, isListValue, mediaRefs, readFrontmatter, writeFrontmatter, type FrontmatterEntry, type FrontmatterValue, isUuid, isSystemAttr, PUBLISH_OFF_KEY, PUBLISH_OFF_FALLBACK_KEY, publishOffEntry, fieldValue, UUID_SOURCE, INK_PAGE_ATTRS, parseInkRegion, writeLegacyIds, type PartLinkExportMode } from "@onden/markdown";
import { liveNodeSql, liveTagNodeSql, tagNodeSql } from "../spine/nodeSql.js";
import { isTag, isCanvas } from "@onden/markdown/contract";

export type ExportNode = {
  id: string;
  slug: string | null;
  title: string;
  markdown: string;
  updated_at: string;
  tags?: string[];
  aliases?: string[];
};

/** The way from a file `depth` folders down back to the archive root:
 *  "./" at the root, "../" per folder below it. */
const toRoot = (depth: number) => (depth > 0 ? "../".repeat(depth) : "./");

const LINK_TO_NODE = new RegExp(`!?\\[([^\\]]*)\\]\\(<?onden://node/(${UUID_SOURCE})>?(?:\\s+(?:"[^"]*"|'[^']*'))?\\)`, "gi");
const NODE_URL = new RegExp(`onden://node/(${UUID_SOURCE})`, "gi");

/** `onden://node/<id>` → the linked note's file, relative to a file `up`
 *  away from the archive root (toRoot). `baseById` holds each note's path
 *  from the root, sans `.md`. A link to a note the archive does not hold (in
 *  the trash, unreadable) would name a file that is not there, so it keeps
 *  its text and loses the link. */
export function rewriteLinks(markdown: string, baseById: Map<string, string>, up = "./"): string {
  return mapOutsideCode(markdown, (text) => text
    .replace(LINK_TO_NODE, (m, label: string, id: string) => (baseById.has(id) ? m : label))
    .replace(NODE_URL, (_m, id: string) => `${up}${linkPath(baseById.get(id) ?? id)}.md`));
}

/** A file path as a Markdown link target: a title-named file has spaces and
 *  brackets, which would end the link early (`%20`, `%28`…). */
const linkPath = (path: string) => path.replace(/[\s%()<>#?]/g, (c) => encodeURIComponent(c));

// A fenced block (to its closing fence, or the end) or an inline code span.
const CODE = /^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))|(`+)(?!`)[\s\S]*?(?<!`)\2(?!`)/gm;

/** `fn` over the text between code, which is quoted as written: a code
 *  sample showing an `onden://node/` link is not a link to rewrite. */
function mapOutsideCode(markdown: string, fn: (text: string) => string): string {
  let out = "";
  let at = 0;
  for (const m of markdown.matchAll(CODE)) {
    out += fn(markdown.slice(at, m.index)) + m[0];
    at = m.index + m[0].length;
  }
  return out + fn(markdown.slice(at));
}

/** Where an exported file at the archive root finds its copy of a media file. */
const attachmentPath = (file: string) => `./attachments/${file}`;

// Rewrite every media reference (`/api/media/<file>`, also behind an origin;
// grammar: @onden/markdown mediaRefs) → `./attachments/<file>` so the
// exported note points at the copied blob instead of a live backend URL.
// Mirrors the onden://node rewrite above — the archive must be self-contained.
export function rewriteMediaLinks(markdown: string): string {
  return bundleMedia(markdown, attachmentPath).content;
}

/** Keys the export writes itself; a stored frontmatter's copies are dropped. */
export const EXPORT_KEYS = new Set(["title", "id", "slug", "tags", "updated_at"]);
/** Export keys an author may also use for their own values (Zettel ids, custom slugs). */
const AUTHOR_KEYS = new Set(["id", "slug", "updated_at"]);
/** Attributes that are data, not text a vault can carry: drawings, PDF
 *  marks and the text boxes and pictures on pages (the full backup carries all of them).
 *  They don't go into the frontmatter (Markdown export is text). A PDF
 *  note's `pdf_url` does: the bundle pass copies the PDF into attachments/
 *  and the importer points it at the re-uploaded file. */
const DATA_ATTRIBUTES = new Set([...INK_PAGE_ATTRS, "pdf_annotations", "page_text", "page_images"]);
/* Only values a person authored (spine/attributeSource.ts isPersonAuthored:
 * set in the UI — any panel, a table cell, Website › Collections, legacy
 * `explicit` rows included — or in the frontmatter) go into the frontmatter.
 * Inline `key:: value`, older automation (the dispatcher) and values Onden computes
 * (derived defaults) stay where they come from: written as frontmatter they
 * would outrank their source after an import and stop following it. */

/** A stored value as frontmatter: a list (@onden/markdown attributeValues, the
 *  one multi-value codec, D117) as a YAML list, anything else as it is. */
function attributeValue(value: string): FrontmatterValue {
  return isListValue(value) ? attributeValues(value) : value;
}

const sameValue = (a: FrontmatterValue | undefined, b: FrontmatterValue) => JSON.stringify(a) === JSON.stringify(b);

/** A title a `[[link]]` carries whole: no character that ends or splits a
 *  link body, and nothing the link target would trim away. */
const linkableTitle = (title: string | undefined): title is string =>
  !!title && title === title.trim() && !/[[\]|#\r\n]/.test(title);

/** A relation value (value_type node_ref: a note id, or a JSON list of ids)
 *  means nothing outside this workspace, so it is written as `[[Title]]` (a
 *  list as a list of them): the link the importer resolves back to a note of
 *  the importing space (modules/importers/shared/relations.ts). `titleById` holds the
 *  exported notes; a value naming any other note (one the caller can't read,
 *  a trashed one) or a title a link can't carry keeps its id. */
export function relationsAsLinks<A extends { value: string; value_type?: string }>(attributes: A[], titleById: ReadonlyMap<string, string>): A[] {
  return attributes.map((a) => {
    if (a.value_type !== "node_ref") return a;
    const value = attributeValue(a.value);
    const ids = Array.isArray(value) ? value : [value];
    const titles = ids.map((id) => (isUuid(id) ? titleById.get(id) : undefined));
    if (!ids.length || !titles.every(linkableTitle)) return a;
    const links = titles.map((title) => `[[${title}]]`);
    return { ...a, value: Array.isArray(value) ? encodeValues(links) : links[0]! };
  });
}

/** The file name a note is written under, when it is not its title: the title
 *  had characters a file name cannot hold, was cut, or shares a folder with an
 *  earlier note of the same title (`Title 2`). Obsidian resolves `[[…]]` by
 *  file name, so that name must also resolve in Onden — it becomes an alias of
 *  the note (`fileNameAlias`) and links to the note are written with it
 *  (`wikilinksByFileName`). */
export function fileNameAlias(base: string, title: string): string | null {
  const name = base.slice(base.lastIndexOf("/") + 1);
  return title.trim() !== "" && linkNameKey(name) !== linkNameKey(title) ? name : null;
}

/** The notes `[[target]]` names in Onden: by title or slug (aliases are not in
 *  the index). */
type WikilinkIndex = { byName: Map<string, string[]>; bySlug: Map<string, string[]> };

export function wikilinkIndex(rows: ReadonlyArray<{ id: string; title: string; slug: string | null }>): WikilinkIndex {
  const byName = new Map<string, string[]>();
  const bySlug = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, id: string) => map.set(key, [...(map.get(key) ?? []), id]);
  for (const r of rows) {
    add(byName, linkNameKey(r.title), r.id);
    if (r.slug) add(bySlug, r.slug, r.id);
  }
  return { byName, bySlug };
}

/** `[[Title]]` → `[[File name|Title]]` where the one note it names is written
 *  under another file name (`fileNameAlias`), so the link still reaches that
 *  file in Obsidian and, through the alias, back in Onden. Links that already
 *  match their file, name no exported note or name several (the same title
 *  twice: Onden links both) stay as written; so do anchors (`#heading` is
 *  kept after the file name) and code. */
/** The `ink=…` part of a link body when its alias is a quoted area (splitWikilink hides it from `alias`), else null. */
function regionParamOf(body: string): string | null {
  const bar = body.indexOf("|");
  const param = bar < 0 ? null : body.slice(bar + 1);
  return param !== null && parseInkRegion(param) ? param : null;
}

export function wikilinksByFileName(markdown: string, index: WikilinkIndex, baseById: ReadonlyMap<string, string>, titleById: ReadonlyMap<string, string>): string {
  return mapOutsideCode(markdown, (text) => replaceWikilinks(text, (body, full) => {
    const { target: rawTarget, alias } = splitWikilink(body);
    const hash = rawTarget.indexOf("#");
    const page = (hash < 0 ? rawTarget : rawTarget.slice(0, hash)).trim();
    const anchor = hash < 0 ? "" : rawTarget.slice(hash);
    if (!page || page.includes("/")) return full;
    const ids = new Set<string>();
    for (const name of wikilinkNames(page)) {
      for (const id of index.byName.get(linkNameKey(name)) ?? []) ids.add(id);
      for (const id of index.bySlug.get(linkSlug(name)) ?? []) ids.add(id);
    }
    if (ids.size !== 1) return full;
    const id = [...ids][0]!;
    const base = baseById.get(id);
    const file = base === undefined ? null : fileNameAlias(base, titleById.get(id) ?? "");
    // The link already names the file (case aside), or the note has no file.
    if (file === null || linkNameKey(file) === linkNameKey(page)) return full;
    // A quoted area of a drawing (`![[Title|ink=頁@x,y,w,h]]`) keeps its area: it is no label, and dropping it would
    // turn the quote into the whole drawing.
    const region = alias !== null ? null : regionParamOf(body);
    return `[[${file}${anchor}|${region ?? alias ?? page}]]`;
  }));
}

/** `attributes` with the note's file name among its `aliases` (once). */
function withFileNameAlias<A extends { key: string; value: string; source?: string }>(attributes: A[], name: string | null): Array<A | { key: string; value: string; source: string }> {
  if (name === null) return attributes;
  const own = attributes.find((a) => a.key === "aliases");
  const names = own ? attributeValues(own.value) : [];
  if (names.some((a) => linkNameKey(a) === linkNameKey(name))) return attributes;
  const value = encodeValues([...names, name]);
  return [...attributes.filter((a) => a.key !== "aliases"), { key: "aliases", value, source: "frontmatter" }];
}

/** The exported file: one frontmatter block — title, id, slug, tags, then the
 *  note's stored frontmatter lines (kept verbatim unless an attribute was
 *  changed since) and its other text attributes, then updated_at — and the
 *  body without its stored frontmatter. Each key is written once: a stored
 *  block that repeats a key keeps its first line (the one the current value
 *  replaces), or the stale repeat would win on import, as it is read last.
 *  An attribute whose key is outside the attribute key grammar (D44: one
 *  stored before the grammar, or a CSV column such as "Due Date") is written
 *  with a "quoted" key, and a multi-line value as a quoted string with `\n`
 *  escapes; the codec (@onden/markdown frontmatter.ts) reads both back. */
export function exportedNoteFile(n: ExportNode, attributes: Array<{ key: string; value: string; source?: string }>, body: string): string {
  const stored = readFrontmatter(body) ?? { entries: [], body };
  const attrs = new Map(attributes
    .filter((a) => isPersonAuthored(a.source ?? "frontmatter"))
    .filter((a) => a.key !== "" && !isSystemAttr(a.key) && !a.key.startsWith(CHILD_KEY_PREFIX) && !EXPORT_KEYS.has(a.key) && !DATA_ATTRIBUTES.has(a.key))
    .map((a) => [a.key, attributeValue(a.value)] as const));
  // A stored id, slug or updated_at is the author's own (the importer drops
  // an Onden export's copies), so it stays and the export doesn't write its own.
  const authorOwn = new Set(stored.entries.flatMap((e) => (e.key && AUTHOR_KEYS.has(e.key) ? [e.key] : [])));
  const entries: FrontmatterEntry[] = [entryFor("title", n.title)];
  if (!authorOwn.has("id")) entries.push(entryFor("id", n.id));
  if (n.slug && !authorOwn.has("slug")) entries.push(entryFor("slug", n.slug));
  if (n.tags?.length) entries.push(entryFor("tags", n.tags));
  // A note kept off the site travels as `publish: false`, or the copy would take the space's default (the site's).
  // An author's own `publish` is never overwritten: a value that already says false stands as it is, any other
  // value stays and the mark goes in the fallback key (the import reads both).
  const keptOff = attributes.some((a) => a.key === PUBLISHED_KEY && a.value === "false");
  // The value the file ends up with: the attribute is the current one (an edit in the UI wins over stale text, below).
  const ownValue = attrs.get(PUBLISH_OFF_KEY) ?? fieldValue(stored.entries, PUBLISH_OFF_KEY);
  const own = Array.isArray(ownValue) ? ownValue[0] : ownValue;
  const marker = !keptOff || own?.trim().toLowerCase() === "false" ? null
    : publishOffEntry(own === undefined ? PUBLISH_OFF_KEY : PUBLISH_OFF_FALLBACK_KEY);
  const written = new Set<string>();
  for (const entry of stored.entries) {
    if (entry.key && ((EXPORT_KEYS.has(entry.key) && !authorOwn.has(entry.key)) || isSystemAttr(entry.key) || written.has(entry.key) || entry.key === PUBLISH_OFF_FALLBACK_KEY)) continue;
    const attr = entry.key ? attrs.get(entry.key) : undefined;
    // The attribute is the current value: an edit in the UI wins over stale text.
    entries.push(attr !== undefined && !sameValue(entryValue(entry), attr) ? entryFor(entry.key!, attr) : entry);
    if (entry.key) { attrs.delete(entry.key); written.add(entry.key); }
  }
  if (marker) entries.push(marker);
  for (const [key, value] of attrs) if (key !== PUBLISH_OFF_FALLBACK_KEY) entries.push(entryFor(key, value));
  if (!authorOwn.has("updated_at")) entries.push(entryFor("updated_at", n.updated_at));
  const text = stored.body.replace(/^(\r?\n)+/, "");
  return `${writeFrontmatter(entries)}\n${text}${text.endsWith("\n") ? "" : "\n"}`;
}

/** One row of what an archive holds, read up front without bodies so the
 *  file names (and the links between files) are known before any is written. */
export type VaultIndexRow = {
  id: string;
  slug: string | null;
  /** Its parent note: its file goes in that note's folder (vaultPaths). */
  parent_id: string | null;
  title: string;
  node_type: string;
  hidden: boolean;
  /** Deleted (in History, not purged): a backup puts it under .trash/. */
  deleted: boolean;
  /** Its `aliases`, decoded: a generated file name must not equal one (vaultPaths). */
  aliases?: string[];
  /** Whether the row has text of its own. A tag definition without any is data, not a note: a backup keeps it in
   *  .onden/ only, so a vault does not fill up with empty `tag-*.md` files. */
  has_text: boolean;
};

/** The empty day note the app makes by itself when a day is opened (the Today button, the journal) and nothing was
 *  ever put in it or on it: no text, tags, properties, links or notes inside. It is left out of an export and a
 *  backup, since the app makes it again on the day it is opened. A day with anything on it stays. The title test is
 *  the SQL spelling of @onden/markdown dayNoteDate. */
const EMPTY_DAY_NOTE_SQL = `(cn.node_type = 'content' AND cn.hidden = false AND cn.title ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND btrim(COALESCE(cn.markdown, '')) = ''
  AND NOT EXISTS (SELECT 1 FROM content_nodes child WHERE child.parent_id = cn.id)
  AND NOT EXISTS (SELECT 1 FROM node_tags nt WHERE nt.node_id = cn.id)
  AND NOT EXISTS (SELECT 1 FROM node_attributes na WHERE na.node_id = cn.id)
  AND NOT EXISTS (SELECT 1 FROM node_edges e WHERE e.source_node_id = cn.id OR e.target_node_id = cn.id))`;

/** Everything `actor` may read, for an archive. The Markdown export takes
 *  live, visible notes and tag pages that have text; a backup takes every readable row —
 *  hidden ones (tasks), canvases, and deleted notes the actor could bring
 *  back from History. Both are bounded by the combined read rule in SQL
 *  (Audit #1: role/space visibility ∩ bearer-token scope), not filtered
 *  afterwards. Ordered by title, so name clashes resolve the same way twice. */
export async function vaultIndex(actor: ActorCtx | null, workspaceId: string, scope: "export" | "backup"): Promise<VaultIndexRow[]> {
  const params: unknown[] = [workspaceId];
  let where: string;
  if (scope === "export") {
    // A tag page with no text of its own is not a note: its tag travels in each
    // note's frontmatter, and a file for it would come back as a plain note.
    where = `(cn.node_type = 'content' OR (${tagNodeSql("cn")} AND COALESCE(cn.markdown, '') <> ''))
             AND cn.hidden = false AND ${readableScopeSql(actor, "cn", params)}`;
  } else {
    const live = readableScopeSql(actor, "cn", params);
    // A retained row of a space the actor reads: what History offers them.
    const retained = spaceScopeSql(actor, "cn", params);
    where = `(${live} OR ((cn.deleted_at IS NOT NULL OR NOT ${taskHostLiveSql("cn")}) AND ${retained}))`;
  }
  const result = await q<VaultIndexRow>(
    `SELECT cn.id, cn.slug, cn.parent_id::text AS parent_id, cn.title, cn.node_type, cn.hidden,
            (cn.deleted_at IS NOT NULL OR NOT ${taskHostLiveSql("cn")}) AS deleted,
            btrim(COALESCE(cn.markdown, '')) <> '' AS has_text
       FROM content_nodes cn
      WHERE cn.workspace_id = $1 AND NOT ${EMPTY_DAY_NOTE_SQL} AND ${where}
      ORDER BY cn.title, cn.id`,
    params,
  );
  const aliasRows = await q<{ node_id: string; value: string }>(
    `SELECT node_id, value FROM node_attributes WHERE key = 'aliases' AND node_id = ANY($1::uuid[])`,
    [result.rows.map((r) => r.id)],
  );
  const aliasesById = new Map(aliasRows.rows.map((r) => [r.node_id, attributeValues(r.value)]));
  for (const row of result.rows) row.aliases = aliasesById.get(row.id) ?? [];
  return result.rows;
}

/** A note's full row, as an archive reads it a batch at a time. */
export type VaultNote = ExportNode & {
  node_type: string;
  parent_id: string | null;
  space_id: string | null;
  hidden: boolean;
  order_key: string;
  source_type: string;
  presentation: unknown;
  created_at: string;
  deleted_at: string | null;
  tag_color: string | null;
  tag_schema: unknown;
  collection_views: unknown;
  reserved_key: string | null;
};

export type VaultAttribute = { key: string; value: string; source: string; value_type: string; is_inheritable: boolean };

/** What writeVault hands a backup for each note, after its Markdown file. */
export type VaultNoteData = {
  note: VaultNote;
  attributes: VaultAttribute[];
  /** Its tag ids (live tags), in the order applied. */
  tagIds: string[];
  /** Its Markdown file's path in the archive, or null (no file: hidden
   *  rows, canvases). */
  file: string | null;
  /** Media files it references that went into attachments/. */
  media: string[];
};

export type VaultStats = { notes: number; attachments: number; tasks: number };

/** How an archive is written beyond which notes it holds. */
export type VaultOptions = {
  /** The language of the standalone task list's file and folder names. */
  lang?: TaskListLang;
};

/** Each note's file path in the archive, sans `.md`, by id: a live note
 *  under its parent's folder (services/vaultPath.ts vaultPaths — names
 *  unique per folder, the first in index order keeping a shared slug). Links
 *  and filenames use the same map. A deleted note's file is under .trash/
 *  (Obsidian's own trash folder name), flat, so a vault shows it as trash;
 *  a live note whose parent is deleted is at the root. In a backup, hidden
 *  rows, canvases and tag definitions without text get no file (and no entry), and are no folder either. */
export function vaultBases(index: VaultIndexRow[], backup: boolean): Map<string, string> {
  const files = index.filter((n) => !(backup && (n.hidden || isCanvas(n) || (isTag(n) && !n.has_text))));
  const baseById = vaultPaths(files.filter((n) => !n.deleted));
  const takenBases = new Set<string>();
  for (const n of files) {
    if (!n.deleted) continue;
    let base = `.trash/${vaultName(n)}`;
    if (takenBases.has(base)) base = `${base}-${n.id.slice(0, 6)}`;
    takenBases.add(base);
    baseById.set(n.id, base);
  }
  return baseById;
}

// Round-trip symmetry with import: re-emit the tag memberships (as
// hierarchical paths, e.g. projects/onden) and `aliases` attribute the
// importer wrote, so an export→import cycle preserves them. Tags live as
// node_tags join rows (tag = class_tag content_node); aliases live in
// node_attributes (source='frontmatter').

/** Live tag ids of each of `ids`, in the order applied. */
async function vaultTagIds(ids: string[]): Promise<Map<string, string[]>> {
  const tagIdsByNode = new Map<string, string[]>();
  const tagRows = await q<{ node_id: string; tag_id: string }>(
    `SELECT nt.node_id, nt.tag_id
       FROM node_tags nt
       JOIN content_nodes t ON t.id = nt.tag_id
        AND ${liveTagNodeSql("t")}
      WHERE nt.node_id = ANY($1::uuid[])
      ORDER BY nt.created_at, nt.tag_id`,
    [ids],
  );
  for (const row of tagRows.rows) tagIdsByNode.set(row.node_id, [...(tagIdsByNode.get(row.node_id) ?? []), row.tag_id]);
  return tagIdsByNode;
}

/** Tag ids → their hierarchical paths (e.g. projects/onden), memoised in `cache`. */
async function tagPaths(workspaceId: string, tagIds: string[], cache: Map<string, string>): Promise<string[]> {
  const tags: string[] = [];
  for (const tagId of tagIds) {
    let path = cache.get(tagId);
    if (path === undefined) {
      path = await fullTagPath(workspaceId, tagId);
      cache.set(tagId, path);
    }
    if (path) tags.push(path);
  }
  return tags;
}

/** Attributes of each of `ids`, ordered by key. */
async function vaultAttributes(ids: string[]): Promise<Map<string, VaultAttribute[]>> {
  const attributesByNode = new Map<string, VaultAttribute[]>();
  const attributeRows = await q<VaultAttribute & { node_id: string }>(
    `SELECT node_id, key, value, source, value_type, is_inheritable FROM node_attributes WHERE node_id = ANY($1::uuid[]) ORDER BY key`,
    [ids],
  );
  for (const { node_id, ...a } of attributeRows.rows) attributesByNode.set(node_id, [...(attributesByNode.get(node_id) ?? []), a]);
  return attributesByNode;
}

/** Notes read from the database per round trip. */
const BATCH = 100;

/** Write `index` into `out` as a Markdown vault: `<path>.md` per note, in
 *  its parent's folder (a deleted one under .trash/), each referenced media file once under
 *  attachments/ when `actor` may read it. With `backup`, every row is read
 *  (hidden rows and canvases get no Markdown file), media referenced outside
 *  the Markdown file (drawings, data attributes, page designs) is copied too,
 *  and `backup.note` runs after each note's file. A Markdown export (no
 *  `backup`) also holds the standalone tasks `actor` reads, as one list file
 *  (services/exportTasks.ts). Does not finish `out`. */
export async function writeVault(
  out: ArchiveSink,
  actor: ActorCtx | null,
  workspaceId: string,
  index: VaultIndexRow[],
  backup?: { note(data: VaultNoteData): Promise<void> },
  options: VaultOptions = {},
): Promise<VaultStats> {
  const baseById = vaultBases(index, !!backup);
  const titleById = new Map(index.map((n) => [n.id, n.title]));
  const deleted = new Set(index.filter((n) => n.deleted).map((n) => n.id));
  const links = wikilinkIndex(index.filter((n) => baseById.has(n.id) && !n.deleted));
  const tagPathCache = new Map<string, string>();

  // Dedupe media across notes — a blob shared by N notes is copied once. A
  // reference in a note the caller can read does not make the file theirs: the
  // same media rule as GET /api/media decides (readPolicy.ts canReadMedia).
  const mediaCopied = new Set<string>();
  const mediaChecked = new Map<string, boolean>();
  const copyMedia = async (file: string): Promise<boolean> => {
    if (mediaCopied.has(file)) return true;
    if (!mediaChecked.has(file)) mediaChecked.set(file, await canReadMedia(actor, file, workspaceId));
    if (!mediaChecked.get(file)) return false;
    // A media id is one path segment and never `.`/`..` (mediaRefs), so
    // it can't name anything outside the media storage.
    if (!await mediaFiles().info(file)) return false;
    await out.addMedia(file, `attachments/${file}`);
    mediaCopied.add(file);
    return true;
  };

  const inkNames = new Set<string>();
  let notes = 0;
  for (let at = 0; at < index.length; at += BATCH) {
    const ids = index.slice(at, at + BATCH).map((n) => n.id);
    const rows = (await q<VaultNote>(
      `SELECT id, slug, title, COALESCE(markdown, '') AS markdown, updated_at::text AS updated_at,
              created_at::text AS created_at, deleted_at::text AS deleted_at, node_type, parent_id::text,
              space_id::text, hidden, order_key, source_type, presentation, tag_color, tag_schema,
              ${holderViewsSql("content_nodes")} AS collection_views, reserved_key
         FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [workspaceId, ids],
    )).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));

    const tagIdsByNode = await vaultTagIds(ids);
    const attributesByNode = await vaultAttributes(ids);
    // A Markdown export is read by Obsidian and by Onden's own import: each paragraph's identity travels as the ` ^id`
    // at its line end (Obsidian's block id), which an import turns back into the same anchor. A backup keeps the text
    // as stored and carries the anchors in its sidecar instead.
    const anchorsByNote = new Map<string, Array<{ id: string; from: number; to: number }>>();
    if (!backup) {
      for (const a of await anchorRowsForNotes(workspaceId, ids)) {
        if (a.status === "valid") anchorsByNote.set(a.note_id, [...(anchorsByNote.get(a.note_id) ?? []), { id: a.anchor_id, from: a.from, to: a.to }]);
      }
    }

    for (const id of ids) {
      const n = byId.get(id);
      if (!n) continue; // purged since the index was read
      const tagIds = tagIdsByNode.get(id) ?? [];
      const attributes = attributesByNode.get(id) ?? [];
      const tags = await tagPaths(workspaceId, tagIds, tagPathCache);
      const base = baseById.get(id);
      const media = new Set<string>();
      let file: string | null = null;
      if (base !== undefined) {
        const up = toRoot(folderDepth(base));
        const anchors = anchorsByNote.get(id);
        const text = anchors ? writeLegacyIds(n.markdown, anchors).markdown : n.markdown;
        const body = wikilinksByFileName(rewriteLinks(text, baseById, up), links, baseById, titleById);
        // One bundle pass over the whole file, frontmatter included: a PDF
        // note's pdf_url and a media field travel like a body link.
        const { content, ids: refs } = bundleMedia(
          exportedNoteFile({ ...n, tags }, withFileNameAlias(relationsAsLinks(attributes, titleById), deleted.has(id) ? null : fileNameAlias(base, n.title)), body),
          (file) => `${up}attachments/${file}`,
        );
        for (const ref of refs) if (await copyMedia(ref)) media.add(ref);
        file = `${base}.md`;
        // A drawing travels as pictures in a Markdown export. A backup keeps the
        // note's text as stored and carries the strokes themselves in its sidecar.
        const drawings = backup ? [] : noteInkFiles(n, attributes, inkNames);
        for (const drawing of drawings) await out.addText(`attachments/${drawing.name}`, drawing.svg);
        await out.addText(file, withInkEmbeds(content, drawings, up));
      }
      if (backup) {
        // What the Markdown file leaves out still names files: a drawing's
        // images, a data attribute, a page design, a hidden row's body.
        const elsewhere = [n.markdown, ...attributes.map((a) => a.value), n.presentation ? JSON.stringify(n.presentation) : ""];
        for (const ref of elsewhere.flatMap(mediaRefs)) if (!media.has(ref) && await copyMedia(ref)) media.add(ref);
        await backup.note({ note: n, attributes, tagIds, file, media: [...media] });
      }
      notes++;
    }
  }
  // The standalone tasks (no host note, so not in the index above) are one
  // list file for a Markdown export; a backup carries them in its sidecars.
  const tasks = backup ? 0 : await writeStandaloneTasks(out, {
    actor, workspaceId, lang: options.lang ?? "zh-TW",
    taken: new Set([...baseById.values()].map((base) => `${base}.md`.toLowerCase())),
    noteFile: async (markdown) => {
      const up = toRoot(1);
      const { content, ids: refs } = bundleMedia(rewriteLinks(markdown, baseById, up), (file) => `${up}attachments/${file}`);
      for (const ref of refs) await copyMedia(ref);
      return content;
    },
  });
  if (!backup) await writeLeftOutReport(out, actor, workspaceId, options.lang ?? "zh-TW");
  return { notes, attachments: mediaCopied.size, tasks };
}

/** Write an archive in the background: `produce` fills it while the caller
 *  streams `out.archive`. A failure ends the stream broken (never a short zip
 *  that looks whole); a reader that went away just stops the producer. */
export function produceArchive(out: PacedArchive, what: string, produce: () => Promise<void>): void {
  void produce().then(() => out.finish()).catch((error: unknown) => {
    if (error instanceof ArchiveClosed) return;
    log.error("archive", `${what} failed`, { err: error });
    out.fail(error instanceof Error ? error : new Error(String(error)));
  });
}

/** The workspace as a Markdown zip for `actor`: every readable, non-hidden
 *  note (and tag page), the media they embed that `actor` may read, links
 *  rewritten to relative paths. Returns the archive, still being written —
 *  the caller streams it. The note list is read before this returns, so a
 *  failure to start answers as an error, not as a broken download. */
export async function buildMarkdownExport(actor: ActorCtx | null, workspaceId: string, options: VaultOptions = {}): Promise<archiver.Archiver> {
  const index = await vaultIndex(actor, workspaceId, "export");
  const out = pacedArchive();
  produceArchive(out, "markdown export", async () => { await writeVault(out, actor, workspaceId, index, undefined, options); });
  return out.archive;
}

/** One note as the zip writes it (D52: Download/Copy Markdown), for the
 *  caller's current `title` and `markdown` (an unsaved draft is exported as
 *  shown, as the HTML export does). The same frontmatter rule and note-link
 *  rewrite as `buildMarkdownExport`, relation fields as [[Title]] links like
 *  the zip; media references are left in their
 *  `/api/media/<file>` form, since a single file has no attachments folder —
 *  the client makes them absolute. The caller has checked `canReadNode`. */
export async function exportedSingleNoteFile(
  actor: ActorCtx | null, workspaceId: string, id: string, snapshot: { title: string; markdown: string },
  partLinks: PartLinkExportMode = "text",
): Promise<string | null> {
  const row = await q<{ slug: string | null; updated_at: string }>(
    `SELECT slug, updated_at::text AS updated_at FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()}`,
    [workspaceId, id],
  );
  if (!row.rows[0]) return null;
  const tags = await tagPaths(workspaceId, (await vaultTagIds([id])).get(id) ?? [], new Map());
  const stored = (await vaultAttributes([id])).get(id) ?? [];
  // Note links point at the files the zip would hold (`./<slug>.md`), and a
  // relation field names its notes as [[Title]] (relationsAsLinks): both read
  // the zip's index (the same rows, order and name rule), so only when the
  // note has either.
  const links = /onden:\/\/node\//.test(snapshot.markdown);
  const index = links || stored.some((a) => a.value_type === "node_ref") ? await vaultIndex(actor, workspaceId, "export") : [];
  // `[[筆記/段落開頭]]` means a binding the file cannot carry: written as the person chose (exportPartLinks.ts).
  const withParts = await exportedWithPartLinks(actor, workspaceId, id, snapshot, partLinks);
  const body = links ? rewriteLinks(withParts, vaultBases(index, false)) : withParts;
  const attributes = relationsAsLinks(stored, new Map(index.map((n) => [n.id, n.title])));
  return exportedNoteFile({ id, ...row.rows[0], ...snapshot, tags }, attributes, body);
}
