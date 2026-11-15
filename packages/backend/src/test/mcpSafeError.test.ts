// What the MCP protocol channel tells an agent about a failure: refusals made
// for the caller keep their message, anything unexpected (a database error that
// quotes a row, say) is replaced by a generic sentence.

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { mcpSafeError } from "../routes/mcpProtocol.js";
import { ScopeError } from "../spine/toolScope.js";
import { AuthorityError } from "../spine/mutate.js";
import { RateLimitError } from "../services/agentTools/rateLimit.js";
import { NodeUpdateError } from "../services/nodeUpdate.js";
import { InvalidSkillRequest } from "../services/harness/index.js";

describe("mcpSafeError", () => {
  it("keeps the message of a refusal written for the caller", () => {
    const parsed = z.object({ id: z.string() }).safeParse({}).error!;
    for (const err of [
      new ScopeError("tool_not_allowed", "Token t does not allow tool 'x'"),
      new AuthorityError("tag_not_allowed", "not in this token's scope"),
      new RateLimitError(5, "Rate limit exceeded"),
      new NodeUpdateError("node not found", 404),
      new InvalidSkillRequest("outline needs node_ids"),
    ]) expect(mcpSafeError(err).message).toBe(err.message);
    expect(mcpSafeError(parsed)).toBe(parsed);
  });

  it("replaces an unexpected error with a generic message", () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint "slug"\nKey (slug)=(secret-plan) already exists.'), { code: "23505" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const safe = mcpSafeError(err);
    spy.mockRestore();
    expect(safe.message).not.toContain("secret-plan");
    expect(safe.message).toMatch(/something went wrong/i);
  });

  it("does not treat a 5xx status as a caller-facing refusal", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const safe = mcpSafeError(Object.assign(new Error("upstream said: secret"), { status: 502 }));
    spy.mockRestore();
    expect(safe.message).not.toContain("secret");
  });
});
