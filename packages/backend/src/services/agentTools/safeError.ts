import { z } from "zod";
import { ScopeError } from "../../spine/toolScope.js";
import { AuthorityError } from "../../spine/mutate.js";
import { ScopeUnavailable, InvalidSkillRequest } from "../harness/index.js";
import { log } from "../../logger.js";
import { RateLimitError } from "./rateLimit.js";

/** A failure written for the caller — scope, authority, bad arguments, the meter, and domain errors that carry a 4xx status — as opposed
 *  to an unexpected one (a database error, a bug). */
export function isCallerFacingFailure(err: unknown): err is Error {
  const status = (err as { status?: unknown } | null)?.status;
  return err instanceof ScopeError || err instanceof AuthorityError || err instanceof z.ZodError
    || err instanceof RateLimitError || err instanceof ScopeUnavailable || err instanceof InvalidSkillRequest
    || (err instanceof Error && typeof status === "number" && status >= 400 && status < 500);
}

/** What an MCP client may read of a failure. The SDK sends a callback's
 *  Error.message to the client verbatim, which for a database error can carry
 *  a value from a row the agent cannot read. Refusals written for the caller
 *  (isCallerFacingFailure) keep their message; anything unexpected becomes a generic one
 *  and is logged here instead. */
export function mcpSafeError(err: unknown): Error {
  if (isCallerFacingFailure(err)) return err;
  log.error("agent-tools", "protocol callback failed", { err });
  return new Error("Something went wrong on the server. Try again later.");
}
