import { z } from "zod";
import { searchNodes as runSearch, type NodeSearchResult } from "../nodeSearch.js";
import type { AgentTool } from "./types.js";

// Thin wrapper over the shared nodeSearch service (the same code the HTTP
// /api/nodes/search route uses) — no duplicated SQL. Read-only, and bounded by
// the SAME combined read set the HTTP /api/nodes/search route applies:
// nodeSearch now PUSHES the actor's read scope (role/tag-policy visibility ∩
// bearer-token tag scope) into the query, so the agent search surface cannot
// exceed the actor's read-policy AND the LIMIT lands on already-authorized rows
// (no post-fetch filter that under-fills the page). Previously this filtered
// post-LIMIT with readableNodeIdSet; before that, only tokenReadableNodeIds —
// which let an agent surface nodes the role/tag READ-policy would deny (red-audit
// mcp-searchnodes-readpolicy). Both the leak and the under-fill are now closed
// at the query.

const Args = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(50).default(20),
});

type SearchNodesResult = NodeSearchResult[];

export const searchNodes: AgentTool<z.infer<typeof Args>, SearchNodesResult> = {
  name: "searchNodes",
  access: "read",
  description:
    "Full-text search over notes in the workspace. Supports tag filters (#tag), " +
    "attribute filters (key:value), and quoted phrases. Returns id, title, slug, " +
    "node_type, and a snippet when text matched: { text, ranges } — plain text and " +
    "the [start, end) offsets of the matches in it.",
  inputSchema: Args,
  async handler(args, { workspaceId, actor }) {
    // actor required → read scope pushed into the query; results are already
    // authorized and correctly page-filled, so no post-fetch .filter().
    return runSearch(workspaceId, args.query, actor, args.limit);
  },
};
