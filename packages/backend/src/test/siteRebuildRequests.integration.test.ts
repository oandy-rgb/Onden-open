// When the site is re-pushed (modules/website/index.ts, effects.ts): an ordinary edit of a note in a space that
// publishes never asks for it (the site is the latest snapshot, so a new body shows at the next Publish); hiding or
// trashing a note the site shows does, once per workspace however many changes come (one pending row, outbox.ts
// dedup_key); a note its own 「不發布」 or a feed's saved article keeps off does not.
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";
import { seedQ } from "./helpers/seedQ.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
registerShippedModules();

describe.skipIf(!isTestDatabase())("what asks the site for a re-push", () => {
  let owner: ActorCtx;
  const app = new Hono<{ Variables: { actor: ActorCtx } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", owner); await next(); });
  app.route("/api/nodes", nodesRouter);
  const send = (url: string, method: string, body: unknown = {}) =>
    app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const pending = async () => (await q<{ n: string }>(`SELECT count(*)::text AS n FROM outbox WHERE workspace_id = $1 AND effect_kind = 'site_rebuild'`, [WS])).rows[0]!.n;
  const reset = () => q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
  let site = "";

  const note = async (title: string, opts: { source?: string; flag?: string } = {}) => {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1,$2,'content',$3,$4,'words') RETURNING id::text`,
      [WS, opts.source ?? "manual", title, randomUUID()])).rows[0]!.id;
    await putInSpace(id, site);
    if (opts.flag) await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1,$2,'_published',$3,'bool')`, [WS, id, opts.flag]);
    return id;
  };

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Rebuild requests', $1) RETURNING id::text`, [`rebuild-${randomUUID()}`])).rows[0]!.id;
    owner = await persistActor(WS, { id: "owner-rebuild", name: "Owner", role: "admin", type: "human" });
    await turnModuleOn(WS, "website"); // its hooks act only where the owner has it on
    site = await makeSpace(WS, `Site ${randomUUID()}`, [{ id: owner.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
  });

  it("an edit of a note's title and text asks for nothing", async () => {
    const id = await note("Plain");
    await reset();
    expect((await send(`/api/nodes/${id}`, "PATCH", { markdown: "changed words" })).status).toBe(200);
    expect((await send(`/api/nodes/${id}`, "PATCH", { title: "Plain renamed" })).status).toBe(200);
    expect(await pending()).toBe("0");
  });

  it("trashing notes the site shows asks once, however many", async () => {
    const [a, b] = [await note("A"), await note("B")];
    await reset();
    expect((await send(`/api/nodes/${a}`, "DELETE")).status).toBe(200);
    expect((await send(`/api/nodes/${b}`, "DELETE")).status).toBe(200);
    expect(await pending()).toBe("1");
  });

  it("trashing a note kept off by its own 「不發布」 or by its source asks for nothing; one marked 「發布」 does", async () => {
    const keptOff = await note("Kept off", { flag: "false" });
    const article = await note("Saved article", { source: "rss" });
    const articleOn = await note("Article on", { source: "rss", flag: "true" });
    await reset();
    expect((await send(`/api/nodes/${keptOff}`, "DELETE")).status).toBe(200);
    expect((await send(`/api/nodes/${article}`, "DELETE")).status).toBe(200);
    expect(await pending()).toBe("0");
    expect((await send(`/api/nodes/${articleOn}`, "DELETE")).status).toBe(200);
    expect(await pending()).toBe("1");
  });
});
