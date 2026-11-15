// Part links `[[筆記/段落開頭]]` (services/blockLinks.ts), mounted beside the notes' own routes under /api/nodes.
import { BLOCK_ID } from "@onden/markdown";
import { Hono } from "hono";
import { z } from "zod";
import { getWorkspaceId } from "../services/workspaceId.js";
import { requireActor } from "../spine/mutate.js";
import { parseBody, uuidParam } from "./params.js";
import { confirmBlockAnchor, countBlockLinks, createBlockLink } from "../services/blockLinks.js";
import type { ActorCtx } from "../types.js";

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

// `[[筆記/段落開頭]]` (services/blockLinks.ts): anchor a part of note :id and bind the link text as it will be
// written in `source_note_id`; the answer is what goes between `[[` and `]]`. `at` / `seen_text`: where the person
// saw the part and what it began with. 409 = the part is not there any more, or the note cannot take a
// new anchor (the caller links the whole note instead).
router.post("/:id/block-links", async (c) => {
  const input = await parseBody(c, z.object({
    source_note_id: z.string().uuid(), at: z.number().int().min(0), seen_text: z.string().min(1).max(2000),
    suggested_text: z.string().max(200).optional(),
  }).strict());
  const targetNoteId = uuidParam(c, "id");
  const made = await createBlockLink({
    workspaceId: await getWorkspaceId(), actor: requireActor(c.get("actor")), targetNoteId, sourceNoteId: input.source_note_id,
    at: input.at, seenText: input.seen_text, suggestedText: input.suggested_text,
  });
  return c.json({ anchor_id: made.anchorId, link: made.link, link_text: made.linkText }, 201);
});

// "就是這段": the person confirms a doubtful anchor's place. false = nothing left to confirm.
router.post("/:id/block-anchors/:anchorId/confirm", async (c) => {
  const confirmed = await confirmBlockAnchor({
    workspaceId: await getWorkspaceId(), actor: requireActor(c.get("actor")),
    noteId: uuidParam(c, "id"), anchorId: z.string().regex(BLOCK_ID).parse(c.req.param("anchorId")),
  });
  return c.json({ confirmed });
});

// How many links the reader can see mean each anchor of note :id (the number in "有 N 處連到這段").
router.get("/:id/block-link-counts", async (c) => {
  return c.json({ counts: await countBlockLinks(requireActor(c.get("actor")), await getWorkspaceId(), uuidParam(c, "id")) });
});

export default router;
