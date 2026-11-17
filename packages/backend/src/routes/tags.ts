import { Hono, type Context } from "hono";
import { uniqueTagSlug } from "../services/nodes.js";
import { z } from "zod";
import { getWorkspaceId } from "../services/workspaceId.js";
import { normalizeFieldIdentifiers, exportTagPack, installTagPack, TagPackRefusal, type TagPack } from "../services/tagPacks.js";
import { listTagTree, descendantsOf, fullTagPath, resolveOrCreateTagPath, assertTagNameAvailable, createTag } from "../services/tagHierarchy.js";
import { pageQueryOf, parsePage } from "../services/paging.js";
import { VIEW_PAGE } from "../services/collectionViewQuery.js";
import { createTagView, deleteTagView, executeTagView, listTagViews, updateTagView, viewCreateSchema, viewPatchSchema } from "../services/tagViews.js";
import { mergeTags, previewTagMerge } from "../services/tagMerge.js";
import { patchTagSchema } from "../services/tagWrites.js";
import { updateTagIdentity } from "../services/tagIdentity.js";
import type { ActorCtx } from "../types.js";
import { mutate, requireActor } from "../spine/mutate.js";
import { canSeeTag } from "../services/readPolicy.js";
import { addFunction, FunctionRefError, functionsOf, ownFunctionRefId, removeFunction, setFunctionConfig } from "../services/functionRefs.js";
import { patchTagModules, putTagExtends } from "../services/legacyTagFunctionWrites.js";
import { assertAuthority } from "../spine/authority.js";
import { readTagDetail, tagDeletePreview } from "../services/tagReads.js";
import { readTagCatalog } from "../services/tagCatalog.js";
import { withActorReadSnapshot } from "../services/actorReadSnapshot.js";
import { TAG_NAME_MAX, isHexColor } from "@onden/markdown";
import { parseBody, readJsonBody, uuidParam } from "./params.js";
import { StatusError } from "../statusError.js";
import { tagBlocks } from "../services/blockNodes.js";

const TAG_BLOCKS_PAGE = { default: 100, max: 200 };

// Tag management — list / detail / update.
//
// Reads return everything the tag editor UI needs in one roundtrip:
// - tag identity (id, name, color, schema_id)
// - linked collection_schemas (fields, views, behaviour, policy)
// The substrate stores Schema/Behaviour/Policy on collection_schemas; the tag
// itself only carries identity + schema_id FK. Updates that touch fields /
// behaviour / policy go through collection_schemas; updates to name/color
// go through the tags table.

type Env = { Variables: { actor: ActorCtx | null } };

const router = new Hono<Env>();

// Changing a tag's definition (identity, schema, an imported pack) is the
// workspace principal's: the owner via session/native app, never a delegated
// bearer token. Routes assert it first with the same rule the in-mutate
// authority re-checks under the lock; a refusal throws AuthorityError, which
// httpError.ts answers with 401/403.

// Every tag LIST surface (GET / and GET /tree) applies the same combined read
// set: role/tag-policy visibility ∩ bearer-token tag allowlist. One helper so
// the two can't drift; per-id endpoints apply the same pair via canSeeTag
// (list-vs-detail parity is pinned by tagReadGate.integration.test.ts).
// Under spaces a tag definition is global, so the list itself is unfiltered.

// L1: hierarchy endpoints. Must be declared BEFORE the /:id routes so
// "tree" / "resolve-path" don't match the id parameter.
//
// GET /api/tags/tree                    — flat list with parent_id
// GET /api/tags/:tagId/path             — "projects/onboarding"
// GET /api/tags/:tagId/descendants      — descendant ids via CTE
// POST /api/tags/resolve-path           — idempotent chain create
// POST /api/tags                        — create one plain tag (client id kept)
router.get("/tree", async (c) => {
  const workspaceId = await getWorkspaceId();
  const tree = await listTagTree(c.get("actor"), workspaceId);
  return c.json({ tags: tree });
});

const resolvePathSchema = z.object({ path: z.string().min(1).max(200) });
router.post("/resolve-path", async (c) => {
  const workspaceId = await getWorkspaceId();
  const actor = requireActor(c.get("actor"));
  const input = await parseBody(c, resolvePathSchema);
  const { leafId, created } = await resolveOrCreateTagPath(
    workspaceId, input.path, actor,
  );
  return c.json({ leaf_id: leafId, created_ids: created });
});

// The +Tag row's and the sidebar's "Create #name" (frontend tagWriter.create).
// The same createTag as a `#name` typed in a note — editors may, no schema,
// TAG_CREATED — but create-only: an existing sibling of that name is a 409
// (not adopted), and the client-minted id is kept so the optimistic / queued
// tag reconciles by id. A replay (with the same key or a new one) answers the
// same tag; an id held by anything else is 409 id_conflict. One tag per call:
// a "/" would mean a path (`#a/b` makes two levels via /resolve-path), so it
// is a 400 here rather than one tag literally named "a/b". Packs and
// templates stay on the owner-only POST /import.
// The length rule for a tag's name, on create and on rename (the shape rules of a rename are tagIdentity's assertTagNameShape).
const tagNameLength = z.string().min(1).max(TAG_NAME_MAX);
const tagNameField = tagNameLength.trim().min(1)
  .refine((name) => !name.includes("/"), "a tag name cannot contain \"/\"; create a nested tag with POST /api/tags/resolve-path");
const createTagSchema = z.object({
  id: z.string().uuid().optional(),
  // Under another tag; createTag refuses a note or a function as the parent.
  parent_id: z.string().uuid().nullish(),
  name: tagNameField,
});
router.post("/", async (c) => {
  const workspaceId = await getWorkspaceId();
  const actor = requireActor(c.get("actor"));
  const input = await parseBody(c, createTagSchema);
  return c.json(await createTag({ actor, workspaceId, name: input.name, id: input.id, parentId: input.parent_id }), 201);
});

// /:tagId/path and /:tagId/descendants live below the existing /:id
// handlers because they share the same leading param — that's fine
// because their second segment ("path" / "descendants") makes the
// route distinct from "/:id" which has no second segment.

// A1.4: read tags off the note table (node_type='class_tag'). Writes still
// go through the `tags` table — sync trigger (migration 038) keeps the
// shadow rows in step. Output JSON shape preserved for frontend
// compatibility: title→name, tag_color→color, tag_schema_id→schema_id.
// A1.7: additionally expose ContentNode-native fields (markdown,
// created_at, updated_at) so the frontend can render tag pages with
// the same affordances as any node.
router.get("/", async (c) => {
  const workspaceId = await getWorkspaceId();
  return withActorReadSnapshot(c.get("actor"), workspaceId, async actor =>
    c.json(await readTagCatalog(actor, workspaceId)));
});

// ── TagPack export ───────────────────────────────────────────────────────────
//
// Returns a portable JSON representation of a tag — Schema (fields),
// Behaviour, plus library metadata (version, description, dependencies). This
// is the format consumed by the import endpoint. Anyone who can see the tag
// can export it.
router.get("/:id/export", async (c) => {
  const pack = await exportTagPack(requireActor(c.get("actor")), await getWorkspaceId(), c.req.param("id"));
  return pack ? c.json(pack) : c.json({ error: "tag not found" }, 404);
});

/** GET of one tag's read model by id (`:param`). The read itself gates by id: a tag GET / hides stays hidden when
 *  addressed by id, so a missing and a hidden tag are the same 404 (no existence oracle). */
const tagRead = (param: string, read: (actor: ActorCtx, workspaceId: string, tagId: string) => Promise<unknown>) =>
  async (c: Context<Env>) => {
    const result = await read(requireActor(c.get("actor")), await getWorkspaceId(), uuidParam(c, param));
    if (!result) throw new StatusError(404, "tag not found");
    return c.json(result);
  };

router.get("/:id", tagRead("id", readTagDetail));

// Edits to tag identity (name, color). Admin-only — name/color affect every
// node carrying this tag, including across the audit trail. Through the spine:
// admin authority, an attributed TAG_UPDATED event carrying prev values, and
// row+event atomicity. The early authority check keeps the decision ahead of
// the existence lookup; the in-mutate principal_admin is the backstop.
router.patch("/:id", async (c) => {
  const row = await updateTagIdentity(c.get("actor"), await getWorkspaceId(), c.req.param("id"),
    () => parseBody(c, z.object({ name: tagNameLength.optional(), color: z.string().refine(isHexColor, "color must be #rrggbb").nullable().optional() })));
  return row ? c.json(row) : c.json({ error: "tag not found" }, 404);
});

// A tag's functions (docs/architecture/proposals/function-references-2026-11-02.md): one reference row per
// function, added and removed through services/functionRefs.ts. Function ids are validated against the
// registered tag functions (400); principal admin only.
const functionBody = z.object({ config: z.record(z.string(), z.unknown()).optional() });
router.put("/:id/functions/:functionId", async (c) => {
  const actor = requireActor(c.get("actor"));
  const tagId = uuidParam(c, "id");
  const workspaceId = await getWorkspaceId();
  const input = await parseBody(c, functionBody);
  const { refId, added } = await addFunction({ actor, workspaceId, holder: { kind: "node", id: tagId }, functionId: c.req.param("functionId"), config: input.config });
  return c.json({ id: tagId, function_id: c.req.param("functionId"), ref_id: refId, added });
});

router.delete("/:id/functions/:functionId", async (c) => {
  const actor = requireActor(c.get("actor"));
  const tagId = uuidParam(c, "id");
  const workspaceId = await getWorkspaceId();
  const functionId = c.req.param("functionId");
  const refId = await ownFunctionRefId(actor, tagId, functionId);
  if (!refId) throw new FunctionRefError(404, "function reference not found");
  return c.json({ id: tagId, function_id: functionId, ...(await removeFunction({ actor, workspaceId, refId })) });
});

router.patch("/:id/functions/:functionId", async (c) => {
  const actor = requireActor(c.get("actor"));
  const tagId = uuidParam(c, "id");
  const workspaceId = await getWorkspaceId();
  const functionId = c.req.param("functionId");
  const input = await parseBody(c, z.object({ config: z.record(z.string(), z.unknown()) }));
  const ref = (await functionsOf(actor, { kind: "node", id: tagId }))?.find((use) => use.functionId === functionId && use.instance === "" && use.refId);
  if (!ref?.refId) throw new FunctionRefError(404, "function reference not found");
  return c.json({ id: tagId, function_id: functionId, ...(await setFunctionConfig({ actor, workspaceId, refId: ref.refId, config: input.config })) });
});

// The previous frontend release's tag-function writes (see services/legacyTagFunctionWrites.ts).
const modulePatchSchema = z.record(z.string(), z.boolean());
router.patch("/:id/modules", async (c) => {
  const actor = requireActor(c.get("actor"));
  return c.json(await patchTagModules({ actor, workspaceId: await getWorkspaceId(), tagId: uuidParam(c, "id"), modules: await parseBody(c, modulePatchSchema) }));
});

const extendsSchema = z.object({ extends: z.array(z.string().uuid()).max(50) });
router.put("/:id/extends", async (c) => {
  const actor = requireActor(c.get("actor"));
  const input = await parseBody(c, extendsSchema);
  return c.json(await putTagExtends({ actor, workspaceId: await getWorkspaceId(), tagId: uuidParam(c, "id"), extends: input.extends }));
});

// Schema editing defines fields and module settings, so it retains the principal
// admin gate. Record only changed top-level values; each is an atomic inverse.
router.patch("/:id/schema", async (c) => {
  const identity = requireActor(c.get("actor"));
  await assertAuthority(identity, { kind: "principal_admin" });
  const workspaceId = await getWorkspaceId();
  const { id } = c.req.param();
  const body = await parseBody(c, z.object({
    // Each field's shape is judged where the schema is written (writeTagSchema,
    // services/fieldSchema.ts), against the fields it already stores.
    fields: z.array(z.unknown()).optional(),
    views: z.record(z.string(), z.unknown()).optional(),
    behaviour: z.record(z.string(), z.unknown()).optional(),
    // `policy` is no longer accepted: spaces decide access, tags never do.
  }));
  body.fields = normalizeFieldIdentifiers(body.fields);

  // The write, its "unchanged" test and every check on the values
  // (shape, names, same-name fields, behaviour) are patchTagSchema's.
  const result = await patchTagSchema({ actor: identity, workspaceId, tagId: id, patch: body, uiContext: "tag.schema.patch" });
  if (!result) throw new StatusError(404, "tag not found");
  const schema = result.schema ?? { fields: [], views: {}, behaviour: {} };
  return c.json({ id: result.schema ? id : null, ...Object.fromEntries((["fields", "views", "behaviour"] as const).map((key) => [key, schema[key] ?? null])) });
});

// ── TagPack import (services/tagPacks.ts installTagPack) ───────────────────

router.post("/import", async (c) => {
  try {
    return c.json(await installTagPack(c.get("actor"), () => readJsonBody(c)), 201);
  } catch (e) {
    if (e instanceof TagPackRefusal) return c.json(e.body, e.status);
    throw e;
  }
});

// ─────────────────────────────────────────────────────────────────────────
// M3.1: collection_views CRUD — saved views per class tag.
// Routes:
//   GET    /:tagId/views              — list views for a tag
//   POST   /:tagId/views              — create
//   PATCH  /:tagId/views/:viewId      — update (partial)
//   DELETE /:tagId/views/:viewId      — soft-delete via emit + DELETE
// ─────────────────────────────────────────────────────────────────────────

router.get("/:tagId/path", async (c) => {
  const workspaceId = await getWorkspaceId();
  const tagId = c.req.param("tagId");
  // A restrictive ancestor's policy cascades down to this tag, so gating the
  // tag itself also covers every ancestor title the path string exposes.
  if (!(await canSeeTag(requireActor(c.get("actor")), tagId))) {
    throw new StatusError(404, "tag not found");
  }
  const path = await fullTagPath(workspaceId, tagId);
  return c.json({ path });
});

router.get("/:tagId/descendants", async (c) => {
  const workspaceId = await getWorkspaceId();
  const tagId = c.req.param("tagId");
  const actor = requireActor(c.get("actor"));
  if (!(await canSeeTag(actor, tagId))) {
    throw new StatusError(404, "tag not found");
  }
  // Descendant tags are global definitions like their root.
  const out = await descendantsOf(workspaceId, tagId);
  return c.json({ descendants: out, count: out.length });
});

// The block nodes carrying the tag (or a member tag) themselves: the tag page lists them after its notes, which it
// reads from the local store (block nodes are not in it).
router.get("/:tagId/blocks", async (c) => {
  const actor = requireActor(c.get("actor"));
  const tagId = uuidParam(c, "tagId");
  if (!(await canSeeTag(actor, tagId))) throw new StatusError(404, "tag not found");
  return c.json(await tagBlocks(actor, await getWorkspaceId(), tagId, parsePage(pageQueryOf(c), TAG_BLOCKS_PAGE)));
});

// Saved views: services/tagViews.ts.
router.get("/:tagId/views", async (c) => {
  const views = await listTagViews(requireActor(c.get("actor")), await getWorkspaceId(), c.req.param("tagId"));
  if (!views) throw new StatusError(404, "tag not found");
  return c.json({ views });
});

router.post("/:tagId/views", async (c) => {
  const v = await parseBody(c, viewCreateSchema);
  const row = await createTagView(requireActor(c.get("actor")), await getWorkspaceId(), c.req.param("tagId"), v);
  if (!row) throw new StatusError(404, "tag not found");
  return c.json({ id: row.id }, 201);
});

router.patch("/:tagId/views/:viewId", async (c) => {
  const updates = await parseBody(c, viewPatchSchema);
  const updated = await updateTagView(requireActor(c.get("actor")), await getWorkspaceId(), c.req.param("tagId"), c.req.param("viewId"), updates);
  if (!updated) throw new StatusError(404, "not_found");
  return c.json({ updated: true });
});

router.get("/:tagId/views/:viewId/exec", async (c) => {
  // services/paging.ts: `?limit=-5` is a 400, not `LIMIT -4` (D66).
  const page = parsePage(pageQueryOf(c), VIEW_PAGE);
  const result = await executeTagView(requireActor(c.get("actor")), await getWorkspaceId(), c.req.param("tagId"), c.req.param("viewId"), page);
  if (!result) throw new StatusError(404, "not_found");
  return c.json(result);
});

router.delete("/:tagId/views/:viewId", async (c) => {
  const deleted = await deleteTagView(requireActor(c.get("actor")), await getWorkspaceId(), c.req.param("tagId"), c.req.param("viewId"));
  if (!deleted) throw new StatusError(404, "not_found");
  return c.json({ deleted: true });
});

// Merging #source into #target: services/tagMerge.ts.
router.get("/:sourceId/merge-preview", async (c) => {
  const actor = requireActor(c.get("actor"));
  return c.json(await previewTagMerge(actor, await getWorkspaceId(), c.req.param("sourceId"), c.req.query("target") ?? ""));
});

router.post("/:sourceId/merge", async (c) => {
  const actor = requireActor(c.get("actor"));
  const input = await parseBody(c, z.object({ target_id: z.string().uuid() }));
  const merged = await mergeTags(actor, await getWorkspaceId(), c.req.param("sourceId"), input.target_id);
  return c.json({
    merged: true,
    members_gained_target: merged.applied,
    source_deleted: true,
    // The FULL-undo handle: cascade-restoring this event removes the
    // target additions (TAG_APPLIED/defaults/template children) AND
    // undeletes the source — see eventRestore TAG_MERGED.
    merge_event_id: merged.mergeEventId,
  });
});

// P2 safe-delete: what deleting this tag would AFFECT, in plain numbers —
// members losing the tag, schema fields whose values stay behind as
// free-form attrs, and saved views that disappear. The delete
// itself is the node soft-delete (tag = node; junction rows survive, so
// undelete restores everything) — this endpoint is the look-before-you-leap.
router.get("/:tagId/delete-preview", tagRead("tagId", tagDeletePreview));

export default router;
