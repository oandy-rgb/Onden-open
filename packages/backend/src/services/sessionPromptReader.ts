// Who may read the text a person typed to start an AI run (agent_sessions.prompt).
// The prompt can quote notes the run's other readers cannot see, so it goes only
// to the person who started the run and to the workspace owner; everyone else who
// can see the run (History's run card, an agent's memory of its sessions) gets the
// run without it — an empty string, no placeholder that hints at its content.
// An agent reads on behalf of the person its token was issued to (a session token:
// the sender; a resident token: whoever issued it), so it cannot carry one
// person's prompt to another.
import { isWorkspaceOwner } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";

type PromptReader = { personId: string | null; owner: boolean };

export async function promptReaderOf(actor: ActorCtx): Promise<PromptReader> {
  const personId = actor.tokenScope ? actor.tokenScope.issuedBy ?? null : actor.id;
  const owner = personId ? await isWorkspaceOwner({ id: personId, name: "", type: "human" }) : false;
  return { personId, owner };
}

/** `prompt` as `reader` may see it: the text for the run's sender and the owner, "" for anyone else. */
export function promptFor(reader: PromptReader, initiatorId: string, prompt: string): string {
  return reader.owner || (reader.personId !== null && reader.personId === initiatorId) ? prompt : "";
}
