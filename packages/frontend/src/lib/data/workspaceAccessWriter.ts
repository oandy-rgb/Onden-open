import { sendWrite } from "./onlineWrite";

// Who may be in the workspace and who owns it. Online only; callers report failures through writeErrors.
export const workspaceAccessWriter = {
  /** Add a person (with an invite link in the answer) or an AI to the workspace. */
  addMember: (input: { name: string; type: "human" | "agent"; email?: string }) =>
    sendWrite<{ id?: string; invite_path?: string }>("POST", "/api/actors", input),
  /** A new invite link for a person; the old one stops working. */
  renewInvite: (actorId: string) => sendWrite<{ invite_path?: string }>("POST", `/api/actors/${actorId}/invite`, {}),
  claimInvite: (token: string) => sendWrite("POST", "/api/invites/claim", { token }),
  /** `confirmName`: the new owner's name as the person typed it; the server checks it. */
  transferOwnership: (toActorId: string, confirmName: string) => sendWrite("POST", "/api/workspace/owner-transfer", { to_actor_id: toActorId, confirm_name: confirmName }),
};
