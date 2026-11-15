import { z } from "zod";
import { assertAuthority } from "../../spine/authority.js";
import { COMMENT_MAX, createSuggestions } from "../aiSuggestions.js";
import type { AgentTool } from "./types.js";

const Args = z.object({
  id: z.string().uuid(),
  text: z.string().min(1).max(COMMENT_MAX),
  /** The paragraph the comment is about, exactly as in the note (optional). */
  quote: z.string().max(10_000).optional(),
});

type CommentResult = { status: "commented"; note: string };

// A comment changes no text: it appears beside the paragraph for the user to
// read and mark done. An agent that may only suggest uses it to say what it
// cannot do (a new note, a tag change).
export const commentOnNote: AgentTool<z.infer<typeof Args>, CommentResult> = {
  name: "commentOnNote",
  access: "write",
  description:
    "Leave a comment on a node for the user (nothing in the note changes). Pass `quote` to attach it " +
    "to a paragraph, copied exactly. Use it to point out a problem, ask a question, or say what you " +
    "could not do. You need edit rights in the note's space.",
  inputSchema: Args,
  async handler(args, { actor, workspaceId, dryRun }) {
    if (dryRun) {
      await assertAuthority(actor, { kind: "node", nodeId: args.id, op: "write_node" });
      return { status: "commented", note: "[dry-run] nothing was saved" };
    }
    await createSuggestions(workspaceId, {
      actor,
      proposer: { agentActorId: actor.id, sessionId: actor.tokenScope?.sessionId ?? null },
      nodeId: args.id,
      comments: [{ text: args.text, ...(args.quote !== undefined ? { anchorText: args.quote } : {}) }],
    });
    return { status: "commented", note: "the comment is saved for the user" };
  },
};
