import { z } from "zod";
import { AuthorityError } from "../../spine/authority.js";
import { NODE_MARKDOWN_MAX, NODE_TITLE_MAX, newNoteExtrasSchema } from "../../utils.js";
import { createNote, NoteCreateError } from "../noteCreate.js";
import type { AgentTool } from "./types.js";

// The agent's node-CREATE tool: the same createNote call as REST POST
// /api/nodes (human–agent parity), with the same size caps, tags and
// attributes. createNote owns every check, re-run under the workspace event
// lock for writes and dry runs alike: the parent must be readable and writable,
// the note lands in a space the caller may write (services/spaces.ts
// newNoteSpace; for a token, within its write scope with external_ai on), and
// each tag goes through the tag-apply policy (a refusal fails the whole create).
// The NODE_CREATED event, the derived state, the tags and the attributes commit
// together.
//
// Creating a node is REVERSIBLE (soft-delete / inbox reject), so it stays
// apply-then-review like every other agent write — no approve-before-apply gate.

const Args = z.object({
  title: z.string().min(1).max(NODE_TITLE_MAX),
  markdown: z.string().max(NODE_MARKDOWN_MAX).optional(),
  parent_id: z.string().uuid().optional(),
  // Before tag_ids existed the tool took one tag; still accepted.
  tag_id: z.string().uuid().optional(),
  ...newNoteExtrasSchema.shape,
});

type CreateNodeResult = {
  id: string;
  slug: string;
  title: string;
  event_id: string;
};

export const createNode: AgentTool<z.infer<typeof Args>, CreateNodeResult> = {
  name: "createNode",
  access: "write",
  description:
    "Create a new note, optionally tagged (tag_ids), with attributes, and nested " +
    "under a parent_id you can write. A top-level note goes into space_id, or the " +
    "only space you may write. Returns the new id + slug.",
  inputSchema: Args,
  async handler(args, { actor, workspaceId, dryRun }) {
    const tagIds = [...new Set([...(args.tag_id ? [args.tag_id] : []), ...(args.tag_ids ?? [])])];
    try {
      const { node, eventId } = await createNote({
        actor, workspaceId,
        title: args.title, markdown: args.markdown ?? "",
        // Agent-created nodes are 'ai'-sourced; a human using the tool is 'manual'.
        sourceType: actor.tokenScope ? "ai" : "manual",
        parentId: args.parent_id, spaceId: args.space_id,
        tagIds, attributes: args.attributes,
        event: {
          uiContext: "mcp.tool.createNode",
          txMeta: { tool_name: "createNode", token_id: actor.tokenScope?.tokenId },
        },
        dryRun,
      });
      return {
        id: dryRun ? "(dry-run)" : node.id as string, slug: node.slug as string, title: node.title as string, event_id: eventId,
      };
    } catch (error) {
      if (error instanceof NoteCreateError) throw new AuthorityError("workspace", "parent is not available in this workspace");
      throw error;
    }
  },
};
