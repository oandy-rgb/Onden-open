import { Hono } from "hono";
import { getWorkspaceId } from "../services/workspaceId.js";
import { requireActor } from "../spine/mutate.js";
import { isPerson, isWorkspaceOwner } from "../spine/authority.js";
import { z } from "zod";
import {
  createSharedSpace, deleteSpace, isCapabilityKey, listMembers, memberCandidates, moveToSpace, previewMove, previewSpaceDelete, setMember,
  spacesForActor, updateSpace,
} from "../services/spaces.js";
import type { ActorCtx } from "../types.js";
import { SPACE_PERMISSIONS } from "../spine/spaceAccess.js";
import { spaceOverview } from "../services/spaceOverview.js";
import { endTemporarySession, listTemporarySessions, openTemporarySession } from "../services/participantSessions.js";
import { FRESH_PROOF_HEADER } from "../services/freshProof.js";
import { SPACE_NAME_MAX } from "@onden/markdown";
import { parseBody, uuidParam, uuidQuery } from "./params.js";

// Spaces (docs/architecture/spaces.md): list, create and manage spaces, and
// move a note (with its subtree) from one space to another.
const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

// GET /api/spaces — the caller's spaces and their permission in each, and
// whether the caller is the workspace owner.
router.get("/", async (c) => {
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  return c.json({ spaces: await spacesForActor(actor, workspaceId), is_owner: await isWorkspaceOwner(actor) });
});

// GET /api/spaces/overview — the owner's view of every shared space: members,
// switches, what each AI can actually reach and the first reason it cannot.
// Owner only (403 owner_only); personal spaces never appear.
router.get("/overview", async (c) => c.json(await spaceOverview(c.get("actor"), await getWorkspaceId())));

// Temporary sessions (services/participantSessions.ts): one person on a computer that is not theirs, on the spaces they pick. These paths come before
// /:id so "sessions" is never read as a space.
// POST /api/spaces/sessions {spaces: [{space_id, permission}], minutes?, max_requests?, max_bytes?} — the owner, a person (not a token, not a session),
//   with a fresh confirmation in the X-Onden-Fresh-Proof header (purpose open_session). The credential is in the answer, once.
// GET /api/spaces/sessions — the live sessions. DELETE /api/spaces/sessions/:id — end one now.
const openSessionSchema = z.object({
  spaces: z.array(z.object({ space_id: z.string().uuid(), permission: z.enum(SPACE_PERMISSIONS) }).strict()).min(1).max(50),
  minutes: z.number().int().positive().optional(),
  max_requests: z.number().int().positive().optional(),
  max_bytes: z.number().int().positive().optional(),
}).strict();
router.post("/sessions", async (c) => {
  const actor = requireActor(c.get("actor"));
  const input = await parseBody(c, openSessionSchema);
  const opened = await openTemporarySession(actor, await getWorkspaceId(), {
    spaces: input.spaces.map((s) => ({ spaceId: s.space_id, permission: s.permission })),
    minutes: input.minutes, maxRequests: input.max_requests, maxBytes: input.max_bytes,
  }, c.req.header(FRESH_PROOF_HEADER));
  c.header("Cache-Control", "no-store"); // the credential is in this answer
  return c.json({
    session_id: opened.sessionId, credential: opened.credential, expires_at: opened.expiresAt,
    spaces: opened.spaces.map((s) => ({ space_id: s.spaceId, permission: s.permission })),
  }, 201);
});
router.get("/sessions", async (c) => c.json({ sessions: await listTemporarySessions(requireActor(c.get("actor")), await getWorkspaceId()) }));
router.delete("/sessions/:id", async (c) => c.json({ ok: true, ...(await endTemporarySession(requireActor(c.get("actor")), await getWorkspaceId(), uuidParam(c, "id"))) }));

// POST /api/spaces {name} — create a shared space; the workspace owner only, and
// they start as an editing member of it.
router.post("/", async (c) => {
  const actor = requireActor(c.get("actor"));
  const input = await parseBody(c, z.object({ name: z.string().trim().min(1).max(SPACE_NAME_MAX) }));
  return c.json(await createSharedSpace(actor, await getWorkspaceId(), input.name), 201);
});

const capabilitiesSchema = z.record(z.string(), z.boolean()).refine(
  (caps) => Object.keys(caps).every(isCapabilityKey), { message: "unknown capability" });

// PATCH /api/spaces/:id {name?, capabilities?} — whoever manages it: the owner
// for a shared space, its person for a personal one.
router.patch("/:id", async (c) => {
  const actor = requireActor(c.get("actor"));
  const id = uuidParam(c, "id");
  const input = await parseBody(c, z.object({ name: z.string().trim().min(1).max(SPACE_NAME_MAX).optional(), capabilities: capabilitiesSchema.optional() }));
  await updateSpace(actor, await getWorkspaceId(), id, input);
  return c.json({ ok: true });
});

// GET /api/spaces/:id/delete-preview — what deleting it meets: live notes
// (which block it) and deleted ones (which need a choice). The owner only.
router.get("/:id/delete-preview", async (c) => {
  const actor = requireActor(c.get("actor"));
  const id = uuidParam(c, "id");
  return c.json(await previewSpaceDelete(actor, await getWorkspaceId(), id));
});

// DELETE /api/spaces/:id {deleted_notes?: "purge" | "move", expected_deleted_ids?}
// — a shared space with no live notes; its deleted notes are deleted for good
// or moved to the caller's personal space, as chosen (services/spaces.ts
// deleteSpace).
router.delete("/:id", async (c) => {
  const actor = requireActor(c.get("actor"));
  const id = uuidParam(c, "id");
  // "purge" carries the deleted rows the dialog showed
  // (SpaceDeletePreview.deleted_ids): any difference since — a note deleted
  // there, or one restored and another deleted — refuses (409 plan_changed)
  // instead of going unseen.
  const input = await parseBody(c, z.object({
    deleted_notes: z.enum(["purge", "move"]).optional(),
    expected_deleted_ids: z.array(z.string().uuid()).max(100_000).optional(),
  }).refine((body) => body.deleted_notes !== "purge" || body.expected_deleted_ids !== undefined,
    { message: "deleted_notes \"purge\" needs expected_deleted_ids", path: ["expected_deleted_ids"] }),
  { optional: true });
  const r = await deleteSpace(actor, await getWorkspaceId(), id,
    { deletedNotes: input.deleted_notes, expectedDeletedIds: input.expected_deleted_ids });
  return c.json({ ok: true, ...r });
});

// GET /api/spaces/:id/members — anyone in the space.
router.get("/:id/members", async (c) => {
  const actor = requireActor(c.get("actor"));
  const id = uuidParam(c, "id");
  const workspaceId = await getWorkspaceId();
  // The live temporary sessions on this space ride along for whoever may see them (the owner); a session itself sees none.
  return c.json({ members: await listMembers(actor, workspaceId, id), sessions: isPerson(actor) ? await listTemporarySessions(actor, workspaceId, { spaceId: id }) : [] });
});

// GET /api/spaces/:id/candidates — people the owner can add (names only).
router.get("/:id/candidates", async (c) => {
  const actor = requireActor(c.get("actor"));
  const id = uuidParam(c, "id");
  return c.json({ people: await memberCandidates(actor, await getWorkspaceId(), id) });
});

// PUT /api/spaces/:id/members/:actorId {permission?: "view" | "edit"} · DELETE … —
// the owner only. A member added without a permission can only view (decision 6).
router.put("/:id/members/:actorId", async (c) => {
  const actor = requireActor(c.get("actor"));
  const id = uuidParam(c, "id");
  const input = await parseBody(c, z.object({ permission: z.enum(SPACE_PERMISSIONS).default("view") }).strict(), { optional: true });
  await setMember(actor, await getWorkspaceId(), id, c.req.param("actorId"), input.permission);
  return c.json({ ok: true });
});
router.delete("/:id/members/:actorId", async (c) => {
  const actor = requireActor(c.get("actor"));
  const id = uuidParam(c, "id");
  await setMember(actor, await getWorkspaceId(), id, c.req.param("actorId"), null);
  return c.json({ ok: true });
});

// GET /api/spaces/move-preview?node=&to= — who gains and loses access.
router.get("/move-preview", async (c) => {
  const actor = requireActor(c.get("actor"));
  const node = uuidQuery(c, "node");
  const to = uuidQuery(c, "to");
  return c.json(await previewMove(actor, await getWorkspaceId(), node, to));
});

// POST /api/spaces/move {node_id, to_space_id, membership_epoch} — move a note
// and its subtree. membership_epoch is the one the preview showed.
router.post("/move", async (c) => {
  const actor = requireActor(c.get("actor"));
  const input = await parseBody(c, z.object({
    node_id: z.string().uuid(), to_space_id: z.string().uuid(), membership_epoch: z.string().regex(/^\d+$/),
  }));
  const r = await moveToSpace(actor, await getWorkspaceId(), input.node_id, input.to_space_id, input.membership_epoch);
  return c.json(r);
});

export default router;
