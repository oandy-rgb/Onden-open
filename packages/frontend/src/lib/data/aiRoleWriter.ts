import type { SetUpAiRequest, SetUpAiResult } from "@onden/contract";
import { sendWrite } from "./onlineWrite";

// What the owner does to an AI helper: make it, connect it to a key or a connection code, set how its suggestions are
// reviewed, let it answer to an @name, take it away. Online only (the server decides; nothing is queued). A retry of the
// same form passes the same `idemKey`, so a lost reply cannot make two. Callers report failures through writeErrors.
type RuntimeBody = { default_runtime: string; api?: Record<string, unknown> };

export const aiRoleWriter = {
  /** Make an AI with its connection in one step. A replay answers `{ deduped: true }` only. */
  create: (request: SetUpAiRequest, idemKey: string) => sendWrite<SetUpAiResult | { deduped: true }>("POST", "/api/ai/roles", request, idemKey),
  rename: (actorId: string, name: string) => sendWrite("PATCH", `/api/actors/${actorId}`, { name }),
  /** Remove the AI (or any member): its keys stop and it leaves every space. */
  remove: (actorId: string) => sendWrite("DELETE", `/api/actors/${actorId}`),
  setReviewRule: (actorId: string, reviewRule: "suggest" | "apply") => sendWrite("PATCH", `/api/ai/roles/${actorId}`, { review_rule: reviewRule }),
  /** Run on the owner's own client with a connection code. */
  useConnectionCode: (actorId: string) => sendWrite("PATCH", `/api/ai/roles/${actorId}`, { default_runtime: "mcp" }),
  /** Run on a kept key (`api`) or on a connection code (`mcp`). */
  setRuntime: (actorId: string, body: RuntimeBody) => sendWrite("PUT", `/api/ai/roles/${actorId}/runtime`, body),
  saveKey: (fields: Record<string, unknown>, idemKey: string) =>
    sendWrite<{ credential?: { id: string } } | { deduped: true }>("POST", "/api/ai/credentials", fields, idemKey),
  deleteKey: (keyId: string) => sendWrite("DELETE", `/api/ai/credentials/${keyId}`),
  /** A connection code (or a key for the owner's own client); the plaintext is in the answer, once. */
  mintCode: (actorId: string, input: { name: string; access: "read" | "write" }, idemKey?: string) =>
    sendWrite<{ token?: string } | { deduped: true }>("POST", `/api/actors/${actorId}/tokens`, input, idemKey),
  revokeCode: (actorId: string, codeId: string) => sendWrite("POST", `/api/actors/${actorId}/tokens/${codeId}/revoke`, "{}"),
  setMentionName: (actorId: string, handle: string) => sendWrite("PUT", `/api/agent-sessions/runners/${actorId}`, { handle }),
  setMentionEnabled: (actorId: string, enabled: boolean) => sendWrite("POST", `/api/agent-sessions/runners/${actorId}/enabled`, { enabled }),
};
