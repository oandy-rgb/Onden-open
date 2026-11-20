import { BLOCK_ID, isUuid, PART_LINK_EXPORT_MODES, type PartLinkExportMode } from "@onden/markdown";
import { READ_HEAD_HEADER, READ_SERVER_HEADER } from "@onden/markdown/contract";
import { readStandpoint } from "../services/sync/index.js";
import { StatusError } from "../statusError.js";
import { readJsonBody, uuidParam } from "./params.js";
import { Hono } from "hono";
import { z } from "zod";
import { getWorkspaceId } from "../services/workspaceId.js";
import { listInkVersionRows, listBodyHistoryRows, getNoteForExport, getLiveNodeRow, listNodeAttributeRows } from "../services/nodeReads.js";
import { DraftNode, noNul } from "@onden/contract";
import { newNoteExtrasSchema } from "../utils.js";
import { updateNode, restoreNodeVersion } from "../services/nodeUpdate.js";
import { readEditorBodyChange } from "../services/blockAnchors/index.js";
import { searchNodes } from "../services/nodeSearch.js";
import { applyTagToNode, removeTagFromNode } from "../services/tagMembershipWrites.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { computeRollupAttributes, computeInheritedAttributes } from "../services/nodeAttributes.js";
import { fieldForKey } from "../services/schemaValidation.js";
import { moveGraphPosition } from "../services/boardWrites.js";
import { eventActorType, type ActorCtx } from "../types.js";
import { attachmentHeaders } from "../downloadHeaders.js";
import { requireActor } from "../spine/mutate.js";
import { encodeSnapshot, type AttributeState } from "../services/eventLog/index.js";
import { incomingWins, type AttributeSource } from "../spine/attributeSource.js";
import { assertAuthority } from "../spine/authority.js";
import { spendIdempotencyKey } from "../spine/idempotency.js";
import { canReadNode } from "../services/readPolicy.js";
import { listNoteParagraphs, reassignBlockNodeAnchor } from "../services/blockAnchors/index.js";
import { mentionablesFor } from "../services/agentSessions.js";
import { duplicateNote, NoteDuplicateError } from "../services/noteDuplicate.js";
import { PUBLISHED_KEY, isWritableAttributeKey } from "../services/systemAttributes.js";
import { dropParentSiteDefaultMark, siteAttributesOf } from "../services/siteDefault.js";
import { publicSite } from "../services/publicSite.js";
import { purgeDeleted, purgePreview, trashNode, undeleteNode } from "../services/nodeTrash.js";
import { promoteNode } from "../services/nodePromote.js";
import { expandChildNote, moveBlockToChildNote, moveSelectionToChildNote, type BlockChildResult } from "../services/blockChildNote.js";
import { recordAttributeChange } from "../services/attributeChange.js";
import { createNote, isNoteIdTaken, NoteCreateError } from "../services/noteCreate.js";
import { exportedSingleNoteFile } from "../services/exportZip.js";
import { contentTabRemovable, createNoteView, deleteNoteView, executeNoteView, listNoteViews, updateNoteView } from "../services/noteViews.js";
import { viewCreateSchema, viewPatchSchema } from "../services/tagViews.js";
import { pageQueryOf, parsePage } from "../services/paging.js";
import { VIEW_PAGE } from "../services/collectionViewQuery.js";
import { inkChangeValues, listInkEdits, listNoteVersions, restoreInkVersion } from "../services/history/index.js";
import { isInkKind, type InkKind } from "@onden/markdown/ink";
import { findBlockHome } from "../services/blockRefLookup.js";
import { listBlockCitations } from "../services/blockCitations.js";
import { CLIENT_NOW_HEADER, editAgeMs } from "../services/clientClock.js";

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

// search must be registered before /:id
//
// Query syntax supports text + structural filters:
//   q="kafka #book status:reading"
// → text "kafka" via pgroonga + node carries #book + node_attributes(status) = "reading"
//
// Filters compose with AND. Empty text is OK as long as at least one filter
// is present — "show me all #task with status=blocked" is a valid query.
router.get("/search", async (c) => {
  const workspaceId = await getWorkspaceId();
  const raw = c.req.query("q")?.trim() ?? "";
  // Pure-text queries need >= 2 chars; filter-bearing queries are handled in
  // searchNodes (which rejects a query that parses to nothing).
  if (raw.length < 2) return c.json([]);
  // Read-policy iron law: every list endpoint bounds its rows by the caller's
  // COMBINED read set (role/tag-policy visibility ∩ bearer-token tag scope).
  // searchNodes now PUSHES this down as a WHERE predicate (it requires the
  // actor), so the LIMIT lands on already-authorized rows — no post-fetch
  // .filter() that under-fills a low-rank caller's page. Equivalence guarded by
  // readableScope.integration.test; the leak this closed (a viewer reading
  // restricted titles/snippets) is pinned by compositionLaws.integration.test.
  // ?tasks=1 also finds tasks (marked `is_task`); the readable-scope push-down is the same.
  const results = await searchNodes(workspaceId, raw, c.get("actor"), undefined, { tasks: c.req.query("tasks") === "1" });
  return c.json(results);
});

// A note can be created WITH its first tags and attributes (a sketch with its
// kind attribute, a collection row with its tag, a template with defaults).
// They are applied in the node's own event transaction under the same rules as
// the separate tag/attribute endpoints, so the note never exists half-made and
// one Idempotency-Key covers the whole creation. Tags go first: an attribute is
// validated against the schema fields those tags bring.
router.post("/", async (c) => {
  const workspaceId = await getWorkspaceId();
  const body = await readJsonBody(c);
  const input = DraftNode.parse(body);
  const extras = newNoteExtrasSchema.parse(body);
  // Only a tag can be hidden (D104); a note is never born hidden.
  if (input.hidden) throw new StatusError(400, "only_tags_can_be_hidden");
  try {
    // services/noteCreate.ts: placement, space, slug, NODE_CREATED and the
    // derived state, with the first tags and attributes in the same
    // transaction under one Idempotency-Key.
    const { node } = await createNote({
      actor: requireActor(c.get("actor")), workspaceId,
      id: input.id, title: input.title, markdown: input.markdown,
      sourceType: input.source_type, parentId: input.parent_id, spaceId: extras.space_id,
      hidden: input.hidden, orderKey: input.order_key, legacySortOrder: input.sort_order,
      event: { uiContext: "node.create" },
      tagIds: extras.tag_ids, attributes: extras.attributes,
    });
    // `attrs`: the note's place on the site as stored, so a device whose view of the parent was stale corrects its drawing.
    return c.json({ ...node, attrs: await siteAttributesOf(String(node.id)) }, 201);
  } catch (error) {
    if (error instanceof NoteCreateError) return c.json({ error: error.message }, error.status);
    // The client-minted id is already a note: a known conflict the client
    // resolves by opening that note (only here — elsewhere a primary-key
    // failure stays an internal error, tagNameConflict.integration.test).
    if (isNoteIdTaken(error)) return c.json({ error: "note_exists" }, 409);
    throw error;
  }
});

// A copy is one domain write, not a client-side create followed by separate
// attribute/tag calls. The stable UUID and request Idempotency-Key survive a
// lost response or offline replay; authorization and all copied state share
// the same event transaction.
router.post("/:id/duplicate", async (c) => {
  const input = z.object({ id: z.string().uuid().optional() }).strict().parse(await readJsonBody(c, { optional: true }));
  try {
    const result = await duplicateNote({
      workspaceId: await getWorkspaceId(), actor: requireActor(c.get("actor")),
      sourceId: uuidParam(c, "id"), newNodeId: input.id,
    });
    return c.json(result.node, 201);
  } catch (error) {
    if (error instanceof NoteDuplicateError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

// G5: cursor_state shape sent alongside a NODE_UPDATED body patch. The
// editor includes selection offsets so the restore-side can re-apply the
// caret position after a revert. Reference: Logseq record-editor-info!
// in worker/undo_redo.cljs:291 — saves {:block-uuid :start-pos :end-pos}
// per undo op. Onden's payload is the CodeMirror EditorSelection main
// range shape: {anchor, head}.
const cursorStateSchema = z.object({
  anchor: z.number().int().nonnegative(),
  head: z.number().int().nonnegative(),
}).optional();

router.patch("/:id", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = c.req.param("id");
  const rawBody = (await readJsonBody(c)) as Record<string, any> | null;
  // cursor_state is not a column on content_nodes; split it out before
  // parsing the rest into the node-schema partial.
  const cursorState = cursorStateSchema.parse(rawBody?.cursor_state);
  const parsed = DraftNode.partial().parse({
    ...rawBody,
    // Strip cursor_state so the partial parser doesn't reject it.
    cursor_state: undefined,
    body_change: undefined,
  });
  // zod's .partial() does NOT disable .default() fields — a title-only PATCH
  // parses as {title, markdown:'', hidden:false, sort_order:0}, which then
  // WIPED the body and reset the flags for any client that doesn't resend the
  // whole node (the web app does; agents/MCP don't). A PATCH means "change
  // exactly the keys I sent": scope the parsed input to the request's own keys.
  const input = Object.fromEntries(
    Object.entries(parsed).filter(([k]) =>
      Object.prototype.hasOwnProperty.call(rawBody ?? {}, k)),
  ) as typeof parsed;
  const { node, noop } = await updateNode(workspaceId, id, input, {
    actor: requireActor(c.get("actor")),
    cursorState,
    baseMarkdown: typeof rawBody?.base_markdown === "string" ? rawBody.base_markdown : undefined,
    markdownPatch: rawBody?.markdown_patch,
    bodyChange: readEditorBodyChange(rawBody?.body_change),
  });
  // noop: every field sent was already stored, nothing was written (no history point).
  return c.json(noop ? { ...node, noop: true } : node);
});

// ER5.5 soft delete and its counterpart. Trashing takes the live subtree, and
// undelete brings back what was trashed with it (services/nodeTrash.ts). Once
// the prune job (ER5.6) hard-removes the row, undelete answers 410 (Gone),
// which the restore UI shows as "expired".
router.delete("/:id", async (c) => {
  await trashNode(requireActor(c.get("actor")), await getWorkspaceId(), c.req.param("id"));
  return c.json({ deleted: true });
});

router.post("/:id/undelete", async (c) => {
  await undeleteNode(requireActor(c.get("actor")), await getWorkspaceId(), c.req.param("id"));
  return c.json({ undeleted: true });
});

// History's 「永久刪除」 of one deleted note (services/nodeTrash.ts
// purgeDeleted). GET …/purge-preview says what goes; POST …/purge
// {expected_ids} does it, refusing (409 plan_changed) if what would go is no
// longer what the preview listed. Managers of the note's space only. A second
// purge of the same note answers 404.
router.get("/:id/purge-preview", async (c) => {
  const id = z.string().uuid().parse(c.req.param("id"));
  return c.json(await purgePreview(requireActor(c.get("actor")), await getWorkspaceId(), id));
});

router.post("/:id/purge", async (c) => {
  // expected_ids is required: a purge without the confirmed plan could take
  // notes deleted since the preview (the app always sends it).
  const input = z.object({ expected_ids: z.array(z.string().uuid()).min(1).max(100_000) })
    .parse(await readJsonBody(c, { optional: true }));
  const id = z.string().uuid().parse(c.req.param("id"));
  const result = await purgeDeleted(requireActor(c.get("actor")), await getWorkspaceId(), id, { expected: input.expected_ids });
  return c.json(result);
});

// A block of a note into a child note, and back (services/blockChildNote.ts):
// each is one write — the note's edit is the event, the child note, the
// references in other notes and the trash ride in it, so one restore of that
// event (cascade) undoes the lot. 409 `references_unwritable` lists the notes
// whose references the caller may not rewrite; `unwritable: "leave"` goes on
// without them.
const childOperationBody = (result: BlockChildResult) => ({
  note: result.note, child_id: result.childId, event_id: result.eventId, rewritten: result.rewritten, left: result.left,
});

// A block by its `^id`, or a selected text (offsets into the note as saved, and
// the text the person saw there): exactly one of the two.
router.post("/:id/block-to-child", async (c) => {
  const input = z.object({
    block_ref: z.string().regex(BLOCK_ID).optional(),
    selection: z.object({
      from: z.number().int().min(0), to: z.number().int().min(0), text: z.string().min(1).max(40_000),
    }).strict().refine((s) => s.from < s.to, "an empty range").optional(),
    fallback_title: z.string().max(200).optional(),
    unwritable: z.enum(["refuse", "leave"]).optional(),
    // 「獨立出去」: the block keeps its identity (task, schedule, links) instead of being copied.
    keep_identity: z.boolean().optional(),
  }).strict().refine((body) => (body.block_ref === undefined) !== (body.selection === undefined), "block_ref or selection")
    .parse(await readJsonBody(c, { optional: true }));
  const common = {
    workspaceId: await getWorkspaceId(), actor: requireActor(c.get("actor")), noteId: z.string().uuid().parse(c.req.param("id")),
    fallbackTitle: input.fallback_title, unwritable: input.unwritable, keepIdentity: input.keep_identity,
  };
  const result = input.selection
    ? await moveSelectionToChildNote({ ...common, selection: input.selection })
    : await moveBlockToChildNote({ ...common, blockRef: input.block_ref! });
  return c.json(childOperationBody(result));
});

router.post("/:id/expand-child", async (c) => {
  const input = z.object({ child_id: z.string().uuid() }).strict().parse(await readJsonBody(c, { optional: true }));
  const result = await expandChildNote({
    workspaceId: await getWorkspaceId(), actor: requireActor(c.get("actor")),
    noteId: z.string().uuid().parse(c.req.param("id")), childId: input.child_id,
  });
  return c.json(childOperationBody(result));
});

router.post("/:id/promote", async (c) => {
  const workspaceId = await getWorkspaceId();
  const node = await promoteNode(c.get("actor"), workspaceId, c.req.param("id"));
  return node ? c.json(node) : c.json({ error: "node not found" }, 404);
});

// Version history is DERIVED from the event log: a "version" is a
// NODE_CREATED/NODE_UPDATED/NODE_RESTORED event carrying payload.body_hash, with
// its body read from the content-addressed blob store. versionId is the
// domain_events id. A restore is itself a body-changing event, so it carries
// body_hash too and shows up as a version.
// (The CoW content_node_versions table + trigger were retired in migration 053.)
// Session-coalesced version history (user feedback 2026-06-12 「還原的體驗
// 完全是錯的」). Storage stays per-save (every body is an event + blob —
// nothing is ever lost, 053's design); the LIST collapses consecutive saves
// by the SAME actor within a 5-minute gap into one "session" row carrying
// the session's FINAL body — restore points that match how a human
// remembers working ("the state when I stopped at 12:34"), not 1.5-second
// autosave noise. `saves` carries how many raw saves the row absorbed;
// ?raw=1 returns the ungrouped feed (the event log of bodies).
router.get("/:id/versions", async (c) => {
  const workspaceId = await getWorkspaceId();
  // services/history/noteVersions.ts: the read gate (unreadable = missing, no
  // existence probe), the session grouping, and summary/markers/restored_from.
  const versions = await listNoteVersions(workspaceId, requireActor(c.get("actor")), c.req.param("id"), { raw: c.req.query("raw") === "1" });
  return versions ? c.json(versions) : c.json({ error: "node not found" }, 404);
});

// Ink version history — the sibling of /:id/versions for drawings. `?kind=` picks the drawing: "handwriting"
// (default, the note's page) or "board" (its whiteboard's pen layer, services/history/bodyEvents.ts inkEventSql).
// Ink is stored as the `ink_data` / `board_ink` attribute (content-addressed: each save's full
// InkDocument lives in blobs, the event carries value_ref). The markdown
// versions query filters on `body_hash`, so it never surfaces ink saves; this
// endpoint walks the ATTRIBUTE_SET log of that drawing instead, resolving
// each save's blob so the client can diff two versions (lib/ink/diff.ts).
// Older pre-content-addressing saves stored the value inline — COALESCE covers
// both. Same read-policy gate as the markdown history.
router.get("/:id/ink-versions", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = c.req.param("id");
  const rows = await listInkVersionRows(requireActor(c.get("actor")), workspaceId, id, inkKindQuery(c.req.query("kind")));
  if (!rows) throw new StatusError(404, "node not found"); // unreadable = missing (no existence probe)
  // Drop any row whose blob went missing (GC'd) so the client never diffs null.
  return c.json(rows.filter((r: { ink_data: unknown }) => typeof r.ink_data === "string" && r.ink_data.length > 0));
});

// What each edit of one drawing drew and erased (services/history/inkChanges.ts): the counts only, newest first,
// for the "handwriting" or "whiteboard" list of one note's history (?kind=). The drawings behind a row are /ink-change.
router.get("/:id/ink-edits", async (c) => {
  const edits = await listInkEdits(await getWorkspaceId(), requireActor(c.get("actor")), c.req.param("id"), inkKindQuery(c.req.query("kind")));
  return edits ? c.json(edits) : c.json({ error: "node not found" }, 404);
});

// The two drawings behind one row of /ink-edits (or a feed row's `ink`), read when the row is opened:
// ?before=<event id, omitted = nothing drawn yet>&after=<event id>. 404 for an unreadable note, an id that is
// not a save of this note's drawing, or a drawing no longer stored.
router.get("/:id/ink-change", async (c) => {
  const after = c.req.query("after");
  const change = after === undefined ? null : await inkChangeValues(
    await getWorkspaceId(), requireActor(c.get("actor")), c.req.param("id"), inkKindQuery(c.req.query("kind")), c.req.query("before") ?? null, after,
  );
  return change ? c.json(change) : c.json({ error: "node not found" }, 404);
});

// Restoring a saved version is an edit (services/nodeUpdate.ts
// restoreNodeVersion): current write policy, slug, tag-name check, inverse
// history and derived state. A NodeUpdateError (missing note or version, 404)
// maps at the shared HTTP boundary.
// The body is optional: `{ restore_title: false }` brings back the text only
// (the note keeps its title and slug). No body or flag = the title comes back too,
// as it did before the title was a separate choice (old clients).
router.post("/:id/versions/:versionId/restore", async (c) => {
  const { id, versionId } = c.req.param();
  const input = z.object({ restore_title: z.boolean().optional() }).strict()
    .parse(await readJsonBody(c, { optional: true }) ?? {});
  const { node, noop } = await restoreNodeVersion(await getWorkspaceId(), id, versionId, {
    actor: requireActor(c.get("actor")),
    restoreTitle: input.restore_title,
  });
  return c.json(noop ? { ...node, noop: true } : node);
});

// POST /api/nodes/:id/tasks (a task added under a note) is mounted by the tasks
// module (src/modules/tasks).

router.get("/:id/history", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = c.req.param("id");
  // Derived from the event log (see /:id/versions). Lightweight: no body.
  const rows = await listBodyHistoryRows(requireActor(c.get("actor")), workspaceId, id);
  if (!rows) throw new StatusError(404, "node not found"); // unreadable = missing (no existence probe)
  return c.json(rows);
});

// ⑩ GET /:id/export.html — one note as a self-contained, themed HTML file
// (the site's theme + owner custom CSS, no nav chrome). Read policy: the same
// canReadNode gate as every per-node endpoint, so a scoped token can only
// export what it may read. The export matches the live site's appearance,
// including custom_css, and its [[links]] open the served site's pages
// (the website's singleNoteExport, through services/publicSite.ts).
router.get("/:id/export.html", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = c.req.param("id");
  const actor = requireActor(c.get("actor"));
  const note = await getNoteForExport(actor, workspaceId, id);
  if (!note) throw new StatusError(404, "not found");
  const html = await publicSite().singleNoteExport(workspaceId, { id, ...note }, actor);
  for (const [name, value] of Object.entries(attachmentHeaders(`${note.title.trim() || "note"}.html`, "text/html; charset=utf-8"))) c.header(name, value);
  return c.body(html);
});

// Read-only rendering of the caller's current text. Exporting must not flush a
// draft or falsely claim that a queued/rejected draft is the saved version.
// Reuse the published renderer and the same read policy as the GET export.
// `format: "markdown"` answers the note's file as the Markdown zip writes it
// (D52: frontmatter with title, tags and current attributes) instead of HTML.
router.post("/:id/export-preview", async (c) => {
  const actor = requireActor(c.get("actor"));
  const id = z.string().uuid().parse(c.req.param("id"));
  if (!(await canReadNode(actor, id))) throw new StatusError(404, "node not found"); // unreadable = missing (no existence probe)
  const { format, part_links: partLinks, ...snapshot } = z.object({
    title: z.string(), markdown: z.string(), format: z.enum(["html", "markdown"]).default("html"),
    // How the Markdown file writes part links (@onden/markdown PART_LINK_EXPORT_MODES); absent = the default.
    part_links: z.enum(PART_LINK_EXPORT_MODES as unknown as [PartLinkExportMode, ...PartLinkExportMode[]]).optional(),
  }).strict().parse(await readJsonBody(c));
  const workspaceId = await getWorkspaceId();
  c.header("Cache-Control", "no-store");
  if (format === "markdown") {
    const markdown = await exportedSingleNoteFile(actor, workspaceId, id, snapshot, partLinks);
    return markdown === null ? c.json({ error: "node not found" }, 404) : c.json({ markdown });
  }
  const html = await publicSite().singleNoteExport(workspaceId, { id, ...snapshot }, actor);
  return c.json({ html });
});

// ── Attributes (Trilium-style free-form + class-tag-derived) ────────────────
// Caller dispatches set/delete operations on attributes here. The dispatcher
// pattern: caller → endpoint → service → boundary (node_attributes row) +
// audit (domain_events). Plugins/agents will use the same path.

// The agents this person could @mention in the note, each with whether sending
// would work now and why not (services/agentSessions.ts mentionablesFor).
router.get("/:id/mentionables", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) throw new StatusError(404, "not found");
  const { agents, defaultActorId } = await mentionablesFor(await getWorkspaceId(), id, { actor: requireActor(c.get("actor")) });
  return c.json({ agents, default_actor_id: defaultActorId });
});

// Single-node fetch — the lazy-body door for the slim bootstrap
// (?bodies=none). Returns the SAME enriched row shape bootstrap emits
// (nodeRowProjection) so the frontend can swap it into the store
// verbatim. Read policy: same canReadNode gate as every per-node endpoint.
router.get("/:id", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = c.req.param("id");
  if (!isUuid(id)) {
    throw new StatusError(404, "not found");
  }
  // Where this read stands in the event order, read BEFORE the row (services/sync/delta.ts workspaceHead): the app does not let a read
  // taken before one of its acknowledged writes replace what that write saved.
  const standpoint = await readStandpoint(workspaceId);
  // Absent, trashed and unreadable answer alike: a 403 for a live node the
  // actor may not read would confirm that the id exists.
  const row = await getLiveNodeRow(requireActor(c.get("actor")), workspaceId, id);
  if (!row) throw new StatusError(404, "not found");
  c.header(READ_HEAD_HEADER, standpoint.head);
  if (standpoint.server_id) c.header(READ_SERVER_HEADER, standpoint.server_id);
  return c.json(row);
});

// Where `[[:id#^ref]]` points when note :id no longer holds block ^ref: the one
// other note the caller may read that does (services/blockRefLookup.ts).
// `home: null` = none, several, or :id unreadable — all answer alike.
router.get("/:id/block-home/:ref", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ home: null });
  const home = await findBlockHome(requireActor(c.get("actor")), await getWorkspaceId(), id, c.req.param("ref"));
  return c.json({ home });
});

// The notes (the caller can read) that cite paragraphs of note :id with
// `[[:id#^ref]]` / `![[:id#^ref]]` (services/blockCitations.ts). An unreadable
// or missing note answers `[]`, as one nothing cites does.
router.get("/:id/block-citations", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ citations: [] });
  return c.json({ citations: await listBlockCitations(requireActor(c.get("actor")), await getWorkspaceId(), id) });
});

// Saved views of a note's children (services/noteViews.ts; the twin of
// /api/tags/:tagId/views). Reading needs the note readable; changing a view
// is editing the note. A note that is missing, a tag or unreadable is a 404.
const viewIds = (c: { req: { param: (name: string) => string | undefined } }) => {
  const id = c.req.param("id") ?? "";
  return isUuid(id) ? { id, viewId: c.req.param("viewId") ?? "" } : null;
};

router.get("/:id/views", async (c) => {
  const ids = viewIds(c);
  const workspaceId = await getWorkspaceId();
  const views = ids && await listNoteViews(requireActor(c.get("actor")), workspaceId, ids.id);
  if (!views) throw new StatusError(404, "not found");
  return c.json({ views, content_tab_removable: await contentTabRemovable(workspaceId, ids.id) });
});

router.post("/:id/views", async (c) => {
  const ids = viewIds(c);
  if (!ids) throw new StatusError(404, "not found");
  const v = viewCreateSchema.parse(await readJsonBody(c));
  const row = await createNoteView(requireActor(c.get("actor")), await getWorkspaceId(), ids.id, v);
  if (!row) throw new StatusError(404, "not found");
  return c.json({ id: row.id }, 201);
});

router.patch("/:id/views/:viewId", async (c) => {
  const ids = viewIds(c);
  if (!ids) throw new StatusError(404, "not_found");
  const updates = viewPatchSchema.parse(await readJsonBody(c));
  const updated = await updateNoteView(requireActor(c.get("actor")), await getWorkspaceId(), ids.id, ids.viewId, updates);
  if (!updated) throw new StatusError(404, "not_found");
  return c.json({ updated: true });
});

router.get("/:id/views/:viewId/exec", async (c) => {
  const ids = viewIds(c);
  if (!ids) throw new StatusError(404, "not_found");
  const page = parsePage(pageQueryOf(c), VIEW_PAGE);
  const result = await executeNoteView(requireActor(c.get("actor")), await getWorkspaceId(), ids.id, ids.viewId, page);
  if (!result) throw new StatusError(404, "not_found");
  return c.json(result);
});

router.delete("/:id/views/:viewId", async (c) => {
  const ids = viewIds(c);
  if (!ids) throw new StatusError(404, "not_found");
  const deleted = await deleteNoteView(requireActor(c.get("actor")), await getWorkspaceId(), ids.id, ids.viewId);
  if (!deleted) throw new StatusError(404, "not_found");
  return c.json({ deleted: true });
});

// ?keys=a,b answers only those keys (a key never holds a comma): a reader
// after one or two values (an ink surface's ink_data / pdf_url) need not
// download the note's every attribute. Without it, every attribute.
router.get("/:id/attributes", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = c.req.param("id");
  const keysParam = c.req.query("keys");
  const keys = keysParam === undefined ? null : keysParam.split(",").filter((key) => key !== "");
  const attributes = await listNodeAttributeRows(requireActor(c.get("actor")), workspaceId, id, keys);
  if (!attributes) throw new StatusError(404, "node not found"); // unreadable = missing (no existence probe)
  return c.json(attributes);
});

router.get("/:id/rollup-attributes", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = c.req.param("id");
  const actor = requireActor(c.get("actor"));
  if (!(await canReadNode(actor, id))) throw new StatusError(404, "node not found"); // unreadable = missing (no existence probe)
  return c.json(await computeRollupAttributes(actor, workspaceId, id));
});

router.get("/:id/inherited-attributes", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = c.req.param("id");
  if (!(await canReadNode(requireActor(c.get("actor")), id))) throw new StatusError(404, "node not found"); // unreadable = missing (no existence probe)
  return c.json(await computeInheritedAttributes(workspaceId, id));
});

router.put("/:id/attributes/:key", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = c.req.param("id");
  const key = c.req.param("key");
  if (key.includes("\u0000")) throw new StatusError(400, "contains_nul");
  const input = z.object({
    value: z.union([noNul(z.string()), z.number(), z.boolean(), z.null()]).optional(),
    // A hint only: a key that is a schema field is stored under the field's
    // type (services/attributeChange.ts); a free-form key keeps the hint, else
    // its stored type (when the value still fits it), else the type its value shows.
    value_type: z.enum(["text", "number", "date", "bool", "node_ref"]).optional(),
    // Left out = keep the row's own flag (a value edit must not turn "shares to children" off).
    is_inheritable: z.boolean().optional(),
    // Local-first conflict detection: the time (the client's own clock) the edit
    // was made. It is never compared with a server time: the server turns it
    // into an age against the client's clock reading in the X-Onden-Client-Now
    // header (clientClock.ts) and dates the edit on its own logical clock. If
    // the stored value is newer than that, another writer landed between the
    // client's read and write.
    client_updated_at: z.string().datetime().optional(),
    // A drawing's writer sends the drawing it started from ("" = none): the
    // server merges the write into a value another device stored since
    // (services/attributeWrites.ts MERGED_KEYS).
    base_value: z.string().optional(),
    // The same, as a patch against the base (the base_value it replaces):
    // value and base_value are then left out.
    value_patch: z.object({
      base_hash: z.string().regex(/^[0-9a-f]{64}$/),
      hunks: z.array(z.object({ at: z.number().int().min(0), del: z.number().int().min(0), ins: z.string() })).max(100_000),
    }).optional(),
  }).refine((v) => (v.value_patch === undefined) !== (v.value === undefined), { message: "value_or_value_patch" })
    .refine((v) => v.value_patch === undefined || v.base_value === undefined, { message: "value_patch_with_base_value" })
    .parse(await readJsonBody(c));
  // Reserved keys, schema validation, the overwritten-state snapshot, conflict
  // record, event and behaviour dispatch: services/attributeWrites.ts.
  const actor = requireActor(c.get("actor"));
  const { value_patch: valuePatch, value, ...attribute } = input;
  const client_edit_age_ms = attribute.client_updated_at === undefined ? undefined : editAgeMs(c.req.header(CLIENT_NOW_HEADER), Date.parse(attribute.client_updated_at));
  const result = await setNodeAttribute({ workspaceId, actor, nodeId: id, attribute: { key, value: value ?? "", ...attribute, client_edit_age_ms }, valuePatch });
  const { conflict, ...saved } = result;
  return c.json({ ...saved, ...(conflict ? { conflict } : {}) });
});

router.delete("/:id/attributes/:key", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = c.req.param("id");
  const key = c.req.param("key");
  if (!isWritableAttributeKey(key)) throw new StatusError(400, "reserved key");
  const actor = requireActor(c.get("actor"));
  // Who may remove is decided before anything about the attribute is answered (its tag's required field, whether it exists):
  // a person who may not write here gets the same refusal whether or not the property is there. The same check runs again
  // under the event lock (services/attributeChange.ts) for the case where nothing is there to remove.
  await assertAuthority(actor, { kind: "node", nodeId: id, op: "read" });
  await assertAuthority(actor, { kind: "node", nodeId: id, op: "delete_attribute" });
  // P2: a REQUIRED schema field can't be deleted while its tag is applied —
  // clear the tag (or change the schema) first.
  const fieldDef = await fieldForKey(workspaceId, id, key);
  if (fieldDef?.required) {
    return c.json({ error: "field_required", detail: `"${key}" is required by an applied tag` }, 422);
  }
  // An explicit removal: whatever rail wrote the value (services/attributeChange.ts).
  const removal = await recordAttributeChange({
    workspaceId, nodeId: id, key, actor, next: null, rule: "always",
    authority: { kind: "node", nodeId: id, op: "delete_attribute" },
    uiContext: "node.attribute.delete",
    within: async ({ eventId }) => {
      if (key === PUBLISHED_KEY) await dropParentSiteDefaultMark(workspaceId, id, actor);
    },
  });
  // Nothing was there to remove, so nothing was written and no key was claimed: spend the key anyway. Otherwise a retry
  // after a lost reply would run again and remove a value another device set in between (found by the sync simulator).
  if (!removal.written) await spendIdempotencyKey(workspaceId);
  return c.json({ ok: true });
});

// Set a node's position on the global force-graph (surface 'graph'). Board
// placements are written with PATCH /api/boards/:id, which checks the board
// (W23); this route used to accept any surface and so bypassed that.
// A position on the global graph is shared data: a written event, one per burst
// of moves (services/boardWrites.ts moveGraphPosition).
const positionSchema = z.object({
  surface: z.literal("graph"),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  color: z.string().optional(),
  folded: z.boolean().optional(),
  subCanvasId: z.string().uuid().optional(),
});

router.put("/:id/position", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = c.req.param("id");
  const actor = requireActor(c.get("actor"));
  // Moving/recoloring/folding a card is a write on the node — gate it through
  // node authority (tag policy + bearer-token scope), same as suggested-links
  // above. requireActor alone let a viewer mutate any card's layout.
  await assertAuthority(actor, { kind: "node", nodeId: id, op: "write_node" });
  const p = positionSchema.parse(await readJsonBody(c));
  await moveGraphPosition(actor, workspaceId, id, p);
  return c.json({ ok: true });
});

// ── Tag apply / remove ──────────

router.put("/:id/tags/:tagId", async (c) => {
  const changed = await applyTagToNode({
    workspaceId: await getWorkspaceId(), actor: requireActor(c.get("actor")),
    nodeId: c.req.param("id"), tagId: c.req.param("tagId"),
  });
  return c.json(changed ? { ok: true } : { ok: true, noop: true });
});

router.delete("/:id/tags/:tagId", async (c) => {
  const changed = await removeTagFromNode({
    workspaceId: await getWorkspaceId(), actor: requireActor(c.get("actor")),
    nodeId: c.req.param("id"), tagId: c.req.param("tagId"),
  });
  return c.json(changed ? { ok: true } : { ok: true, noop: true });
});

// ── 本篇的段落 (paragraph anchors) ──────────────────────────────────────────

const reassignBody = z.object({ at: z.number().int().min(0), body_hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

// 「本篇的段落」: the note's paragraphs that are block nodes (services/blockAnchors/paragraphs.ts). Unreadable = missing.
router.get("/:id/paragraphs", async (c) => {
  const actor = requireActor(c.get("actor"));
  const id = c.req.param("id");
  if (!isUuid(id) || !(await canReadNode(actor, id))) throw new StatusError(404, "node not found");
  return c.json({ paragraphs: await listNoteParagraphs(actor, await getWorkspaceId(), id) });
});

// 「重新指定」 a paragraph whose anchor was lost to the block at `at` (offset in the note as saved, whose
// body hash the person saw). Needs write access to the note; a changed note is 409, never guessed.
router.post("/:id/paragraphs/:blockId/reassign", async (c) => {
  const input = reassignBody.parse(await readJsonBody(c, { optional: true }));
  await reassignBlockNodeAnchor({
    actor: requireActor(c.get("actor")), workspaceId: await getWorkspaceId(), noteId: z.string().uuid().parse(c.req.param("id")),
    blockNodeId: z.string().uuid().parse(c.req.param("blockId")), at: input.at, bodyHash: input.body_hash,
  });
  return c.json({ ok: true });
});

/** `?kind=` of the ink history routes: "handwriting" when left out, a 400 for anything else. */
function inkKindQuery(raw: string | undefined): InkKind {
  if (raw === undefined) return "handwriting";
  if (!isInkKind(raw)) throw new StatusError(400, "invalid_ink_kind");
  return raw;
}

// Put one drawing back as it was after a save of /ink-edits (`id` is the row's after_event): a new write of that
// drawing's own attribute only, under the caller's current write authority. 404 as /ink-change.
router.post("/:id/ink-versions/:eventId/restore", async (c) => {
  const kind = inkKindQuery(c.req.query("kind"));
  const restored = await restoreInkVersion(await getWorkspaceId(), requireActor(c.get("actor")), c.req.param("id"), kind, c.req.param("eventId"));
  if (!restored) throw new StatusError(404, "node not found");
  const { conflict: _conflict, ...saved } = restored;
  return c.json(saved);
});

export default router;
