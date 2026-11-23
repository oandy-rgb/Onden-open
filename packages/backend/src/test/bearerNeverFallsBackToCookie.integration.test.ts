// A request that presents `Authorization: Bearer …` is authenticated by that bearer or refused (401): never by the sign-in
// cookie that may ride along, and the origin guard (CSRF) is skipped only for a bearer that actually resolved (app.ts).
// Before, any bearer header skipped the origin guard and an unknown bearer fell back to the cookie, so a cross-site write
// carrying the person's cookie was stopped only by the browser's CORS preflight.
// Real better-auth cookies, a real agent token and the assembled app; isolated *_test database only.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as db from "../db.js";
import { SERVER_PROTOCOL_HEADER } from "@onden/markdown";
import { createToken } from "../services/agentTokens.js";
import { deleteWorkspaceActors, setWorkspaceOwner } from "./helpers/setOwner.js";

let ws: string;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
const { auth } = await import("../auth.js");
const { app } = await import("../app.js");

const FOREIGN = "https://evil.example";
const PREF = "/api/me/prefs/nav";

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("a bearer is the credential, or the request is refused", () => {
  let cookie = "";
  let agentToken = "";

  beforeAll(async () => {
    await (await auth.$context).runMigrations();
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Bearer or cookie',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    const email = `${randomUUID()}@bearer-cookie.test`, password = `Test-${randomUUID()}!`;
    const up = await auth.api.signUpEmail({ body: { name: "Owner", email, password } });
    const ownerId = (await db.q<{ id: string }>("INSERT INTO actors(workspace_id,name,type,external_id) VALUES($1,'Owner','human',$2) RETURNING id", [ws, up.user.id])).rows[0]!.id;
    await setWorkspaceOwner(ws, ownerId);
    const signedIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    cookie = signedIn.headers.getSetCookie().map((v) => v.split(";", 1)[0]).join("; ");
    const agentId = (await db.q<{ id: string }>("INSERT INTO actors(workspace_id,name,type) VALUES($1,'Agent','agent') RETURNING id", [ws])).rows[0]!.id;
    agentToken = (await createToken(agentId, { name: "reader", access: "read", issuedBy: ownerId })).plaintext;
  }, 30_000);

  afterAll(async () => {
    if (ws) await deleteWorkspaceActors(ws);
  });

  const send = (path: string, init: { method?: string; cookie?: boolean; authorization?: string; origin?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.cookie) headers.cookie = cookie;
    if (init.authorization) headers.authorization = init.authorization;
    if (init.origin) headers.origin = init.origin;
    return app.request(path, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  const navOf = async () => ((await (await send(PREF, { cookie: true })).json()) as { value: unknown }).value;

  it("the cookie alone signs the person in (the world is real)", async () => {
    expect((await send(PREF, { cookie: true })).status).toBe(200);
  });

  it("an unknown bearer with a valid cookie is refused, for a read and for a write — even from a foreign page", async () => {
    const before = await navOf();
    for (const bearer of [`ondt_${"A".repeat(43)}`, `onds_${"A".repeat(43)}`, "not-a-token"]) {
      const authorization = `Bearer ${bearer}`;
      expect((await send(PREF, { cookie: true, authorization })).status).toBe(401);
      const write = await send(PREF, { method: "PUT", cookie: true, authorization, origin: FOREIGN, body: { value: { order: ["tasks"], phone: 1 } } });
      expect(write.status).toBe(401);
    }
    expect(await navOf()).toEqual(before); // nothing was written as the person
  });

  it("the 401 for a bearer says the server's protocol like every other answer", async () => {
    const res = await send(PREF, { cookie: true, authorization: `Bearer ondt_${"B".repeat(43)}` });
    expect(res.status).toBe(401);
    expect(res.headers.get(SERVER_PROTOCOL_HEADER)).not.toBeNull();
    const foreign = await send(PREF, { method: "PUT", cookie: true, origin: FOREIGN, body: { value: { order: ["tasks"], phone: 1 } } });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get(SERVER_PROTOCOL_HEADER)).not.toBeNull();
  });

  it("a page's note write with a proxy's Basic header is still asked which protocol it speaks", async () => {
    // No X-Onden-Client-Protocol header: a page from before block anchors (clientGate.ts). The Basic header must not let it through.
    const res = await send("/api/nodes", { method: "POST", cookie: true, authorization: "Basic dXNlcjpwYXNz", origin: "http://localhost:4321", body: { title: "x" } });
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({ error: "client_too_old" });
  });

  it("a bearer header that does not parse is refused too, not read as no bearer", async () => {
    for (const authorization of ["Bearer", "Bearer ", "Bearer a b", "bearer\tx y"]) {
      expect((await send(PREF, { cookie: true, authorization })).status).toBe(401);
    }
  });

  it("another kind of Authorization header (a proxy's Basic) leaves the cookie as it was", async () => {
    expect((await send(PREF, { cookie: true, authorization: "Basic dXNlcjpwYXNz" })).status).toBe(200);
  });

  it("a cookie write from a foreign page without a bearer is refused by the origin guard, as before", async () => {
    const res = await send(PREF, { method: "PUT", cookie: true, origin: FOREIGN, body: { value: { order: ["tasks"], phone: 1 } } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "origin_not_allowed" });
  });

  it("a valid bearer works without an Origin, and with one: it is not a cookie request", async () => {
    const authorization = `Bearer ${agentToken}`;
    const listed = await send("/api/mcp/tools", { authorization });
    expect(listed.status).toBe(200);
    const tool = await send("/api/mcp/tools/getNode", { method: "POST", authorization, body: { id: randomUUID() } });
    expect([401, 403]).not.toContain(tool.status);
    const fromPage = await send("/api/mcp/tools/getNode", { method: "POST", authorization, origin: FOREIGN, body: { id: randomUUID() } });
    expect([401, 403]).not.toContain(fromPage.status);
  });

  it("a valid bearer with a valid cookie is the bearer's actor, never the person's", async () => {
    // The agent token is confined to /api/mcp/*: the person's own preference route answers token_scope, not the person's value.
    const res = await send(PREF, { cookie: true, authorization: `Bearer ${agentToken}` });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("token_scope");
  });
});
