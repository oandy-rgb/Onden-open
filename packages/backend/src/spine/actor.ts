import type { ActorCtx } from "../types.js";

/** Missing or no-longer-valid authenticated identity. Maps to HTTP 401. */
export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export function requireActor(actor: ActorCtx | null | undefined): ActorCtx {
  if (!actor) throw new UnauthorizedError();
  return actor;
}
