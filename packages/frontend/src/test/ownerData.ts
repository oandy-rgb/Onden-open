import { noWorkspaceData, type Bootstrap } from "../lib/api";

/** A loaded workspace seen by its owner: what a test that needs to edit,
 *  review or manage starts from. The app's own default (noWorkspaceData) has
 *  the least privilege, so a test says when it wants more. */
export const ownerData: Bootstrap = { ...noWorkspaceData, actor_role: "admin", actor_is_owner: true, can_review: true };
