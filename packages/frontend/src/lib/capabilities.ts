// What the current person may do, decided in one place with the server's
// rules, so a control is shown exactly when the request would be allowed:
//   • a space check (spine/authority.ts `space`): `write` = the 編輯
//     permission, `manage` = the workspace owner on a shared space (or a
//     person on their own personal space), and managing covers writing;
//   • a note: the 編輯 permission in its space — a real permission only: note
//     writes (write_node → spaceScope.ts spaceCanWrite) have no owner
//     fallback, so the owner who can only 看 there edits nothing;
//   • a tag definition (class_tag) is in no space — editing it is the owner's
//     alone (authority.ts `node`: isTagDefinition && isWorkspaceOwner);
//   • moving a note out: who manages the space, or anyone who can edit it where
//     the shared space lets editors move notes out (services/spaces.ts
//     sourceAuthority, a space check) — and the move also writes the note, so
//     callers check canEdit too; into: who can write the target space;
//   • deleting a deleted note for good (History's 永久刪除, backend
//     nodeTrash.ts purgeDeleted): who manages its space — the space check. Unknown (spaces not loaded, a space this
//     person is not in) answers NO: a destructive control is never guessed.
// Unknown (offline, spaces still loading, a note without a space yet) answers
// yes for notes — the server still refuses, and the write is kept for retry.
// `actor_is_owner` and `can_review` are read only here.

import { useMemo } from "react";
import type { ContentNode } from "./api";
import { useAppSelector } from "./appStore";
import { useSpaces, type Space } from "./spaces";
import { isTag } from "@onden/markdown/contract";

export type Capabilities = {
  isOwner: boolean;
  canEdit: (node: Pick<ContentNode, "space_id" | "node_type"> | null) => boolean;
  canMoveOut: (space: Space) => boolean;
  canMoveInto: (space: Space) => boolean;
  canManageSpace: (space: Space) => boolean;
  /** May delete a deleted note in `spaceId` for good. */
  canPurgeDeleted: (spaceId: string | null | undefined) => boolean;
};

/** The server's `manage` check: the space says so (the owner on a shared space). */
export const canManageSpace = (space: Pick<Space, "can_manage">) => space.can_manage === true;
/** The server's `write` check: the 編輯 permission, which managing also covers. */
export const canWriteSpace = (space: Pick<Space, "permission" | "can_manage">) => space.permission === "edit" || canManageSpace(space);

export function capabilitiesFor(isOwner: boolean, spaces: Space[], loaded: boolean): Capabilities {
  return {
    isOwner,
    canEdit: (node) => {
      if (!node) return false;
      if (isTag(node)) return isOwner;
      if (!loaded) return true;
      const space = spaces.find((s) => s.id === node.space_id);
      return !space || space.permission === "edit";
    },
    canMoveOut: (space) => space.kind === "shared" && space.capabilities.members_can_move_out === true
      ? canWriteSpace(space)
      : canManageSpace(space),
    canMoveInto: canWriteSpace,
    canManageSpace,
    canPurgeDeleted: (spaceId) => {
      const space = loaded && spaceId ? spaces.find((s) => s.id === spaceId) : undefined;
      return !!space && canManageSpace(space);
    },
  };
}

export function useCapabilities(online: boolean): Capabilities {
  const isOwner = useAppSelector((s) => s.data.actor_is_owner === true);
  const { spaces, loaded } = useSpaces(online);
  return useMemo(() => capabilitiesFor(isOwner, spaces, loaded), [isOwner, spaces, loaded]);
}

/** Just the owner flag, for surfaces that don't need spaces. */
export function useIsOwner(): boolean {
  return useAppSelector((s) => s.data.actor_is_owner === true);
}

/** May approve or reject agent changes in the inbox (backend spine/authority.ts
 *  reviewAuthority: the owner only). Missing
 *  (an older server or cache) reads as no. */
export function useCanReview(): boolean {
  return useAppSelector((s) => s.data.can_review === true);
}
