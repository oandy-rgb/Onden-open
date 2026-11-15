// Tool scope of a bearer token: which agent tools a token may call, and the
// error every layer uses to refuse a token. Kept as a dependency-free leaf so
// the spine, currentActor and importers can use it without loading the tool
// registry (services/agentTools/, which itself depends on the spine).
//
//   tokenScope === undefined            → not gated (session / native / no bearer)
//   tokenScope.allowedTools  === null   → unrestricted tool surface
//   tokenScope.allowedTools  === []     → no tools allowed (lockdown)
//
// WHAT a token may read or write is decided by spaces (spine/spaceScope.ts).

import { createContextSlot } from "../requestContext.js";
import type { ActorCtx } from "../types.js";

/** Distinguishes scope rejection (403) from generic tool errors (500).
 *  Day 3 read-only tools only throw `tool_not_allowed`. Day 4+ write tools
 *  add `tag_not_allowed` when the target node carries no token-allowed tag. */
export class ScopeError extends Error {
  constructor(
    public code:
      | "tool_not_allowed"
      | "tag_not_allowed"
      | "token_expired"
      | "token_revoked"
      | "suggest_only",
    message: string,
  ) {
    super(message);
    this.name = "ScopeError";
  }
}

/** May `actor` call `toolName`? The rule above; assertToolAllowed throws. */
export function isToolAllowed(actor: ActorCtx, toolName: string): boolean {
  const allowed = actor.tokenScope?.allowedTools;
  return allowed == null || allowed.includes(toolName);
}

export function assertToolAllowed(actor: ActorCtx, toolName: string): void {
  if (!isToolAllowed(actor, toolName)) {
    throw new ScopeError(
      "tool_not_allowed",
      `Token ${actor.tokenScope?.tokenId} does not allow tool '${toolName}'`,
    );
  }
}

/** Events an agent in `suggest` mode may still write through mutate(): filing
 *  its own suggestion. Everything else (a note, tag or edge change) is refused
 *  there, whichever tool or runtime asked: the suggest rule does not depend on
 *  the tool list a client was shown. */
const SUGGEST_MODE_EVENTS: readonly string[] = ["AI_SUGGESTION_CREATED"];

/** Throws unless `actor` may write an event of `eventType`: an agent whose
 *  token is in suggest mode may only file suggestions. Others: no restriction here. */
export function assertWriteModeAllows(actor: ActorCtx, eventType: string): void {
  if (actor.type !== "agent" || actor.tokenScope?.writeMode !== "suggest") return;
  if (SUGGEST_MODE_EVENTS.includes(eventType)) return;
  throw new ScopeError(
    "suggest_only",
    `Agent ${actor.id} saves its edits as suggestions; it cannot write '${eventType}' directly. Propose text with updateNode or suggestEdit, or say what you cannot do with commentOnNote.`,
  );
}

const invocation = createContextSlot<readonly string[]>();

/** Registry-owned invocation identity, preserved across awaits while a tool
 * waits for a write transaction. The name comes from the registered tool,
 * never from the handler's arguments. Nested calls retain their outer gates.
 * This establishes context only; current authority is checked after reload. */
export function withToolAuthority<T>(toolName: string, body: () => Promise<T>): Promise<T> {
  return invocation.run([...(invocation.getStore() ?? []), toolName], body);
}

/** Check a freshly loaded actor/token against the active tool invocation.
 * Call inside the same locked transaction as its write. With no tool context
 * (ordinary session operations), this adds no tool-specific restriction. */
export function assertCurrentToolAllowed(actor: ActorCtx): void {
  for (const toolName of invocation.getStore() ?? []) assertToolAllowed(actor, toolName);
}
