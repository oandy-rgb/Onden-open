import type { ActorCtx } from "../types.js";

/** Missing or no-longer-valid authenticated identity. Maps to HTTP 401. */
export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** resolveCurrentActor found no current row for an identity that had one: the actor was removed, or its token or temporary session was
 *  revoked, expired or ended. Answered exactly like UnauthorizedError (401 `{ error: "unauthorized" }`, the answer a credential that never
 *  existed gets); its own class only so the HTTP boundary can tell a request whose actor vanished AFTER it signed in — the one case
 *  httpError.ts logs — from one that never signed in. */
export class ActorGoneError extends UnauthorizedError {}

export function requireActor(actor: ActorCtx | null | undefined): ActorCtx {
  if (!actor) throw new UnauthorizedError();
  return actor;
}
