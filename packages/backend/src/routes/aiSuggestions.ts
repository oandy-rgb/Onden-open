import { Hono } from "hono";
import { z } from "zod";
import { getWorkspaceId } from "../services/workspaceId.js";
import type { ActorCtx } from "../types.js";
import { requireActor } from "../spine/actor.js";
import { CodedStatusError } from "../statusError.js";
import { acceptSuggestionItems, rejectSuggestionItems, suggestionsForNode } from "../services/aiSuggestions.js";
import { requirePerson } from "../spine/authority.js";
import { parseBody, uuidParam, uuidQuery } from "./params.js";

// A person's side of AI suggestions (services/aiSuggestions.ts): read a note's
// pending places, accept or reject them. Agents file suggestions through their
// tools, never here. A token cannot decide: only a person at the app can.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

const UUID = z.string().uuid();
const Decision = z.object({ item_ids: z.union([z.literal("all"), z.array(UUID).min(1).max(500)]) });

function person(actor: ActorCtx | null): ActorCtx {
  const a = requireActor(actor);
  requirePerson(a, "ai_suggestion_decide");
  return a;
}

// GET /api/ai-suggestions?node_id= — what still needs the person in this note.
router.get("/", async (c) => {
  const nodeId = uuidQuery(c, "node_id");
  const found = await suggestionsForNode(await getWorkspaceId(), nodeId, { actor: person(c.get("actor")) });
  if (!found) throw new CodedStatusError(404, "not_found", "note not found");
  return c.json({ suggestions: found.suggestions, can_decide: found.canDecide });
});

router.post("/:id/accept", async (c) => {
  const body = await parseBody(c, Decision);
  const result = await acceptSuggestionItems(await getWorkspaceId(), {
    actor: person(c.get("actor")), suggestionId: uuidParam(c, "id"), itemIds: body.item_ids,
  });
  return c.json(result);
});

router.post("/:id/reject", async (c) => {
  const body = await parseBody(c, Decision);
  const result = await rejectSuggestionItems(await getWorkspaceId(), {
    actor: person(c.get("actor")), suggestionId: uuidParam(c, "id"), itemIds: body.item_ids,
  });
  return c.json(result);
});

export default router;
