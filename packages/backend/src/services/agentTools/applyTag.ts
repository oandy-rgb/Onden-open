import { z } from "zod";
import { applyTagToNode } from "../tagMembershipWrites.js";
import type { AgentTool } from "./types.js";

const Args = z.object({
  nodeId: z.string().uuid(),
  tagId: z.string().uuid(),
});

type ApplyTagResult = { ok: true; applied: boolean };

export const applyTag: AgentTool<z.infer<typeof Args>, ApplyTagResult> = {
  name: "applyTag",
  access: "write",
  description:
    "Apply a class_tag to a readable, writable node. Templates and field " +
    "defaults are applied only for a new relationship. Both human and token " +
    "scopes apply; a token may enroll an untagged ordinary node, but cannot " +
    "bypass its policies or the actor's human scope.",
  inputSchema: Args,
  async handler(args, { actor, workspaceId, dryRun }) {
    const applied = await applyTagToNode({ ...args, actor, workspaceId, dryRun });
    return { ok: true, applied };
  },
};
