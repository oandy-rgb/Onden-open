import type { z } from "zod";
import { updateNode as saveNode } from "../nodeUpdate.js";
import type { BodyConflict } from "../eventLog/index.js";
import type { AgentTool } from "./types.js";
import { EditArgs as Args } from "./editArgs.js";
import { cardAdvice } from "./cardAdvice.js";
import { suggestEdit, type SuggestEditResult } from "./suggestEdit.js";

type UpdateNodeResult = {
  id: string;
  slug: string;
  title: string;
  /** The body as saved: the next edit's base_markdown. */
  markdown: string;
  updated_at: string;
  /** The save's event; null when the note already held this text and title
   *  (nothing was written, so it is no new version). */
  event_id: string | null;
  /** Lines this agent and another writer both changed since the base. The
   *  body holds the agent's text there; the other writer's is each conflict's
   *  `current`, and BODY_CONFLICT puts it in the inbox. Empty when all merged. */
  conflicts: BodyConflict[];
  /** Present when this body marks a review card that has no answer: what to change (see cardAdvice.ts). */
  card_notes?: string[];
};

export const updateNode: AgentTool<z.infer<typeof Args>, UpdateNodeResult | SuggestEditResult> = {
  name: "updateNode",
  access: "write",
  description:
    "Update a node's title and/or markdown body. To change the body, send the " +
    "whole new markdown plus base_markdown: the markdown exactly as getNode " +
    "returned it (required with markdown). Edits others made since you read it " +
    "are merged in; lines both of you changed are listed in `conflicts` (your " +
    "text is kept there, theirs is in `current` and in the inbox) — check them. " +
    "The result's markdown is the saved body, the base_markdown for your next " +
    "edit. Triggers the full side-effect chain (version capture, wikilink + " +
    "block-id sync, attribute dispatcher). You need edit rights in the note's space. " +
    "If you were set to suggest edits, the note is NOT changed: the edit is saved as a " +
    "suggestion the user accepts place by place, and the result says so.",
  inputSchema: Args,
  async handler(args, ctx) {
    const { actor, workspaceId, dryRun } = ctx;
    // An agent set to suggest never writes: the same edit is filed for review.
    if (actor.tokenScope?.writeMode === "suggest") return suggestEdit.handler(args, ctx);
    const { node, eventId, bodyConflicts } = await saveNode(workspaceId, args.id, {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.markdown !== undefined ? { markdown: args.markdown } : {}),
    }, {
      actor, source: "agent", dryRun,
      ...(args.markdown !== undefined ? { baseMarkdown: args.base_markdown } : {}),
      // No editor session writes the agent's `^id`s, so the save does, base or not.
    });
    const cardNotes = args.markdown !== undefined ? await cardAdvice(workspaceId, args.base_markdown ?? "", node.markdown as string) : [];
    return {
      id: node.id as string, slug: node.slug as string, title: node.title as string,
      markdown: node.markdown as string,
      updated_at: dryRun ? "(dry-run)" : String(node.updated_at), event_id: eventId,
      conflicts: bodyConflicts,
      ...(cardNotes.length ? { card_notes: cardNotes } : {}),
    };
  },
};
