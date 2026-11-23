import { z } from "zod";
import { ScopeError } from "../../spine/toolScope.js";
import { AuthorityError } from "../../spine/mutate.js";
import { ScopeUnavailable, InvalidSkillRequest } from "../harness/index.js";
import { log } from "../../logger.js";
import { RateLimitError } from "./rateLimit.js";

/** What an MCP client may read of a failure. The SDK sends a callback's
 *  Error.message to the client verbatim, which for a database error can carry
 *  a value from a row the agent cannot read. Refusals written for the caller
 *  (scope, authority, bad arguments, the meter, and domain errors that carry a
 *  4xx status) keep their message; anything unexpected becomes a generic one
 *  and is logged here instead. */
export function mcpSafeError(err: unknown): Error {
  const status = (err as { status?: unknown } | null)?.status;
  if (
    err instanceof ScopeError || err instanceof AuthorityError || err instanceof z.ZodError
    || err instanceof RateLimitError || err instanceof ScopeUnavailable || err instanceof InvalidSkillRequest
    || (err instanceof Error && typeof status === "number" && status >= 400 && status < 500)
  ) return err instanceof Error ? err : new Error(String(err));
  log.error("agent-tools", "protocol callback failed", { err });
  return new Error("Something went wrong on the server. Try again later.");
}

