// The api runtime: the server calls the model with the owner's own API key
// (decision 2026-10-30; proposal §4.2) through any service that speaks one of the formats in
// protocols/ — the only folder that names a provider or a wire format
// (test/guards/aiVendorNames.guard.test.ts). No model SDK is imported anywhere (test/harnessBoundary.test.ts).
//
// It shares with MCP: the tool registry and callTool, the grants and rate budget,
// the audit events, the spine's mutate() and its authority checks, the session
// log, and harness.prompt() as the ONLY way note text reaches the model. What is
// different: it can only propose changes (write mode 'suggest', fixed by the
// database and enforced by the spine), it has no default model, and it is absent
// unless the server holds ONDEN_SECRET_KEY and the role has a live key.
import { enqueueEffect, registerOutboxEffect, requireString } from "../../outbox.js";
import type { AgentRuntime } from "../types.js";
import { apiAvailability } from "./limits.js";
import { startApiRun } from "./run.js";

export const API_RUN_EFFECT = "agent_session_run";

// perform() only claims the session and starts the run, so the drain is never held
// by a model call. Claiming is one guarded UPDATE: a retry or a second drain finds
// the session no longer queued and does nothing (no second paid run).
registerOutboxEffect({
  kind: API_RUN_EFFECT,
  parse: (payload) => ({ sessionId: requireString(payload, "session_id") }),
  perform: async ({ sessionId }) => startApiRun(sessionId),
});

export const apiRuntime: AgentRuntime = {
  kind: "api",
  availability: apiAvailability,
  async dispatch(session) {
    await enqueueEffect({
      workspaceId: session.workspace_id, kind: API_RUN_EFFECT,
      dedupKey: `${API_RUN_EFFECT}:${session.id}`, payload: { session_id: session.id },
      triggeredByEventId: session.root_event_id ?? undefined,
    });
  },
};

export { failInterruptedApiSessions } from "./run.js";
export { listModels, listModelsWithFormat } from "./models.js";
export type { ApiModel } from "./models.js";
