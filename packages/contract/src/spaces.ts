// Spaces: who reaches what, the preview before a note moves, the preview before a space is deleted.
// Pure types: the app imports them with `import type`, so nothing here may run.

/** The first thing that stops an agent from reading or writing in a space, in
 *  the order the owner is told (roles proposal §5). */
export type AccessBlock =
  | "no_live_token"    // the agent has no unexpired, unrevoked token
  | "not_member"       // the agent was not added to the space
  | "external_ai_off"  // the space's "AI can read" switch is off
  | "view_only"        // its permission here is view (writing)
  | "token_read_only";

export type EffectiveReach = { ok: boolean; blocked_by: AccessBlock | null };

export type SpaceKind = "personal" | "shared" | "system";

/** What happens to a shared space's deleted notes when it is deleted:
 *  "purge" deletes them for good (nodeTrash.ts purgeSpaceDeleted), "move"
 *  moves them, still deleted and restorable from History, to the deleter's
 *  personal space. */
export type DeletedNotesChoice = "purge" | "move";

/** What deleting a shared space has to deal with, for its dialog. */
export type SpaceDeletePreview = {
  /** Notes in it that are not deleted: any blocks the delete. */
  live_notes: number;
  /** RSS subscriptions kept in it (a table, not notes): any blocks the delete too. */
  subscriptions: number;
  /** Its deleted notes (checklist items not listed), oldest delete first. */
  deleted_notes: Array<{ id: string; title: string }>;
  /** Every deleted row in it, checklist items included. */
  deleted_count: number;
  /** Their ids (checklist items included): pass back to deleteSpace as
   *  `expectedDeletedIds` so a purge takes exactly what was shown. */
  deleted_ids: string[];
  /** Whether the deleter has a personal space to move them to. */
  can_move_to_personal: boolean;
};

export type MovePreview = {
  node_id: string;
  from: { id: string; name: string; kind: SpaceKind };
  to: { id: string; name: string; kind: SpaceKind };
  notes: number;
  /** People who will be able to see it and could not before. */
  gain: Array<{ id: string; name: string; type: "human" | "agent" }>;
  /** People who could see it and will not. */
  lose: Array<{ id: string; name: string; type: "human" | "agent" }>;
  membership_epoch: string;
};

/** What a member may do in a space. */
export type SpacePermission = "view" | "edit";

export type SpaceCapability = "publish" | "external_ai" | "backup" | "shared_seen" | "members_can_move_out";

export type OverviewMember = {
  actor_id: string;
  name: string;
  type: "human" | "agent";
  permission: SpacePermission;
  /** An agent's effective reach through its tokens; absent for a person. */
  effective?: { read: EffectiveReach; write: EffectiveReach };
};

/** The owner's overview of shared spaces and members (GET /api/spaces/overview). */
export type SpaceOverview = {
  owner_id: string | null;
  spaces: Array<{
    id: string; name: string; kind: "shared"; is_default: boolean;
    capabilities: Partial<Record<SpaceCapability, boolean>>;
    members: OverviewMember[];
  }>;
  /** Members in no shared space, who therefore read nothing shared; an agent carries the reason (it also has no live
   *  token, or simply was not added). */
  unplaced: Array<{ actor_id: string; name: string; type: "human" | "agent"; spaces: 0; invite_pending: boolean; blocked_by?: AccessBlock }>;
  agents: Array<{ actor_id: string; live_tokens: number; write_tokens: number }>;
};
