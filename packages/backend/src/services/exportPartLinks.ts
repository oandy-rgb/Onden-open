// A single note's part links `[[筆記/段落開頭]]` for a file that leaves Onden (docs/architecture/proposals/
// block-anchors-2026-11-01.md §10): which paragraph each link means is read the way the app reads it
// (@onden/markdown readBlockLink: the binding first, then the words), then @onden/markdown exportPartLinks writes the
// link for the option the person chose. Only notes the actor may read are named or quoted; a link whose paragraph
// cannot be read stays as written.

import { exportPartLinks, linkPathReadings, partLinkTargets, partPlainText, readBlockLink, type AnchorFacts, type BlockLinkEnv, type ExportedPart, type LinkNote, type PartLinkExportMode } from "@onden/markdown";
import { db } from "../dbKysely.js";
import type { ActorCtx } from "../types.js";
import { anchorsByIds } from "./blockAnchors/index.js";
import { canReadNode } from "./readPolicy.js";
import { wikilinkTargets } from "./wikilinkEdges.js";

/** `markdown` (the text of note `sourceId`, titled `title`) with its part links written for `mode`. */
export async function exportedWithPartLinks(
  actor: ActorCtx | null, workspaceId: string, sourceId: string, snapshot: { title: string; markdown: string }, mode: PartLinkExportMode,
): Promise<string> {
  const targets = partLinkTargets(snapshot.markdown);
  if (targets.length === 0) return snapshot.markdown;

  const bindings = new Map((await db.selectFrom("block_link_bindings").select(["link_text", "anchor_id"])
    .where("workspace_id", "=", workspaceId).where("note_id", "=", sourceId).execute()).map((b) => [b.link_text, b.anchor_id]));
  const anchors = await anchorsByIds(workspaceId, [...bindings.values()]);
  // The notes a link can name: by the app's rule (space, title, slug, alias); one note only, or the link is ambiguous.
  const names = [...new Set(targets.flatMap((t) => [t, ...linkPathReadings(t).map((r) => r.note)]).filter(Boolean))];
  const named = await wikilinkTargets(workspaceId, sourceId, names);
  const wanted = new Set<string>([sourceId, ...[...anchors.values()].map((a) => a.noteId), ...[...named.values()].flatMap((ids) => (ids.length === 1 ? ids : []))]);
  const rows = wanted.size === 0 ? [] : await db.selectFrom("content_nodes").select(["id", "title", "markdown"])
    .where("workspace_id", "=", workspaceId).where("id", "in", [...wanted]).where("deleted_at", "is", null).where("node_type", "=", "content").execute();
  const notes = new Map<string, LinkNote | "unreadable">();
  for (const row of rows) {
    if (row.id === sourceId) notes.set(row.id, { id: row.id, title: snapshot.title, markdown: snapshot.markdown });
    else notes.set(row.id, actor && (await canReadNode(actor, row.id)) ? { id: row.id, title: row.title, markdown: row.markdown } : "unreadable");
  }
  const env: BlockLinkEnv = {
    findNote: (name) => {
      const ids = named.get(name);
      const note = ids?.length === 1 ? notes.get(ids[0]!) : undefined;
      return note && note !== "unreadable" ? note : null;
    },
    note: (id) => notes.get(id) ?? null,
    binding: (source, key) => (source === sourceId ? bindings.get(key) ?? null : null),
    anchor: (id): AnchorFacts | null => {
      const a = anchors.get(id);
      return a ? { anchorId: id, noteId: a.noteId, from: a.from, to: a.to, status: a.status, candidate: a.candidate, quote: a.quote } : null;
    },
  };
  const resolve = (target: string): ExportedPart | null => {
    const read = readBlockLink(env, sourceId, target);
    if (read.kind !== "part" && read.kind !== "maybe") return null;
    const holder = notes.get(read.part.noteId);
    if (!holder || holder === "unreadable" || holder.markdown === null) return null;
    return {
      noteTitle: read.part.noteTitle,
      text: partPlainText(holder.markdown.slice(read.part.from, read.part.to)),
      anchorId: read.anchorId,
      ...(read.part.noteId === sourceId ? { here: { from: read.part.from, to: read.part.to } } : {}),
    };
  };
  return exportPartLinks(snapshot.markdown, mode, resolve).markdown;
}
