// The one log line for a request refused because its actor (or token, or temporary session) vanished after it signed in
// (httpError.ts logActorGone; PR #1875, the security review's condition 2). The answer itself is unchanged: 401 `{ error: "unauthorized" }`,
// the same as a credential that never existed. The line says which token or session and which route, and never the token, the actor's id,
// the arguments or the query string. Requests that never signed in, and other 401s (requireActor, account_changed), write no line.
// The same line on the real race (two connections, the real app) is asserted in removedActorCredentialConcurrent.integration.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { ActorGoneError, UnauthorizedError } from "../spine/actor.js";
import type { ActorCtx } from "../types.js";

const TOKEN_ID = "6a0f2b4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
const ACTOR_ID = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const PLAINTEXT = "ondt_secretsecretsecretsecretsecret";
const agent: ActorCtx = {
  id: ACTOR_ID, name: "bot", type: "agent",
  tokenScope: { tokenId: TOKEN_ID, allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
};

function appWith(actor: ActorCtx | null, thrown: Error): Hono<{ Variables: { actor: ActorCtx | null } }> {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.post("/api/mcp/tools/:name", () => { throw thrown; });
  return app;
}
const call = (app: Hono<{ Variables: { actor: ActorCtx | null } }>) => app.request("/api/mcp/tools/updateNode?probe=query-text", {
  method: "POST", headers: { authorization: `Bearer ${PLAINTEXT}`, "content-type": "application/json" },
  body: JSON.stringify({ args: { id: "note", title: "argument-text" } }),
});

describe("a request whose actor is gone since it signed in", () => {
  let lines: string[] = [];
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  beforeEach(() => {
    lines = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      spies.push(vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }));
    }
  });
  afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

  it("is answered like a credential that never existed, and writes one line with the token id, the route and 401 — never the token", async () => {
    const res = await call(appWith(agent, new ActorGoneError()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });

    expect(lines).toHaveLength(1);
    const [line] = lines as [string];
    expect(line).toContain("[auth]");
    expect(line).toContain(TOKEN_ID);
    expect(line).toContain("/api/mcp/tools/updateNode");
    expect(line).toContain("401");
    for (const secret of [PLAINTEXT, "ondt_", ACTOR_ID, "argument-text", "query-text", "Bearer"]) expect(line).not.toContain(secret);
  });

  it("writes nothing for a request that never signed in, nor for another 401", async () => {
    expect((await call(appWith(null, new ActorGoneError()))).status).toBe(401);
    expect((await call(appWith(agent, new UnauthorizedError()))).status).toBe(401);
    expect((await call(appWith(agent, new UnauthorizedError("account_changed")))).status).toBe(401);
    expect(lines).toEqual([]);
  });
});
