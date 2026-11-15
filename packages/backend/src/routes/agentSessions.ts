import { Hono } from "hono";
import { z } from "zod";
import { getWorkspaceId } from "../services/workspaceId.js";
import type { ActorCtx } from "../types.js";
import { requireActor } from "../spine/actor.js";
import {
  cancel, configureRunner, insertReplyAsSuggestion, listRunners, revertSession, sessionsForNode, sessionView, setRunnerEnabled, startSession,
} from "../services/agentSessions.js";

// The person's side of agent sessions (proposal §1, §3): send a mention, read
// its session, cancel it, undo it, and manage which agents answer to an @handle.
// The runner's side is routes/mcpSessions.ts. Every handler calls one function
// in services/agentSessions.ts; who may do what (the sender, the owner, the
// agent's owner) is decided there, not here.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

const UUID = z.string().uuid();

const SendBody = z.object({
  node_id: UUID,
  /** Which mention: its block's ^id, or — before it has one — the block's text. Exactly one. */
  block_id: z.string().min(1).max(64).optional(),
  block_text: z.string().min(1).max(10_000).optional(),
  /** Send the same mention again (a new revision; the open one is cancelled). */
  resend: z.boolean().optional(),
}).refine((b) => (b.block_id === undefined) !== (b.block_text === undefined), { message: "give block_id or block_text, not both" });

// POST /api/agent-sessions — explicit send of an @mention (201 new, 200 the
// session this mention already has: a double click or retry changes nothing).
router.post("/", async (c) => {
  const actor = requireActor(c.get("actor"));
  const body = SendBody.parse(await c.req.json());
  const workspaceId = await getWorkspaceId();
  const { session, created } = await startSession(workspaceId, {
    actor, nodeId: body.node_id, resend: body.resend,
    target: body.block_id !== undefined ? { blockId: body.block_id } : { blockText: body.block_text! },
  });
  return c.json({ created, session: await sessionView(session.id, { actor }) }, created ? 201 : 200);
});

// GET /api/agent-sessions?node_id= — the newest session of each mention in a note.
router.get("/", async (c) => {
  const nodeId = UUID.parse(c.req.query("node_id"));
  return c.json({ sessions: await sessionsForNode(await getWorkspaceId(), nodeId, { actor: requireActor(c.get("actor")) }) });
});

// ── runners: which agent answers to which @handle (owner only) ──────────────

router.get("/runners", async (c) => c.json({ runners: await listRunners(await getWorkspaceId(), { actor: requireActor(c.get("actor")) }) }));

const RunnerBody = z.object({
  handle: z.string().min(1).max(64),
  max_concurrent: z.number().int().positive().optional(),
  max_per_hour: z.number().int().positive().optional(),
  timeout_seconds: z.number().int().positive().optional(),
});

router.put("/runners/:actor_id", async (c) => {
  const actor = requireActor(c.get("actor"));
  const body = RunnerBody.parse(await c.req.json());
  const runner = await configureRunner(await getWorkspaceId(), UUID.parse(c.req.param("actor_id")), {
    handle: body.handle, maxConcurrent: body.max_concurrent, maxPerHour: body.max_per_hour, timeoutSeconds: body.timeout_seconds,
  }, { actor });
  return c.json({ runner });
});

// The kill switch: off cancels the agent's open sessions and revokes their tokens.
router.post("/runners/:actor_id/enabled", async (c) => {
  const actor = requireActor(c.get("actor"));
  const { enabled } = z.object({ enabled: z.boolean() }).parse(await c.req.json());
  return c.json(await setRunnerEnabled(await getWorkspaceId(), UUID.parse(c.req.param("actor_id")), enabled, { actor }));
});

// ── one session ─────────────────────────────────────────────────────────────

router.get("/:id", async (c) => c.json({ session: await sessionView(c.req.param("id"), { actor: requireActor(c.get("actor")) }) }));

router.post("/:id/cancel", async (c) => {
  const actor = requireActor(c.get("actor"));
  const { session, changed } = await cancel(c.req.param("id"), { actor });
  return c.json({ changed, session: await sessionView(session.id, { actor }) });
});

// Undo the whole session: its reply and every other write of the agent in it.
router.post("/:id/revert", async (c) => c.json(await revertSession(c.req.param("id"), { actor: requireActor(c.get("actor")) })));

// A suggest-mode agent's reply goes into the note as one suggestion (never a direct write).
router.post("/:id/insert-reply", async (c) => c.json(await insertReplyAsSuggestion(c.req.param("id"), { actor: requireActor(c.get("actor")) })));

export default router;
