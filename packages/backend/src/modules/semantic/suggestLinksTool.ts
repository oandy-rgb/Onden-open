import { z } from "zod";
import { suggestLinksForNode } from "../../services/embeddings.js";
import type { AgentTool } from "../../services/agentTools/index.js";

// Surface semantically-related nodes that AREN'T already linked to a given node
// — the "connections you didn't see" the agent can propose (fills the
// suggested_link slot). Read-only: returns candidates; confirming one into a
// real edge goes through the edge-create path. Tag-scoped on reads like
// semanticSearch (a scoped token only proposes within its grant).

const Args = z.object({
  nodeId: z.string().uuid(),
  limit: z.number().int().min(1).max(20).default(5),
});

type SuggestLinksResult = {
  suggestions: Array<{ id: string; title: string; slug: string; distance: number }>;
};

export const suggestLinks: AgentTool<z.infer<typeof Args>, SuggestLinksResult> = {
  name: "suggestLinks",
  access: "read",
  description:
    "Given a node, suggest other nodes that are semantically related but not yet " +
    "linked to it — candidate connections to propose. Returns nearest nodes by " +
    "embedding distance, excluding ones already linked. Tag-scoped.",
  inputSchema: Args,
  async handler(args, { actor, workspaceId }) {
    const suggestions = await suggestLinksForNode(workspaceId, args.nodeId, { actor, limit: args.limit });
    return { suggestions };
  },
};
