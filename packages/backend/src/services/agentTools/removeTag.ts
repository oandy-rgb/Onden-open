import { z } from "zod";
import { removeTagFromNode } from "../tagMembershipWrites.js";
import type { AgentTool } from "./types.js";

const Args = z.object({
  nodeId: z.string().uuid(),
  tagId: z.string().uuid(),
});

type RemoveTagResult = { ok: true; removed: boolean };

export const removeTag: AgentTool<z.infer<typeof Args>, RemoveTagResult> = {
  name: "removeTag",
  access: "write",
  description:
    "Remove a class_tag from a readable, writable node. The tag must allow " +
    "removal and both human and token scopes must allow the current target.",
  inputSchema: Args,
  async handler(args, { actor, workspaceId, dryRun }) {
    const removed = await removeTagFromNode({ ...args, actor, workspaceId, dryRun });
    return { ok: true, removed };
  },
};
