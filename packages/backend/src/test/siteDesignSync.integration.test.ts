// D119: the site settings and the Studio's design (chrome) follow the sync,
// and an old tab can neither save nor publish its stale copy over a newer one.
//   * a SITE_CONFIG_UPDATED in the delta window re-ships site_config and
//     chrome, each reader's view as the bootstrap ships it (the owner's
//     tokens only to the owner);
//   * a chrome save names the revision it started from; a stale one is
//     refused with 409 design_stale;
//   * a publish takes the design from the saved draft, not from the body the
//     tab sends.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import workspaceRouter from "../routes/workspace.js";
import publishRouter from "../modules/website/routes.js";
import { buildSyncDelta } from "../services/sync/index.js";
import { buildBootstrap } from "../services/sync/bootstrap.js";
import { getChromeBlocks } from "../services/siteConfig.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let currentActor: ActorCtx | null = null;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/workspace", workspaceRouter);
app.route("/api", publishRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let owner: ActorCtx = { id: "d119-owner", name: "Owner", role: "admin", type: "human" };
let member: ActorCtx = { id: "d119-member", name: "Member", role: "editor", type: "human" };

type Chrome = { blocks?: Array<{ type: string; props: { title: string } }>; studio_draft?: boolean; rev?: string } | null;
const header = (title: string) => [{ type: "hero", props: { title } }];
const cursor = async () => Number((await q<{ m: string }>(
  `SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events WHERE workspace_id = $1`, [workspaceId])).rows[0]!.m);
const storedChrome = async () => await getChromeBlocks(workspaceId) as Chrome;

describe.skipIf(!isTestDb)("site design follows the sync and refuses stale tabs (D119)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('D119',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(workspaceId, owner);
    member = await persistActor(workspaceId, member);
    currentActor = owner;
    // A page to publish, in a space that may publish.
    const space = await makeSpace(workspaceId, `pub-${randomUUID()}`, [{ id: owner.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Home',$2,'body') RETURNING id::text`, [workspaceId, `home-${randomUUID().slice(0, 8)}`])).rows[0]!.id;
    await putInSpace(id, space);
    expect((await send(`/api/nodes/${id}/attributes/_published`, "PUT", { value: "true", value_type: "bool" })).status).toBe(200);
  });

  it("the delta re-ships site_config and chrome after a change, each reader's view", async () => {
    // A config note exists before the window (the bootstrap creates it).
    await buildBootstrap(owner, workspaceId, { slimBodies: true, metaOnly: true });
    const since = await cursor();
    const quiet = await buildSyncDelta(owner, workspaceId, { since, known: [] });
    expect(quiet.site_config).toBeUndefined();
    expect(quiet.chrome).toBeUndefined();

    currentActor = owner;
    expect((await send("/api/workspace/config", "PATCH", { config: { brand: "Synced brand" }, chrome: { blocks: header("Synced header"), studio_draft: true } })).status).toBe(200);

    const ownerDelta = await buildSyncDelta(owner, workspaceId, { since, known: [] });
    expect((ownerDelta.site_config as { brand?: string }).brand).toBe("Synced brand");
    expect((ownerDelta.chrome as Chrome)?.blocks?.[0]?.props.title).toBe("Synced header");
    // The same view the bootstrap gives each reader.
    const ownerBoot = await buildBootstrap(owner, workspaceId, { slimBodies: true, metaOnly: true });
    expect(ownerDelta.site_config).toEqual(ownerBoot.site_config);
    expect(ownerDelta.chrome).toEqual(ownerBoot.chrome);

    const memberDelta = await buildSyncDelta(member, workspaceId, { since, known: [] });
    expect((memberDelta.site_config as { brand?: string }).brand).toBe("Synced brand");
    const memberBoot = await buildBootstrap(member, workspaceId, { slimBodies: true, metaOnly: true });
    expect(memberDelta.site_config).toEqual(memberBoot.site_config);
    expect(memberDelta.chrome).toEqual(memberBoot.chrome);
  });

  it("a chrome save from a stale base is refused with 409; a current one, or the same save again, is not", async () => {
    currentActor = owner;
    // A stored design to start from, whether or not another test saved one.
    if (!(await storedChrome())) {
      expect((await send("/api/workspace/config", "PATCH", { chrome: { blocks: header("Start header"), studio_draft: true } })).status).toBe(200);
    }
    const start = (await storedChrome())?.rev ?? null;
    expect(start).toEqual(expect.any(String)); // every stored chrome has a revision

    // Tab A saves a new header from the current revision.
    const revA = randomUUID();
    const saveA = { chrome: { blocks: header("A header"), studio_draft: true, rev: revA }, chrome_base: start };
    expect((await send("/api/workspace/config", "PATCH", saveA)).status).toBe(200);
    expect((await storedChrome())?.rev).toBe(revA);
    // The same request again (a retry whose reply was lost) is not stale.
    expect((await send("/api/workspace/config", "PATCH", saveA)).status).toBe(200);

    // Tab B still holds `start`: refused, and A's header stays.
    const stale = await send("/api/workspace/config", "PATCH", {
      chrome: { blocks: header("B old header"), studio_draft: true, rev: randomUUID() }, chrome_base: start,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe("design_stale");
    expect((await storedChrome())?.blocks?.[0]?.props.title).toBe("A header");

    // After reloading (base = A's revision) B saves.
    const revB = randomUUID();
    expect((await send("/api/workspace/config", "PATCH", {
      chrome: { blocks: header("B header"), studio_draft: true, rev: revB }, chrome_base: revA,
    })).status).toBe(200);
    expect((await storedChrome())?.rev).toBe(revB);

    // An unguarded write (no base: an older client) still saves, and copying
    // the stored revision does not keep it: tabs holding it become stale.
    expect((await send("/api/workspace/config", "PATCH", {
      chrome: { blocks: header("Old client"), studio_draft: true, rev: revB },
    })).status).toBe(200);
    const after = (await storedChrome())?.rev;
    expect(after).toEqual(expect.any(String));
    expect(after).not.toBe(revB);
    expect((await send("/api/workspace/config", "PATCH", {
      chrome: { blocks: header("B again"), studio_draft: true, rev: randomUUID() }, chrome_base: revB,
    })).status).toBe(409);
  });

  it("a publish from a stale tab sends its old design, but the saved design goes out", async () => {
    currentActor = owner;
    const base = (await storedChrome())?.rev ?? null;
    expect((await send("/api/workspace/config", "PATCH", {
      chrome: { v: 2, css: ".newest { color: red }", studio_draft: true, rev: randomUUID() }, chrome_base: base,
    })).status).toBe(200);

    // The stale tab's body carries the design it loaded before (ignored: the
    // design is never read from the request).
    const body = { title: "Site", presentation: { design: { v: 2, css: ".stale { color: blue }" }, blocks: header("Stale tab header") } };
    const preview = await send("/api/publish/preview", "POST", body);
    expect(preview.status).toBe(200);
    const { hash } = (await preview.json()) as { hash: string };
    expect((await send("/api/publish", "POST", { ...body, preview_hash: hash })).status).toBe(201);
    const published = (await q<{ css: string | null; blocks: unknown }>(
      `SELECT payload->'presentation'->'design'->>'css' AS css, payload->'presentation'->'blocks' AS blocks FROM publish_snapshots
        WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [workspaceId])).rows[0]!;
    expect(published.css).toBe(".newest { color: red }");
    expect(published.blocks).toBeNull(); // the old Studio's fields are not in a new snapshot
  });
});
