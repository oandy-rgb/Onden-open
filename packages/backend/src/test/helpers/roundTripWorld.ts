// Build a generated WorldSpec (roundTripArb.ts) into Postgres through the same
// services the app uses, and read a workspace back as one comparable
// `WorldSnapshot`. The round-trip tests build a world, send it out (Markdown
// export, backup) and in again, and compare the two snapshots.
//
// A snapshot is keyed by title: the generator makes titles unique, so a title
// names a note on both sides of a trip, while ids never survive one.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { legacyBlockAnchors, stripLegacyIds } from "@onden/markdown";
import { q } from "../../db.js";
import { createNote } from "../../services/noteCreate.js";
import { createTag } from "../../services/tagHierarchy.js";
import { patchTagSchema } from "../../services/tagWrites.js";
import { trashNode } from "../../services/nodeTrash.js";
import { createStandaloneTask } from "../../services/standaloneTasks.js";
import { addWhiteboardTab, setNodePosition, whiteboardNoteSql } from "../../services/boardStore.js";
import { storeMedia } from "../../services/media.js";
import { MEDIA_DIR } from "../../services/mediaStore.js";
import { awaitAllDispatchers } from "../../services/dispatcherQueue.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "./persistActor.js";
import { setWorkspaceOwner } from "./setOwner.js";
import type { WorldSpec } from "./roundTripArb.js";
import { renderBody } from "./roundTripRender.js";
import { seedQ } from "./seedQ.js";
import { buildRich } from "./roundTripRich.js";
import { BLOCK_TAG_NAMES } from "./roundTripRichSpec.js";

// ── Workspaces ───────────────────────────────────────────────────────────────

/** A workspace of its own and its owner: an export or backup reads a whole
 *  workspace, and a fresh one starts empty, which an import "into an empty
 *  workspace" needs. */
export async function freshWorkspace(label: string): Promise<{ ws: string; actor: ActorCtx }> {
  const ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id::text`, [label, `${label}-${randomUUID()}`])).rows[0]!.id;
  const actor = await persistActor(ws, { id: "", name: `${label} owner`, type: "human", role: "editor" });
  await setWorkspaceOwner(ws, actor.id);
  return { ws, actor };
}

// ── Building ─────────────────────────────────────────────────────────────────

export type BuiltWorld = {
  ws: string;
  actor: ActorCtx;
  spec: WorldSpec;
  noteIds: string[];
  tagIds: string[];
  canvasId: string | null;
  /** The stored media file of each note that has one, by note index. */
  mediaFiles: Map<number, string>;
};

function pngBytes(seed: string): Promise<Buffer> {
  const n = createHash("sha1").update(seed).digest();
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: n[0]!, g: n[1]!, b: n[2]! } } }).png().toBuffer();
}

/** Create the world's tags, notes, canvas and trash in `ws` as `actor` (the
 *  workspace owner). */
export async function buildWorld(spec: WorldSpec, { ws, actor }: { ws: string; actor: ActorCtx }): Promise<BuiltWorld> {
  const tagIds: string[] = [];
  // Paragraph tags (`{idea}` at the end of a paragraph) name tags that exist.
  if (spec.rich?.blockTags) for (const name of BLOCK_TAG_NAMES) await createTag({ actor, workspaceId: ws, name });
  for (const [t, tag] of spec.tags.entries()) {
    const created = await createTag({ actor, workspaceId: ws, name: tag.name, parentId: tag.parent === null ? null : tagIds[tag.parent]! });
    tagIds.push(created.id);
    if (tag.functions) {
      await patchTagSchema({
        actor, workspaceId: ws, tagId: created.id, uiContext: "test.roundtrip",
        patch: {
          description: `functions of ${tag.name}`,
          // A field name is unique along a tag path, so each tag gets its own.
          fields: [{ name: `priority_${t}`, type: "select", options: ["low", "high"] }, { name: `score_${t}`, type: "number" }],
        },
      });
    }
  }

  const noteIds = spec.notes.map(() => randomUUID());
  const mediaFiles = new Map<number, string>();
  for (const [i, note] of spec.notes.entries()) {
    if (!note.media) continue;
    const stored = await storeMedia(await pngBytes(`${noteIds[i]}`), ".png", { actor, workspaceId: ws, origin: "upload" });
    if (!stored.ok) throw new Error(`media: ${stored.reason}`);
    mediaFiles.set(i, stored.filename);
  }

  for (const [i, note] of spec.notes.entries()) {
    const standard = note.attrs.filter((a) => /^[\p{L}_][\p{L}\p{M}\p{N}_-]*$/u.test(a.key));
    await createNote({
      actor, workspaceId: ws, id: noteIds[i], title: note.title,
      markdown: renderBody(note, i, spec, noteIds, mediaFiles.get(i)),
      parentId: note.parent === null ? null : noteIds[note.parent]!,
      tagIds: note.tags.map((t) => tagIds[t]!),
      attributes: standard.map((a) => ({ key: a.key, value: a.value, value_type: a.valueType })),
      event: { uiContext: "test.roundtrip" },
    });
    // A key outside the key grammar is how a CSV column ("Due Date") is
    // stored; the API refuses to make one, so the row is written as the CSV
    // import writes it.
    for (const a of note.attrs.filter((x) => !standard.includes(x))) {
      await seedQ(
        `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, $3, $4, 'text', 'ui')`,
        [ws, noteIds[i], a.key, a.value]);
    }
  }

  if (spec.rich) await buildRich(spec.rich, { ws, actor, noteIds, tagIds });

  let canvasId: string | null = null;
  if (spec.canvas) {
    canvasId = randomUUID();
    await createNote({
      // A canvas is a plain note with a whiteboard tab (migration 138).
      actor, workspaceId: ws, id: canvasId, title: spec.canvas.title,
      event: { type: "CANVAS_CREATED", targetType: "canvas", uiContext: "test.roundtrip" },
      within: ({ nodeId }) => addWhiteboardTab(nodeId),
    });
    for (const [n, card] of spec.canvas.cards.entries()) {
      await setNodePosition(ws, noteIds[card]!, canvasId, { x: 40 + n * 260, y: 30 + (n % 2) * 180, width: 240, height: 160, color: n % 2 ? "#336699" : null, folded: n === 2 });
    }
  }

  // Standalone tasks: the fields as T1's task editor stores them.
  for (const task of spec.tasks ?? []) {
    const fields: Record<string, string> = { _task_status: task.status };
    if (task.when) fields[task.whenKey] = task.when;
    if (task.deadline) fields._task_deadline = task.deadline;
    if (task.recur) fields._task_recur = task.recur;
    if (task.recurMode) fields._task_recur_mode = task.recurMode;
    if (task.evening) fields._task_evening = "true";
    if (task.someday) fields._task_someday = "true";
    if (task.remindAt) fields._task_remind_at = task.remindAt;
    const id = await createStandaloneTask({ actor, workspaceId: ws, title: task.title, markdown: task.body.join("\n\n"), fields, uiContext: "test.roundtrip" });
    if (task.trashed) await trashNode(actor, ws, id);
  }

  // The trash last, topmost trashed note first: its subtree goes with it.
  for (const [i, note] of spec.notes.entries()) {
    if (note.trashed && (note.parent === null || !spec.notes[note.parent]!.trashed)) await trashNode(actor, ws, noteIds[i]!);
  }
  await awaitAllDispatchers();
  return { ws, actor, spec, noteIds, tagIds, canvasId, mediaFiles };
}

// ── Reading back ─────────────────────────────────────────────────────────────

export type NoteSnapshot = {
  title: string;
  /** The title of its parent note, or null. */
  parent: string | null;
  deleted: boolean;
  /** The stored body with ids and media files replaced by what they name; `^id` marks left out (a mark typed into a body
   *  and the anchor an import makes of it are the same block reference, see blockRefs). */
  body: string;
  /** Full paths ("a/b") of its live tags, sorted. */
  tags: string[];
  /** Attributes a person can see (system `_` keys left out), by key. */
  attributes: Record<string, { value: string; type: string }>;
  /** Titles of the notes it links to ([[…]], node links), sorted. */
  links: string[];
  /** The block ids it has, sorted: anchors it holds plus any `^id` still written in its text (a note a person typed or an export carries them; import turns them into anchors). */
  blockRefs: string[];
};

export type TagSnapshot = { path: string; color: string | null; fields: unknown; description: unknown };
export type CanvasSnapshot = { title: string; deleted: boolean; cards: Array<{ note: string; x: number; y: number; width: number | null; height: number | null; color: string | null; folded: boolean }> };
/** A task (a hidden row made from a `- [ ]` line): where it hangs and its fields. */
export type TaskSnapshot = { title: string; host: string | null; deleted: boolean; body: string; attributes: Record<string, string> };
export type WorldSnapshot = { notes: NoteSnapshot[]; tags: TagSnapshot[]; canvases: CanvasSnapshot[]; tasks: TaskSnapshot[] };

const sha = (bytes: Buffer) => createHash("sha1").update(bytes).digest("hex").slice(0, 12);
const mediaHash = (file: string) => (existsSync(join(MEDIA_DIR, file)) ? sha(readFileSync(join(MEDIA_DIR, file))) : `missing:${file}`);

/** `markdown` without `^id` marks (nothing to take out when it cannot be done without changing what it reads). */
const withoutMarks = (markdown: string): string => {
  const out = stripLegacyIds(markdown);
  return "refused" in out ? markdown : out.markdown;
};

/** The workspace as one comparable value. Titles stand in for ids, a media
 *  file for its bytes' hash. */
export async function snapshotWorkspace(ws: string): Promise<WorldSnapshot> {
  const nodes = (await q<{ id: string; title: string; markdown: string; parent_id: string | null; deleted: boolean; node_type: string; parent_type: string | null; board: boolean }>(
    `SELECT n.id::text, n.title, COALESCE(n.markdown, '') AS markdown, n.parent_id::text, n.deleted_at IS NOT NULL AS deleted, n.node_type, p.node_type AS parent_type,
            (${whiteboardNoteSql("n")}) AS board
       FROM content_nodes n LEFT JOIN content_nodes p ON p.id = n.parent_id
      WHERE n.workspace_id = $1 AND n.node_type IN ('content', 'canvas', 'class_tag') AND NOT n.hidden
      ORDER BY n.title`, [ws])).rows;
  const titleById = new Map(nodes.map((n) => [n.id, n.title]));

  const tagRows = nodes.length === 0 ? [] : (await q<{ id: string; title: string; parent_id: string | null; tag_color: string | null; tag_schema: { fields?: unknown; description?: unknown } | null; reserved_key: string | null; deleted: boolean }>(
    `SELECT id::text, title, parent_id::text, tag_color, tag_schema, reserved_key, deleted_at IS NOT NULL AS deleted
       FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag'`, [ws])).rows;
  const tagById = new Map(tagRows.map((t) => [t.id, t]));
  const tagPath = (id: string): string => {
    const t = tagById.get(id);
    return t ? (t.parent_id && tagById.has(t.parent_id) ? `${tagPath(t.parent_id)}/${t.title}` : t.title) : "";
  };
  const liveTags = tagRows.filter((t) => !t.deleted && !t.reserved_key);

  const ids = nodes.filter((n) => n.node_type !== "class_tag").map((n) => n.id);
  const rawAttributeRows = (await q<{ node_id: string; key: string; value: string; value_type: string }>(
    `SELECT node_id::text, key, value, value_type FROM node_attributes WHERE node_id = ANY($1::uuid[]) AND key NOT LIKE '\\_%'`, [ids])).rows;
  // A link to a note (node_ref) holds an id, which a restore changes: it is compared by the title it names.
  const attributeRows = rawAttributeRows.map((a) => (a.value_type === "node_ref" ? { ...a, value: titleById.get(a.value) ?? a.value } : a));
  const tagLinks = (await q<{ node_id: string; tag_id: string }>(`SELECT node_id::text, tag_id::text FROM node_tags WHERE node_id = ANY($1::uuid[])`, [ids])).rows;
  const edgeRows = (await q<{ source_node_id: string; target_node_id: string }>(
    `SELECT source_node_id::text, target_node_id::text FROM node_edges WHERE workspace_id = $1 AND origin <> 'manual' AND status = 'active'`, [ws])).rows;

  const normalise = (markdown: string) => markdown
    .replace(/onden:\/\/node\/([0-9a-f-]{36})/gi, (_m, id: string) => `onden://node/<${titleById.get(id) ?? "missing"}>`)
    .replace(/\/api\/media\/([0-9a-f]{32}\.[a-z0-9]+)/g, (_m, file: string) => `media:${mediaHash(file)}`);

  const anchorIds = new Map<string, string[]>();
  for (const a of (await q<{ note_id: string; anchor_id: string }>(
    `SELECT note_id::text, anchor_id FROM block_anchors WHERE workspace_id = $1 AND status = 'valid'`, [ws])).rows) {
    anchorIds.set(a.note_id, [...(anchorIds.get(a.note_id) ?? []), a.anchor_id]);
  }

  const notes: NoteSnapshot[] = nodes.filter((n) => n.node_type === "content").map((n) => ({
    title: n.title,
    parent: n.parent_id && n.parent_type === "content" ? titleById.get(n.parent_id) ?? null : null,
    deleted: n.deleted,
    body: normalise(withoutMarks(n.markdown)),
    tags: tagLinks.filter((l) => l.node_id === n.id && tagById.get(l.tag_id) && !tagById.get(l.tag_id)!.deleted).map((l) => tagPath(l.tag_id)).sort(),
    attributes: Object.fromEntries(attributeRows.filter((a) => a.node_id === n.id).map((a) => [a.key, { value: a.value, type: a.value_type }])),
    links: [...new Set([
      ...edgeRows.filter((e) => e.source_node_id === n.id).map((e) => titleById.get(e.target_node_id) ?? "missing"),
    ])].sort(),
    blockRefs: [...new Set([...legacyBlockAnchors(n.markdown).map((anchor) => anchor.id), ...(anchorIds.get(n.id) ?? [])])].sort(),
  }));

  const positions = (await q<{ node_id: string; surface: string; x: number; y: number; width: number | null; height: number | null; color: string | null; folded: boolean }>(
    `SELECT node_id::text, surface, x, y, width, height, color, folded FROM node_positions WHERE workspace_id = $1 ORDER BY surface, x, y`, [ws])).rows;
  const canvases: CanvasSnapshot[] = nodes.filter((n) => n.board).map((c) => ({
    title: c.title, deleted: c.deleted,
    cards: positions.filter((p) => p.surface === c.id).map((p) => ({ note: titleById.get(p.node_id) ?? "missing", x: p.x, y: p.y, width: p.width, height: p.height, color: p.color, folded: p.folded })),
  }));

  const taskRows = (await q<{ id: string; title: string; host: string | null; deleted: boolean; markdown: string }>(
    `SELECT t.id::text, t.title, p.title AS host, t.deleted_at IS NOT NULL AS deleted, COALESCE(t.markdown, '') AS markdown
       FROM content_nodes t LEFT JOIN content_nodes p ON p.id = t.parent_id
      WHERE t.workspace_id = $1 AND t.node_type = 'content' AND t.hidden ORDER BY t.title, p.title`, [ws])).rows;
  const taskAttributes = taskRows.length === 0 ? [] : (await q<{ node_id: string; key: string; value: string }>(
    `SELECT node_id::text, key, value FROM node_attributes WHERE node_id = ANY($1::uuid[])`, [taskRows.map((t) => t.id)])).rows;
  const tasks: TaskSnapshot[] = taskRows.map((t) => ({
    title: t.title, host: t.host, deleted: t.deleted, body: normalise(t.markdown),
    attributes: Object.fromEntries(taskAttributes.filter((a) => a.node_id === t.id).map((a) => [a.key, a.value])),
  }));

  return {
    notes,
    tasks,
    tags: liveTags.map((t) => ({ path: tagPath(t.id), color: t.tag_color, fields: t.tag_schema?.fields ?? null, description: t.tag_schema?.description ?? null }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    canvases,
  };
}
