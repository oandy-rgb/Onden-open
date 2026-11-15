// What the 「交給 AI」 menu on a note offers this person: the roles that can take a
// selection or a paragraph here, each with the ways it can run right now.
//
//   handToAiOptions(ws, nodeId, { actor })
//     → { canHandOff, roles: [{ actorId, handle, name, defaultRuntime, runtimes: [{ kind, available }], reason }] }
//
// Who may start is the same as an @mention (mentionablesFor: role on, in the note's
// space, the person's own); an api option exists only where the server can keep keys.
// A person who cannot edit the note gets none (the suggestion would be refused).
import type { ActorCtx } from "../types.js";
import { assertAuthority, AuthorityError } from "../spine/authority.js";
import { loadRunner, mentionablesFor } from "./agentSessions.js";
import { runtimeAvailability, type RuntimeKind } from "./agentRuntime/index.js";

export type HandToAiRole = {
  actor_id: string; handle: string; name: string;
  default_runtime: RuntimeKind;
  runtimes: Array<{ kind: RuntimeKind; available: boolean; unavailable_reason: string | null }>;
  /** Why this role cannot be used now (null: it can). */
  reason: "disabled" | "agent_cannot_write" | "not_agents_owner" | null;
  /** The role's way of running for this once, unless the person picks another. */
  model_name: string | null;
};

export async function handToAiOptions(workspaceId: string, nodeId: string, { actor }: { actor: ActorCtx }): Promise<{ can_hand_off: boolean; roles: HandToAiRole[] }> {
  const { agents } = await mentionablesFor(workspaceId, nodeId, { actor }); // 404 for a note they cannot read
  try {
    await assertAuthority(actor, { kind: "node", nodeId, op: "write_node" });
  } catch (error) {
    if (error instanceof AuthorityError) return { can_hand_off: false, roles: [] };
    throw error;
  }
  return { can_hand_off: true, roles: await handToAiRoles(workspaceId, agents) };
}

/** The roles of a note's space with the ways each can run now (shared with the info panel's AI chat). */
export async function handToAiRoles(
  workspaceId: string, agents: Array<{ actor_id: string; handle: string; name: string; reason: HandToAiRole["reason"] }>,
): Promise<HandToAiRole[]> {
  const roles: HandToAiRole[] = [];
  for (const agent of agents) {
    const role = (await loadRunner(workspaceId, { actorId: agent.actor_id }))!;
    const runtimes = (await runtimeAvailability(role)).map((r) => ({ kind: r.kind, available: r.ok, unavailable_reason: r.ok ? null : r.reason }));
    roles.push({
      actor_id: agent.actor_id, handle: agent.handle, name: agent.name, default_runtime: role.default_runtime, runtimes,
      reason: agent.reason, model_name: role.api_model,
    });
  }
  return roles;
}
