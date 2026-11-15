import { TAG_NAME_MAX, isHexColor } from "@onden/markdown";
import { z } from "zod";
import { enqueueTagPackProposal } from "../tagPacks.js";
import { validateTagPack } from "../tagPacks.js";
import { assertTagNameAvailable } from "../tagHierarchy.js";
import { attributeFieldSchema } from "../fieldSchema.js";
import { assertFieldNamesAllowed, withoutAutomation } from "../tagWrites.js";
import { eventActorType } from "../../types.js";
import type { AgentTool } from "./types.js";

// The AI-pack rail (⑥ #review groundwork): an agent can PROPOSE a tag pack —
// schema fields + policy + module settings (what a module like #review reads) +
// template children — but never install one. The call files a held request
// (outbox status='pending_approval', held in the owner's inbox); the pack only installs after a principal admin approves it in
// the inbox: the agent drafts the capability, the human grants it. The retired
// automation keys (tagWrites.withoutAutomation) are left out of the proposal.

// The one schema field shape (services/fieldSchema.ts): every type and every
// property a field can have (a rating's max, a select's options, …). The tool
// only shortens the name and lets the type default to text.
const Field = attributeFieldSchema.extend({
  name: z.string().min(1).max(80),
  type: attributeFieldSchema.shape.type.default("text"),
});

const Args = z.object({
  name: z.string().min(1).max(TAG_NAME_MAX),
  description: z.string().max(2000).optional(),
  color: z.string().refine(isHexColor, "must be #rrggbb").optional(),
  fields: z.array(Field).max(40).default([]),
  /** Settings the backing module reads (e.g. #review's scheduling). Stored on
   *  the schema; inert without a module. The retired automation keys
   *  (on_apply, on_remove, on_attribute_change) are dropped. */
  behaviour: z.record(z.string(), z.unknown()).optional(),
  template_children: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
  modules: z.array(z.string()).max(10).optional(),
  publish_collection: z.boolean().optional(),
});

type ProposeTagPackResult = {
  status: "pending_approval";
  note: string;
};

export const proposeTagPack: AgentTool<z.infer<typeof Args>, ProposeTagPackResult> = {
  name: "proposeTagPack",
  access: "write",
  description:
    "Propose a new tag pack (schema fields + optional module settings + template children). " +
    "The pack is NOT installed now: it lands in the owner's inbox as a pending approval and only " +
    "installs after a human approves it. Use this to draft structured capabilities (e.g. a review/" +
    "flashcard tag) for the owner to grant.",
  inputSchema: Args,
  async handler(args, { actor, workspaceId, dryRun }) {
    const pack = {
      name: args.name,
      description: args.description,
      color: args.color,
      fields: args.fields,
      behaviour: args.behaviour && withoutAutomation({ behaviour: args.behaviour }).behaviour,
      template_children: args.template_children,
      modules: args.modules,
      publish_collection: args.publish_collection,
      _format: "proposal/v1",
    };
    // Same format gate the owner's import runs — reject malformed packs at
    // the tool boundary instead of at approval time.
    const v = validateTagPack(pack);
    if (!v.ok) throw new Error(v.error);
    // The pack would install at the root: same rule and 409 as a direct import.
    await assertTagNameAvailable(workspaceId, null, { title: args.name, parentId: null });
    // Field names follow the attribute key grammar, as the install will
    // judge them (tagWrites FieldNameRule): refuse now, not at approval.
    await assertFieldNamesAllowed(workspaceId, v.pack.fields, []);
    const note = "pack proposal filed; it installs only if the workspace owner approves it in the inbox";
    if (dryRun) return { status: "pending_approval", note: `[dry-run] ${note}` };
    await enqueueTagPackProposal({
      workspaceId,
      pack,
      requestedByActorId: actor.id,
      requestedByActorType: eventActorType(actor.type),
    });
    return { status: "pending_approval", note };
  },
};
