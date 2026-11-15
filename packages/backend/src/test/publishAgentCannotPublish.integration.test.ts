// Nothing publishes the site except the owner's own POST /api/publish, and the owner's screen always sends the hash
// of the preview it showed (usePublishReview.ts, introSite.ts). The agent's `publishSite` tool and its held
// effect are gone (migration 155), and a delegated token is refused here whatever its role or scope, so an agent
// cannot get a whole space put on the site by an approval that never showed what would go out.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import publishRouter from "../modules/website/routes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

describe.skipIf(!isTestDatabase())("an agent cannot publish the site", () => {
  it("a bearer token is refused POST /publish and the preview, even for the owner's own token", async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('No agent publish', $1) RETURNING id::text`, [`no-agent-publish-${randomUUID()}`])).rows[0]!.id;
    const owner = await persistActor(WS, { id: "", name: "Owner", type: "human", role: "admin" });
    await setWorkspaceOwner(WS, owner.id);
    const token: ActorCtx = { ...owner, tokenScope: { tokenId: "t", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null } };
    const app = new Hono<{ Variables: { actor: ActorCtx } }>();
    app.onError(apiOnError);
    app.use("*", async (c, next) => { c.set("actor", token); await next(); });
    app.route("/api", publishRouter);
    for (const path of ["/api/publish", "/api/publish/preview"]) {
      const res = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Site" }) });
      expect([401, 403], path).toContain(res.status);
    }
    expect((await q(`SELECT 1 FROM publish_snapshots WHERE workspace_id = $1`, [WS])).rowCount).toBe(0);
  });
});
