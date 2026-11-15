import { z } from "zod";
import { semanticSearchNodes } from "../../services/embeddings.js";
import type { AgentTool } from "../../services/agentTools/index.js";

// Semantic (vector) search over node bodies — the retrieval read-path that lets
// an agent surface conceptually-related notes, not just keyword matches. Runs
// through callTool like every tool, so it inherits assertToolAllowed + rate
// limit + the AGENT_TOOL_CALLED audit for free.
//
// Unlike searchNodes/getNode, this DOES read-scope on reads (enforced in
// semanticSearchNodes via readableNodeIdSet: role/tag-policy visibility ∩ the
// token's tag scope) — neither a tag-scoped agent nor a low-role human must be
// able to semantically pull in notes outside what they may read.

const Args = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(10),
});

type SemanticSearchResult = {
  results: Array<{ id: string; title: string; slug: string; distance: number }>;
};

export const semanticSearch: AgentTool<z.infer<typeof Args>, SemanticSearchResult> = {
  name: "semanticSearch",
  access: "read",
  description:
    "Find nodes semantically related to a query by embedding similarity (not " +
    "keyword match). Returns nearest nodes by cosine distance, among notes " +
    "you can read.",
  inputSchema: Args,
  async handler(args, { actor, workspaceId }) {
    const results = await semanticSearchNodes(workspaceId, args.query, { actor, limit: args.limit });
    return { results };
  },
};
