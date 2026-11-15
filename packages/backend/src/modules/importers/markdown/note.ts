import { basename } from "node:path";
import { q } from "../../../db.js";
import { db } from "../../../dbKysely.js";
import { syncFrontmatterAttributes } from "../../../services/nodes.js";
import { resolveOrCreateTagPath, TagNameShapeError } from "../../../services/tagHierarchy.js";
import { attachTagInTx } from "../../../services/tagMembershipWrites.js";
import { assertAuthority, AuthorityError } from "../../../spine/authority.js";
import { ScopeError } from "../../../spine/toolScope.js";
import { withEventTransaction } from "../../../spine/eventTransaction.js";
import { canReadNode } from "../../../services/readPolicy.js";
import { findImportedNotes, importedStateHashes, stampImportedNote, stampKeptOffApplied, keptOffAppliedFor, importSourceMeta } from "../shared/identity.js";
import { KEPT_OFF_SITE, PUBLISHED_KEY } from "../../../services/systemAttributes.js";
import { setNodeAttribute } from "../../../services/attributeWrites.js";
import type { ActorCtx } from "../../../types.js";
import { canPlaceUnder } from "../../../services/nodePlacement.js";
import { updateNode, NodeUpdateError } from "../../../services/nodeUpdate.js";
import { createNote, NoteCreateError } from "../../../services/noteCreate.js";
import { clampNoteTitle, fieldList, fieldValue, noteSizeProblem, normalizeText, readFrontmatter, writeFrontmatter, type FrontmatterEntry, isUuid, keepsOffSite, PUBLISH_OFF_FALLBACK_KEY, stripLegacyIds } from "@onden/markdown";
import type { AdoptAnchor } from "../../../services/blockAnchors/index.js";
import type { ImportSource } from "@onden/contract";

/** An Excalidraw drawing converted in the browser: the note's title and its
 *  handwriting page (an encoded ink_data value). Converted at import only —
 *  the original file is not kept. */
export type ImportedDrawing = { title: string; inkData: string };

async function currentInkData(workspaceId: string, nodeId: string): Promise<string | null> {
  return (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE workspace_id=$1 AND node_id=$2 AND key='ink_data'`, [workspaceId, nodeId])).rows[0]?.value ?? null;
}

async function hasPublishedFlag(nodeId: string): Promise<boolean> {
  return !!(await db.selectFrom("node_attributes").select("key").where("node_id", "=", nodeId).where("key", "=", PUBLISHED_KEY).executeTakeFirst());
}

/** invalid_tag_name: a frontmatter tag would be a new tag whose name cannot
 *  be a tag (tagHierarchy.ts assertTagNameShape); the note is not imported.
 *  too_large: the body is over the note cap (services/noteSize.ts).
 *  invalid_text: the text holds U+0000 or a lone surrogate, which cannot be stored. */
export type ImportConflictReason = "local_changes" | "history_incomplete" | "ambiguous" | "unavailable" | "invalid_tag_name" | "too_large" | "invalid_text";
/** `nodeId`: the note the file now is (created, updated or already equal).
 *  titleTruncated: the title (frontmatter or file name) was cut to the cap. */
export type NoteImportResult = { status: "imported" | "updated" | "unchanged"; nodeId: string; titleTruncated?: boolean } | { status: "refused"; reason: ImportConflictReason };

/** Import one Markdown file from an explicitly selected source. A changed file
 * updates only a unique, readable/writable target whose current state still
 * equals its last committed import baseline. Refusals commit no changes; unknown
 * failures throw after rollback. Callers neither find nodes nor build events.
 * Example: importMarkdownNote({ actor, workspaceId, source, file: { path, content }, parentId, reuse: true }). */
export async function importMarkdownNote(options: {
  actor: ActorCtx; workspaceId: string; source: ImportSource;
  file: { path: string; content: string; drawing?: ImportedDrawing }; parentId: string | null; reuse: boolean;
}): Promise<NoteImportResult> {
  const { actor, workspaceId, source, file, parentId, reuse } = options;
  const { drawing } = file;
  // `keptOff`: `publish: false` (what the export writes for a note kept off the site) is that note's own 「不發布」 again.
  const { title: fmTitle, tags, markdown: asWritten, keptOff } = importedNoteContent(file.content);
  // A vault's own `^id` marks (Obsidian block ids) are not kept in the text: each becomes an anchor of the same id
  // (stripLegacyIds). What is stored — and compared with the next import of the same file — is the text without them;
  // a body that cannot be shown to read the same without its marks keeps them as written.
  const converted = stripLegacyIds(asWritten);
  const markdown = "refused" in converted ? asWritten : converted.markdown;
  const adoptAnchors: AdoptAnchor[] = "refused" in converted ? [] : converted.anchors.filter((a) => !a.repeat)
    .map((a) => ({ anchorId: a.id, text: markdown.slice(a.from, a.to), at: a.from, kind: "new" as const }));
  // In NFC (D58): a macOS zip names its files decomposed, and the title must
  // match a [[link]] typed anywhere else (createNote normalises a new note's
  // title too; an update writes this one directly).
  const fullTitle = normalizeText(drawing?.title ?? fmTitle ?? basename(file.path).replace(/\.md$/i, ""));
  // A body is never cut; a derived title is (services/noteSize.ts).
  const sizeProblem = noteSizeProblem({ markdown, title: fullTitle });
  if (sizeProblem === "too_large") return { status: "refused", reason: "too_large" };
  if (sizeProblem === "contains_nul" || sizeProblem === "invalid_text") return { status: "refused", reason: "invalid_text" };
  const title = clampNoteTitle(fullTitle);
  const truncated = title !== fullTitle ? { titleTruncated: true } : {};
  try {
    return await withEventTransaction(workspaceId, async () => {
      await assertAuthority(actor, { kind: "any_space_write" });
      if (parentId && !(await canPlaceUnder(actor, workspaceId, parentId))) {
        throw new AuthorityError("node", "parent is not available in this workspace");
      }
      const matches = reuse ? await findImportedNotes(workspaceId,source,file.path) : [];
      if (matches.length > 1) return { status: "refused", reason: "ambiguous" };
      const existing = matches[0];
      if (existing) {
        if (existing.deleted_at || !(await canReadNode(actor,existing.id))) return { status: "refused", reason: "unavailable" };
        if (existing.title === title && existing.markdown === markdown
          && (!drawing || (await currentInkData(workspaceId, existing.id)) === drawing.inkData)) {
          // A file imported before the mark was read, unchanged since: the note still lacks it (public in a space that
          // publishes). Only a note with no answer yet is marked, and only if this file version was never marked:
          // a 「發布」 the person gave it since stays, and so does a note they put back on the site (mark removed).
          if (keptOff && !(await hasPublishedFlag(existing.id)) && !(await keptOffAppliedFor(existing.id, file.content))) {
            // The baseline moves with the mark only when the note was as imported until now: a no-op re-import must not
            // approve other edits (stampImportedNote), but a note refused later only for lacking the mark would be a trap.
            const asImported = !!existing.baseline && (await importedStateHashes(workspaceId, existing.id)).accepted.includes(existing.baseline);
            await setNodeAttribute({ workspaceId, actor, nodeId: existing.id, attribute: KEPT_OFF_SITE });
            if (asImported) await stampImportedNote(workspaceId, existing.id, source, file.path, file.content);
            else await stampKeptOffApplied(workspaceId, existing.id, file.content);
            return { status: "updated", nodeId: existing.id };
          }
          return { status: "unchanged", nodeId: existing.id };
        }
        await assertAuthority(actor, { kind: "node", nodeId: existing.id, op: "write_node" });
        if (!existing.baseline) return { status: "refused", reason: "history_incomplete" };
        const state = await importedStateHashes(workspaceId,existing.id);
        if (!state.accepted.includes(existing.baseline)) return { status: "refused", reason: "local_changes" };
      }
      // Resolve tags only after overwrite checks. These writes join the same
      // transaction, so rejection/storage failure cannot leave imported tags.
      const tagIds = await resolveFrontmatterTagIds(workspaceId,tags,actor);
      if (!existing) {
        // services/noteCreate.ts: the creator's space, slug and the create
        // chain; the import's tags and stamp ride the same NODE_CREATED.
        const created = await createNote({
          actor, workspaceId, title, markdown, parentId, adoptAnchors,
          // A drawing is a handwriting note: its page is the ink_data attribute.
          event: { uiContext: "import.obsidian", txMeta: importSourceMeta(source) },
          within: async ({ nodeId, eventId }) => { await attachTags(workspaceId, nodeId, tagIds, actor, eventId); },
          // The baseline hashes the note as created, so what the file sets (the handwriting page, 「不發布」) is written
          // first: a re-import of the unchanged file must find the state it recorded.
          afterDerived: async ({ nodeId, eventId }) => {
            if (drawing) await setNodeAttribute({ workspaceId, actor, nodeId, attribute: { key: "ink_data", value: drawing.inkData }, triggeredBy: eventId });
            if (keptOff) await setNodeAttribute({ workspaceId, actor, nodeId, attribute: KEPT_OFF_SITE, triggeredBy: eventId });
            await stampImportedNote(workspaceId, nodeId, source, file.path, keptOff ? file.content : null);
          },
        });
        return { status: "imported", nodeId: String(created.node.id), ...truncated };
      }
      // The same save as an edit (services/nodeUpdate.ts): slug, inverse
      // history and derived state follow the new title and body; the import's
      // tags, frontmatter and stamp ride the same NODE_UPDATED.
      const id = existing.id;
      await updateNode(workspaceId, id, { markdown, ...(existing.title !== title ? { title } : {}) }, {
        actor, adoptAnchors,
        event: {
          uiContext: "import.obsidian.update", txMeta: importSourceMeta(source),
          cascadeLabel: "import.obsidian.cascade", backupPrefix: "IMPORT (update)",
        },
        // The stamp hashes the body as the file has it (see the create path).
        within: async ({ eventId }) => {
          await attachTags(workspaceId,id,tagIds,actor,eventId);
          // Frontmatter lands in-tx so the import result already shows it; the
          // shared chain re-derives the rest after commit.
          await syncFrontmatterAttributes(workspaceId,id,markdown,actor,eventId);
          // An earlier import of the same drawing as Markdown becomes the
          // handwriting note (same note: identity is the source path).
          if (drawing) {
            await setNodeAttribute({ workspaceId, actor, nodeId: id, attribute: { key: "ink_data", value: drawing.inkData }, triggeredBy: eventId });
          }
          if (keptOff) await setNodeAttribute({ workspaceId, actor, nodeId: id, attribute: KEPT_OFF_SITE, triggeredBy: eventId });
          await stampImportedNote(workspaceId,id,source,file.path, keptOff ? file.content : null);
        },
      });
      return { status: "updated", nodeId: id, ...truncated };
    });
  } catch (error) {
    if (error instanceof AuthorityError || error instanceof ScopeError || error instanceof NoteCreateError || error instanceof NodeUpdateError) return { status: "refused", reason: "unavailable" };
    if (error instanceof TagNameShapeError) return { status: "refused", reason: "invalid_tag_name" };
    throw error;
  }
}

/** What a Markdown file becomes (@onden/markdown frontmatter.ts, the codec export
 *  writes with): `title` and `tags` turn into the note's title and tags; in an
 *  Onden export, `id`, `slug` and `updated_at` describe the copy and are
 *  dropped (in other notes they are the author's own and stay). Every
 *  other frontmatter line stays in the stored body byte for byte (nested maps,
 *  multi-line strings and empty keys included), where it keeps feeding the
 *  note's attributes. Export → import → export is stable. */
export function importedNoteContent(content: string): { title?: string; tags: string[]; markdown: string; keptOff?: boolean } {
  const fm = readFrontmatter(content);
  if (!fm) return { tags: [], markdown: content };
  // id, slug and updated_at describe an Onden export (a UUID id and an
  // updated_at timestamp, both written by services/exportZip.ts); in anyone else's note they
  // are the author's own fields and stay, as attributes.
  const fromOnden = isOndenExport(fm.entries);
  const consumed = fromOnden ? ONDEN_EXPORT_KEYS : NOTE_KEYS;
  const kept = fm.entries.filter((e) => !e.key || !consumed.has(e.key));
  const removed = kept.length !== fm.entries.length;
  return {
    title: fieldValue(fm.entries, "title"),
    tags: fieldList(fm.entries, "tags"),
    ...(keepsOffSite(fm.entries) ? { keptOff: true } : {}),
    // Untouched when nothing was consumed; otherwise the kept lines, verbatim.
    markdown: !removed ? content : writeFrontmatter(kept) + (kept.length ? fm.body : fm.body.replace(/^(\r?\n)+/, "")),
  };
}

/** title and tags become the note's own; an Onden export's id, slug and
 *  updated_at are dropped too. */
const NOTE_KEYS = new Set(["title", "tags", PUBLISH_OFF_FALLBACK_KEY]);
export const ONDEN_EXPORT_KEYS = new Set(["title", "tags", "id", "slug", "updated_at", PUBLISH_OFF_FALLBACK_KEY]);
/** A full timestamp as Postgres writes updated_at (date, time to the second). */
const ONDEN_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

/** Whether a frontmatter block is an Onden export's (services/exportZip.ts):
 *  a UUID `id` and an `updated_at` timestamp, both written by the export. */
export function isOndenExport(entries: FrontmatterEntry[]): boolean {
  return isUuid(fieldValue(entries, "id") ?? "") && ONDEN_TIMESTAMP_RE.test(fieldValue(entries, "updated_at") ?? "");
}

// Resolve a list of frontmatter tag NAMES to class_tag ids, creating any that
// don't exist (idempotent). Reuses the same hierarchy service the tag UI + the
// /resolve-path route use, so an Obsidian nested tag like "projects/onden"
// produces the proper parent→child chain — never a parallel tag path.
//
// Tag creation joins the enclosing import event transaction. Membership and
// TAG_APPLIED dispatch happen inside the node's create or update event; any failure
// rolls the whole note back. Empty paths need no lookup; other errors propagate.
async function resolveFrontmatterTagIds(
  workspaceId: string,
  tags: string[],
  actor: ActorCtx,
): Promise<string[]> {
  const ids: string[] = [];
  for (const name of tags) {
    const trimmed = name.trim();
    if (!trimmed.split("/").some(part => part.trim())) continue;
    const { leafId } = await resolveOrCreateTagPath(workspaceId, trimmed, actor);
    ids.push(leafId);
  }
  return ids;
}

// Attach resolved tag ids to a node, atomic with the node's create or update event.
// The full apply contract (attachTagInTx) for each new link, chained to the
// node's own event.
async function attachTags(
  workspaceId: string,
  nodeId: string,
  tagIds: string[],
  actor: ActorCtx,
  causeEventId: string,
): Promise<void> {
  for (const tagId of tagIds) {
    await attachTagInTx({ workspaceId, nodeId, tagId, actor, causeEventId });
  }
}
