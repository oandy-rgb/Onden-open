// The version policy on the real sync routes: a client below the oldest accepted protocol gets 426 `client_too_old`
// for sync and writes, the same protocol is served exactly as before, a request with no header (a token, a script) is
// not asked, and every answer says which protocol the server speaks.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER, SERVER_PROTOCOL_HEADER } from "@onden/markdown";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import syncRouter from "../routes/sync.js";
import nodesRouter from "../routes/nodes.js";
import { clientProtocolGate, serverProtocolHeader } from "../clientGate.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import type { ActorCtx } from "../types.js";

let ws: string;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));

let actor: ActorCtx;
function appFor(actorCtx: ActorCtx) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", serverProtocolHeader());
  app.use("*", async (c, next) => { c.set("actor", actorCtx); await next(); });
  app.use("*", clientProtocolGate());
  app.route("/api/sync", syncRouter);
  app.route("/api/nodes", nodesRouter);
  return app;
}
const tooOld = { [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL - 1) };
const current = { [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL) };
const page = { origin: "https://app.example" };

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("sync protocol version on the real routes", () => {
  beforeAll(async () => {
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Protocol version',$1) RETURNING id", [randomUUID()])).rows[0].id;
    const row = await db.q<ActorCtx>(`INSERT INTO actors(workspace_id,name,type,external_id) VALUES($1,'Reader','human',$2) RETURNING id,name,type`, [ws, randomUUID()]);
    actor = row.rows[0];
    await joinDefaultSpace(ws, actor.id, "admin");
    await setWorkspaceOwner(ws, actor.id);
  });

  it("refuses a too-old client's sync (delta, membership) and its writes with 426, and says which protocol the server speaks", async () => {
    const app = appFor(actor);
    const responses = [
      await app.request("/api/sync?since=0", { headers: tooOld }),
      await app.request("/api/sync/membership", { headers: tooOld }),
      await app.request("/api/sync", { method: "POST", headers: { ...tooOld, ...page, "content-type": "application/json" }, body: JSON.stringify({ since: 0, known: [] }) }),
      await app.request(`/api/nodes/${randomUUID()}`, { method: "PATCH", headers: { ...tooOld, ...page, "content-type": "application/json" }, body: JSON.stringify({ markdown: "typed" }) }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(426);
      expect(await res.json()).toEqual({ error: "client_too_old" });
      expect(res.headers.get(SERVER_PROTOCOL_HEADER)).toBe(String(CLIENT_PROTOCOL));
    }
  });

  it("refuses a newer client's sync too: server_too_old, never served a shape it does not know", async () => {
    const res = await appFor(actor).request("/api/sync?since=0", { headers: { [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL + 1) } });
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({ error: "server_too_old" });
  });

  it("serves the same protocol as before", async () => {
    const app = appFor(actor);
    for (const headers of [current, { ...current, ...page }]) {
      const delta = await app.request("/api/sync?since=0", { headers });
      expect(delta.status).toBe(200);
      expect(delta.headers.get(SERVER_PROTOCOL_HEADER)).toBe(String(CLIENT_PROTOCOL));
      expect((await app.request("/api/sync/membership", { headers })).status).toBe(200);
    }
  });

  it("does not ask a request with no protocol header (a token, a script)", async () => {
    const app = appFor(actor);
    expect((await app.request("/api/sync?since=0")).status).toBe(200);
    expect((await app.request("/api/sync/membership", { headers: { authorization: "Bearer t" } })).status).toBe(200);
  });
});
