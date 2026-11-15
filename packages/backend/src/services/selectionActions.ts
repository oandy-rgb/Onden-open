// A small AI action on selected text, started by a person (proposal §4.2, §5.1).
// The result is always ONE pending suggestion that replaces the selected text:
//   api   one streaming call on the server, preview while it streams
//   mcp   the session waits queued for the role's AI client, which
//         answers through the same finish() as a mention (agentSessions)
// `runtime` names the way for this one action; without it the role's default is used.
// The same request_id sent again (a retry after a lost response) is the same session.
//
//   startSelectionAction(ws, { actor, agentActorId, nodeId, skill: "shorten", text, requestId })
import { findSelection } from "@onden/markdown";
import type { ActorCtx } from "../types.js";
import { AgentSessionError, selectionError } from "./agentSessionError.js";
import type { RuntimeKind } from "./agentRuntime/index.js";
import { assertPersonMayStart, startAiSession } from "./aiSessionStart.js";
import { builtinSkill, skills as skillCatalogue } from "./harness/index.js";

export const SELECTION_MAX = 8_000;
export const INSTRUCTION_MAX = 500;

export async function startSelectionAction(
  workspaceId: string,
  input: { actor: ActorCtx; agentActorId: string; nodeId: string; skill: string; text: string; instruction?: string; requestId: string; runtime?: RuntimeKind },
): Promise<{ sessionId: string; created: boolean }> {
  const { actor } = input;
  assertPersonMayStart(actor, input.requestId);
  const text = input.text.trim();
  if (!text || text.length > SELECTION_MAX) throw new AgentSessionError("prompt_too_long", `the selection must be 1–${SELECTION_MAX} characters`, 422);
  const instruction = (input.instruction ?? "").trim();
  if (instruction.length > INSTRUCTION_MAX) throw new AgentSessionError("prompt_too_long", `the instruction is over ${INSTRUCTION_MAX} characters`, 422);

  // A built-in skill that takes text, or one of the person's own skill notes.
  const builtin = builtinSkill(input.skill);
  let skillNodeId: string | null = null;
  if (builtin) {
    if (!builtin.scopes.includes("text")) throw new AgentSessionError("skill_not_found", "that skill does not work on selected text", 422);
  } else {
    const note = (await skillCatalogue(actor, workspaceId)).find((s) => s.kind === "note" && s.id === input.skill);
    if (!note) throw new AgentSessionError("skill_not_found", "no such skill", 422);
    skillNodeId = note.id;
  }

  return startAiSession(workspaceId, {
    actor, agentActorId: input.agentActorId, nodeId: input.nodeId, requestId: input.requestId, runtime: input.runtime,
    kind: "selection_action", authorityOp: "write_node",
    // Before any model call: the answer replaces the text in ONE place, so it must be in the saved note exactly once.
    prepare: async (note) => {
      const found = findSelection(note.markdown, text);
      if (found.found !== "one") throw selectionError(found.found, "start");
    },
    row: async () => ({ prompt: text, leadIn: instruction, skillNodeId, skillRef: builtin ? builtin.id : null }),
  });
}
