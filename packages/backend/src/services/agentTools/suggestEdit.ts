import type { z } from "zod";
import { assertAuthority } from "../../spine/authority.js";
import { createSuggestions } from "../aiSuggestions.js";
import type { AgentTool } from "./types.js";
import { EditArgs } from "./editArgs.js";

export type SuggestEditResult = {
  status: "suggested" | "no_change";
  /** How many places the user will review (0: your text equals the note's). */
  places: number;
  note: string;
};

// The note is never changed here: the edit becomes pending places (a paragraph
// each) the user accepts or rejects in the note. Same arguments as updateNode,
// so an agent can switch between them; an agent set to suggest gets this from
// updateNode too (services/aiSuggestions.ts).
export const suggestEdit: AgentTool<z.infer<typeof EditArgs>, SuggestEditResult> = {
  name: "suggestEdit",
  access: "write",
  description:
    "Propose a change to a node's title and/or markdown body WITHOUT changing it. Send the whole " +
    "new markdown plus base_markdown (the markdown exactly as getNode returned it). The user sees " +
    "each changed paragraph in the note and accepts or rejects it; a paragraph they edited since is " +
    "not overwritten. Use this when the change is for the user to approve. You need edit rights in the note's space.",
  inputSchema: EditArgs,
  async handler(args, { actor, workspaceId, dryRun }) {
    if (dryRun) {
      await assertAuthority(actor, { kind: "node", nodeId: args.id, op: "write_node" });
      return { status: "suggested", places: 0, note: "[dry-run] nothing was saved" };
    }
    const saved = await createSuggestions(workspaceId, {
      actor,
      proposer: { agentActorId: actor.id, sessionId: actor.tokenScope?.sessionId ?? null },
      nodeId: args.id,
      baseMarkdown: args.markdown !== undefined ? args.base_markdown : undefined,
      proposedMarkdown: args.markdown,
      proposedTitle: args.title,
    });
    return saved.itemCount === 0
      ? { status: "no_change", places: 0, note: "your text is the same as the note: nothing to suggest" }
      : { status: "suggested", places: saved.itemCount, note: "saved as a suggestion for the user to review; the note itself is unchanged" };
  },
};
