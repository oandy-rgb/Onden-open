// The agent-tool HTTP route answers errors through httpError.ts toolOnError
// (W9): machine codes in `error` for its clients (authority reason, scope
// code, invalid_args, rate_limited), the shared boundary for the rest — and
// that still holds once the router is mounted inside an app whose own
// onError is apiOnError. (The tool is a plain function, not a vi.fn: vitest
// reports an error a spy throws even when the route handles it.)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { z } from "zod";

let toolError: Error | null = null;
vi.mock("../services/agentTools/registry.js", () => ({
  listTools: () => [],
  getTool: () => ({ name: "probe" }),
  callTool: async () => { if (toolError) throw toolError; return null; },
}));
vi.mock("../db.js", async (load) => ({ ...(await load<typeof import("../db.js")>()), getWorkspaceId: async () => "ws" }));

const { apiOnError } = await import("../httpError.js");
const { default: mcpRouter } = await import("../routes/mcp.js");
const { AuthorityError } = await import("../spine/mutate.js");
const { ScopeError } = await import("../spine/toolScope.js");
const { RateLimitError } = await import("../services/agentTools/rateLimit.js");
const { ModuleNotImportedError } = await import("../services/workspaceModules.js");

const app = new Hono<{ Variables: { actor: unknown } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", { id: "a", name: "Bot", role: "editor", type: "agent" }); await next(); });
app.route("/api/mcp", mcpRouter);

const call = async () => {
  const res = await app.request("/api/mcp/tools/probe", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  return { status: res.status, body: await res.json() as Record<string, unknown>, retryAfter: res.headers.get("Retry-After") };
};

const fail = (make: () => Error) => { toolError = make(); };

describe("agent-tool route errors", () => {
  beforeEach(() => { toolError = null; });

  it("an authority denial carries its reason code", async () => {
    fail(() => new AuthorityError("tag_not_allowed", "not in this token's scope"));
    expect(await call()).toMatchObject({ status: 403, body: { error: "tag_not_allowed", detail: "not in this token's scope" } });
  });

  it("a scope denial carries its code", async () => {
    fail(() => new ScopeError("tool_not_allowed", "no"));
    expect(await call()).toMatchObject({ status: 403, body: { error: "tool_not_allowed" } });
  });

  it("bad arguments read as invalid_args", async () => {
    // A real parse failure (zod v4's bare `new ZodError()` is not an Error).
    fail(() => z.object({ id: z.string() }).safeParse({}).error!);
    expect(await call()).toMatchObject({ status: 400, body: { error: "invalid_args" } });
  });

  it("the meter answers 429 with Retry-After", async () => {
    fail(() => new RateLimitError(7, "slow down"));
    expect(await call()).toMatchObject({ status: 429, retryAfter: "7", body: { error: "rate_limited", retry_after_seconds: 7 } });
  });

  it("anything else is the shared boundary's (a module not imported → 409, unknown → 500)", async () => {
    fail(() => new ModuleNotImportedError("review"));
    expect(await call()).toMatchObject({ status: 409, body: { module: "review" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    fail(() => new Error("db exploded: secret detail"));
    expect(await call()).toEqual({ status: 500, body: { error: "internal" }, retryAfter: null });
  });
});
