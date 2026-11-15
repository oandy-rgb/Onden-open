// The minimum-client gate of the block-anchor switch-over (clientGate.ts): a page that does not say it knows block
// anchors may not write notes; reads, tokens and other routes are untouched.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER, SERVER_PROTOCOL_HEADER, SYNC_PATH_PREFIXES, isSyncPath } from "@onden/markdown";
import { clientProtocolGate, serverProtocolHeader } from "../clientGate.js";
import type { ActorCtx } from "../types.js";

const person: ActorCtx = { id: "p", name: "P", role: "admin", type: "human" };
function appFor(actor: ActorCtx | null) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.use("*", serverProtocolHeader());
  app.use("*", clientProtocolGate());
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}
const write = (app: ReturnType<typeof appFor>, path: string, headers: HeadersInit = {}) =>
  app.request(path, { method: "PATCH", headers: { origin: "https://app.example", ...(headers as Record<string, string>) }, body: "{}" });

describe("client protocol gate", () => {
  it("refuses a page without the header, and one with an older protocol", async () => {
    const app = appFor(person);
    for (const headers of [{} as Record<string, string>, { [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL - 1) }, { [CLIENT_PROTOCOL_HEADER]: "x" }]) {
      const res = await write(app, "/api/nodes/abc", headers);
      expect(res.status).toBe(426);
      expect(await res.json()).toEqual({ error: "client_too_old" });
    }
    expect((await write(app, "/api/sync/push")).status).toBe(426);
  });
  it("lets a current page write, and never stops a read", async () => {
    const app = appFor(person);
    expect((await write(app, "/api/nodes/abc", { [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL) })).status).toBe(200);
    expect((await app.request("/api/nodes/abc")).status).toBe(200);
  });
  it("does not ask routes that carry no note text, tokens, or no actor", async () => {
    expect((await write(appFor(person), "/api/me/prefs")).status).toBe(200);
    expect((await write(appFor(person), "/api/nodes/abc", { authorization: "Bearer t" })).status).toBe(200);
    expect((await write(appFor(null), "/api/nodes/abc")).status).toBe(200);
    // A script or curl sends no Origin: not a page.
    expect((await appFor(person).request("/api/nodes/abc", { method: "PATCH", body: "{}" })).status).toBe(200);
  });

  describe("one policy for every request that sends the protocol header", () => {
    const tooOld = { [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL - 1) };
    const current = { [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL) };
    const get = (app: ReturnType<typeof appFor>, path: string, headers: Record<string, string>) => app.request(path, { headers });

    it("refuses a too-old client's sync reads and its writes anywhere, but not its other reads", async () => {
      const app = appFor(person);
      for (const path of ["/api/sync", "/api/sync/membership", "/api/bootstrap"]) {
        const res = await get(app, path, tooOld);
        expect(res.status, path).toBe(426);
        expect(await res.json()).toEqual({ error: "client_too_old" });
      }
      expect((await write(app, "/api/me/prefs", tooOld)).status).toBe(426);
      expect((await write(app, "/api/tags/x", tooOld)).status).toBe(426);
      expect((await get(app, "/api/nodes/abc", tooOld)).status).toBe(200);
      expect((await get(app, "/api/me", tooOld)).status).toBe(200);
    });

    it("refuses every sync request of a too-old client whatever its method, from the one shared list", async () => {
      const app = appFor(person);
      for (const path of ["/api/sync/bodies", "/api/sync/drawings", "/api/sync/nodes", "/api/sync/membership/digest"]) {
        expect((await app.request(path, { method: "POST", headers: tooOld, body: "{}" })).status, path).toBe(426);
        expect((await get(app, path, tooOld)).status, path).toBe(426);
      }
      expect(SYNC_PATH_PREFIXES).toEqual(["/api/sync", "/api/bootstrap"]);
      expect(isSyncPath("/api/sync/bodies")).toBe(true);
      expect(isSyncPath("/api/syncing")).toBe(false);
      expect(isSyncPath("/api/bootstrap?bodies=none")).toBe(true);
    });

    it("takes a blank header for no header: a browser session's note write is still refused", async () => {
      const app = appFor(person);
      for (const blank of ["", "  "]) {
        const res = await write(app, "/api/nodes/abc", { [CLIENT_PROTOCOL_HEADER]: blank });
        expect(res.status).toBe(426);
      }
      expect((await write(app, "/api/me/prefs", { [CLIENT_PROTOCOL_HEADER]: "" })).status).toBe(200);
      expect((await app.request("/api/nodes/abc", { method: "PATCH", headers: { [CLIENT_PROTOCOL_HEADER]: "" }, body: "{}" })).status).toBe(200);
    });

    it("applies to a token that sends the header, and to a client with no actor yet", async () => {
      expect((await write(appFor(person), "/api/nodes/abc", { ...tooOld, authorization: "Bearer t" })).status).toBe(426);
      expect((await get(appFor(null), "/api/sync", tooOld)).status).toBe(426);
    });

    it("refuses a NEWER client the same way, saying the server is the one to update: the protocols must be equal", async () => {
      const app = appFor(person);
      const newer = { [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL + 1) };
      for (const res of [await get(app, "/api/sync", newer), await get(app, "/api/bootstrap", newer), await write(app, "/api/me/prefs", newer), await app.request("/api/sync/bodies", { method: "POST", headers: newer, body: "{}" })]) {
        expect(res.status).toBe(426);
        expect(await res.json()).toEqual({ error: "server_too_old" });
        expect(res.headers.get(SERVER_PROTOCOL_HEADER)).toBe(String(CLIENT_PROTOCOL));
      }
      expect((await get(app, "/api/me", newer)).status).toBe(200);
    });

    it("changes nothing at the same version", async () => {
      const app = appFor(person);
      for (const path of ["/api/sync", "/api/sync/membership", "/api/bootstrap"]) expect((await get(app, path, current)).status).toBe(200);
      expect((await write(app, "/api/me/prefs", current)).status).toBe(200);
      expect((await write(app, "/api/sync/push", current)).status).toBe(200);
    });

    it("does not ask a request with no header: tokens, scripts, health checks", async () => {
      const app = appFor(person);
      expect((await get(app, "/api/sync", {})).status).toBe(200);
      expect((await get(app, "/api/bootstrap", { authorization: "Bearer t" })).status).toBe(200);
      expect((await app.request("/api/tags/x", { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" })).status).toBe(200);
      expect((await get(app, "/health", {})).status).toBe(200);
    });

    it("says the server's protocol on every response, a refusal included", async () => {
      const app = appFor(person);
      expect((await get(app, "/api/me", {})).headers.get(SERVER_PROTOCOL_HEADER)).toBe(String(CLIENT_PROTOCOL));
      const refused = await get(app, "/api/sync", tooOld);
      expect(refused.status).toBe(426);
      expect(refused.headers.get(SERVER_PROTOCOL_HEADER)).toBe(String(CLIENT_PROTOCOL));
    });
  });
});
