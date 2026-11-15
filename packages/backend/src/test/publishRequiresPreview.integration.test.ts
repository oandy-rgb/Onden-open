// POST /api/publish takes only a hash from POST /api/publish/preview. Under the by-space rule a publish puts every note of
// a publishing space on the site, so the owner's own session, called directly, must not skip the list the app shows first.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import publishRouter from "../modules/website/routes.js";
import { persistActor } from "./helpers/persistActor.js";
import { postVia, publishWithPreview } from "./helpers/publishWithPreview.js";
import type { ActorCtx } from "../types.js";

let ws: string;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
let owner: ActorCtx = { id: "rp-owner", name: "Owner", role: "admin", type: "human" };

const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", owner); await next(); });
app.route("/api", publishRouter);
const post = postVia(app);
const snapshots = async () => (await db.q(`SELECT 1 FROM publish_snapshots WHERE workspace_id = $1`, [ws])).rowCount ?? 0;

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("a publish needs the preview's hash", () => {
  beforeEach(async () => {
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Publish needs preview',$1) RETURNING id", [randomUUID()])).rows[0].id;
    owner = await persistActor(ws, { ...owner, id: "rp-owner" });
  });

  it("without a hash it is refused (400) and nothing is published, whatever else the body holds", async () => {
    for (const body of [{}, { title: "Site" }, { title: "Site", preview_hash: undefined }, { title: "Site", preview_hash: "" }, { title: "Site", preview_hash: "not-a-hash" }]) {
      const res = await post("/api/publish", body as Record<string, unknown>);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await snapshots()).toBe(0);
  });

  it("a hash that is not this candidate's is stale (409) and publishes nothing", async () => {
    expect((await post("/api/publish", { title: "Site", preview_hash: "0".repeat(64) })).status).toBe(409);
    expect(await snapshots()).toBe(0);
  });

  it("the control: previewed first, the same publish goes out (201)", async () => {
    expect((await publishWithPreview(post, { title: "Site" })).status).toBe(201);
    expect(await snapshots()).toBe(1);
  });
});
