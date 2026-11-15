import { Hono } from "hono";
import { z } from "zod";
import { getWorkspaceId } from "../services/workspaceId.js";
import type { ActorCtx } from "../types.js";
import { requireActor } from "../spine/actor.js";
import { isRuntimeKind, type RuntimeKind } from "../services/agentRuntime/index.js";
import { CHAT_TEXT_MAX, clearPanelChat, panelChatRoles, panelChatThread, startPanelChat } from "../services/panelChat.js";
import { parseBody, uuidParam } from "./params.js";

// The info panel's 「AI」 tab (services/panelChat.ts). Who may ask and what the AI may
// read is decided there; an answer's stream is the one at GET /api/ai/selection-actions/:id/stream.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();
const UUID = z.string().uuid();

// GET /api/ai/panel-chat/:nodeId/roles — who can answer here, and the ways each can run.
router.get("/:nodeId/roles", async (c) =>
  c.json(await panelChatRoles(await getWorkspaceId(), uuidParam(c, "nodeId"), { actor: requireActor(c.get("actor")) })));

// GET /api/ai/panel-chat/:nodeId — this person's conversation about the note.
router.get("/:nodeId", async (c) =>
  c.json(await panelChatThread(await getWorkspaceId(), uuidParam(c, "nodeId"), { actor: requireActor(c.get("actor")) })));

const StartBody = z.object({
  agent_actor_id: UUID, node_id: UUID, text: z.string().min(1).max(CHAT_TEXT_MAX), request_id: UUID,
  /** Notes and tags added to the open note as the AI's reach for this question. */
  scope_note_ids: z.array(UUID).max(16).optional(), scope_tag_ids: z.array(UUID).max(16).optional(),
  runtime: z.string().refine(isRuntimeKind).optional(),
});
// POST /api/ai/panel-chat — 201 new, 200 the turn this request_id already made.
router.post("/", async (c) => {
  const body = await parseBody(c, StartBody);
  const { sessionId, created } = await startPanelChat(await getWorkspaceId(), {
    actor: requireActor(c.get("actor")), agentActorId: body.agent_actor_id, nodeId: body.node_id, text: body.text, requestId: body.request_id,
    scope: { noteIds: body.scope_note_ids, tagIds: body.scope_tag_ids }, runtime: body.runtime as RuntimeKind | undefined,
  });
  return c.json({ session_id: sessionId, created }, created ? 201 : 200);
});

// DELETE /api/ai/panel-chat/:nodeId — 「清除這段對話」 (the caller's own conversation about a note they can read).
router.delete("/:nodeId", async (c) =>
  c.json(await clearPanelChat(await getWorkspaceId(), uuidParam(c, "nodeId"), { actor: requireActor(c.get("actor")) })));

export default router;
